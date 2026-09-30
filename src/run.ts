import { BuildIdProbeError, buildIdUrlFor, probeBuildId } from "./build-id.ts";
import type { CloudflareApi, Deployment } from "./cloudflare.ts";
import { type KeptBuild, makePlan, type PrunePlan } from "./plan.ts";
import type { OnRetry } from "./retry.ts";
import type { R2Store } from "./store.ts";

/**
 * 把「探测 → 列举 → 判定」串起来。与 cli.ts 分开是为了这一层不依赖任何 Node API：
 * 将来要把定时任务搬进 Cloudflare Cron Worker，直接复用这个函数即可。
 */

export interface RunOptions {
  store: R2Store;
  prefix: string;
  /** 站点地址；给了就从 <站点>/BUILD_ID 探测当前线上 build */
  siteUrl?: string;
  /** 覆盖探测地址，优先于 siteUrl */
  buildIdUrl?: string;
  /** 从 Cloudflare API 找出近期线上版本与全部预览，逐个读它们的 BUILD_ID */
  cloudflare?: CloudflareSource;
  /** 显式保留的 build id */
  keep?: string[];
  force?: boolean;
  /** 承认「前缀为空、缓存直接放在 bucket 根下」这种布局 */
  allowRootPrefix?: boolean;
  /** 规则的过期天数，默认 1 */
  expireDays?: number;
  /** 规则里 Prefix 的包装形式，默认 filter */
  style?: "filter" | "bare";
  fetchImpl?: typeof fetch;
  /** 读 BUILD_ID 重试时的回调 */
  onRetry?: OnRetry;
  /** 并发探测预览时的并发数 */
  concurrency?: number;
}

export interface CloudflareSource {
  api: CloudflareApi;
  worker: string;
  /** 保留最近几个互不相同的线上 BUILD_ID，默认 3 */
  recentBuilds?: number;
}

export interface RunState {
  /**
   * --url / --build-id-url 探测到的线上 build，与 probedFrom 成对。此刻承载线上流量的全部
   * build（再加上最新 deployment 里的，灰度时不止一个）是 plan.keep 里 reason 为 online 的那些。
   */
  onlineBuildId: string | null;
  probedFrom: string | null;
  /**
   * 走了 Cloudflare API 时的概要：翻看了几条 deployment、凑到几个不同的近期线上 build
   * （含线上当前的；少于 --recent-builds 说明全部 deployment 已经翻完了）、有几个预览
   */
  cloudflare: { deploymentsScanned: number; recentBuilds: number; previews: number } | null;
  plan: PrunePlan;
}

export async function collectPlan(opts: RunOptions): Promise<RunState> {
  // 先看 bucket 再探测：探测可能要几十秒（上百个地址、重试退避），这期间新上传或上线的
  // build 若出现在后列出的目录里，却不在更早探测出的保留集中，就会被挂上删除规则。
  // 先列目录，中途冒出的 build 根本不在 existing 里，碰不到；它若恰是线上 build，
  // 还会因为「要保留的 build 不在 bucket 里」安全地报错。
  const [existing, current] = await Promise.all([
    opts.store.listBuildIds(opts.prefix),
    opts.store.getLifecycle(),
  ]);

  const fetchImpl = opts.fetchImpl ?? fetch;
  const probe: Probe = (url, signal) => probeBuildId(url, fetchImpl, opts.onRetry, signal);
  const probeUrl = opts.buildIdUrl ?? (opts.siteUrl ? buildIdUrlFor(opts.siteUrl) : undefined);

  // 读站点、近期线上、预览三条线互不依赖，并发走；一处失败就中止其余各条和全部在途请求，
  // 否则整趟已经失败，还在按 Retry-After 退避重试的请求会把进程拖住
  const controller = new AbortController();
  const { signal } = controller;
  const abortOnFailure = <T>(promise: Promise<T>) =>
    promise.catch((error: unknown) => {
      controller.abort();
      throw error;
    });
  const source = opts.cloudflare;
  const concurrency = opts.concurrency ?? 8;
  const [onlineBuildId, recent, previews] = await Promise.all([
    probeUrl ? abortOnFailure(explainProbe(SITE_HINT, () => probe(probeUrl, signal))) : null,
    source ? abortOnFailure(collectRecentKeeps(source, probe, concurrency, signal)) : null,
    source ? abortOnFailure(collectPreviewKeeps(source, probe, concurrency, signal)) : null,
  ]);

  const keeps: KeptBuild[] = [
    ...(onlineBuildId ? [{ buildId: onlineBuildId, reason: "online" as const }] : []),
    ...(recent?.keeps ?? []),
    ...(previews ?? []),
    ...(opts.keep ?? []).map((buildId) => ({ buildId, reason: "explicit" as const })),
  ];

  return {
    onlineBuildId,
    probedFrom: probeUrl ?? null,
    cloudflare:
      recent && previews
        ? { deploymentsScanned: recent.scanned, recentBuilds: recent.distinct, previews: previews.length }
        : null,
    plan: makePlan({
      existing,
      keep: keeps,
      current,
      prefix: opts.prefix,
      expireDays: opts.expireDays ?? 1,
      style: opts.style ?? "filter",
      force: opts.force,
      allowRootPrefix: opts.allowRootPrefix,
    }),
  };
}

type Probe = (url: string, signal?: AbortSignal) => Promise<string>;

/**
 * 近期线上：从最新的 deployment 往回翻，凑够 recentBuilds 个互不相同的 BUILD_ID 就停。
 * 只改 secret / vars 也会产生新 version 和 deployment，但 BUILD_ID 不变，这类不占名额。
 * 最新那条 deployment 里的全部 version（灰度时是两个）都算线上。
 *
 * 任何一个读不到都整体失败 —— 读不到就无从判断它的缓存该不该留，宁可不跑也不误删。
 */
async function collectRecentKeeps(
  source: CloudflareSource,
  probe: Probe,
  concurrency: number,
  signal: AbortSignal,
): Promise<{ keeps: KeptBuild[]; scanned: number; distinct: number }> {
  const { api, worker } = source;
  // 小于 1 时窗口大小为 0，下面的循环永远走不动
  const wanted = Math.max(1, source.recentBuilds ?? 3);
  const keeps: KeptBuild[] = [];

  // deployment 按需翻页：当前已取到的都用完了、还要往后看时才取下一页
  const pages = api.listDeployments(worker, signal);
  const deployments: Deployment[] = [];
  let exhausted = false;
  const has = async (index: number) => {
    while (index >= deployments.length && !exhausted) {
      const next = await pages.next();
      if (next.done) exhausted = true;
      else deployments.push(...next.value);
    }
    return index < deployments.length;
  };

  if (!(await has(0))) {
    throw new BuildIdProbeError(`Worker ${worker} 没有任何 deployment，请确认 --worker 填对了。`);
  }

  // 按窗口往回翻：每个窗口里的 version 并发探测。每个没探过的 version 至多贡献一个新 build，
  // 所以窗口按「还差几个」收进同样多个没探过的 version（灰度的 deployment 一条就占两个），
  // 凑够名额时窗口里不会有多探的 —— 多探一个就多一个读不到而中止整趟的机会。
  // 窗口至少收一条 deployment，否则走不动；没有只改配置的部署时一轮就够。
  // 已经收够时不为了看下一条而去翻页
  const byVersion = new Map<string, string>();
  const distinct = new Set<string>();
  let scanned = 0;
  const enough = (index: number) => index > 0 && distinct.size >= wanted;
  for (let start = 0; !enough(start) && (await has(start)); ) {
    const need = wanted - distinct.size;
    const pending = new Set<string>();
    let end = start;
    for (; (end === start || pending.size < need) && (await has(end)); end++) {
      const fresh = deployments[end]!.versionIds.filter((id) => !byVersion.has(id) && !pending.has(id));
      if (end > start && pending.size + fresh.length > need) break;
      for (const id of fresh) pending.add(id);
    }
    const window = deployments.slice(start, end);
    const versionIds = [...pending];
    const buildIds = await mapWithConcurrency(versionIds, concurrency, signal, (versionId) =>
      probeVersion(api, worker, versionId, probe, signal),
    );
    versionIds.forEach((versionId, i) => byVersion.set(versionId, buildIds[i]!));

    for (const [offset, deployment] of window.entries()) {
      const index = start + offset;
      if (enough(index)) break;
      scanned++;
      for (const versionId of deployment.versionIds) {
        const buildId = byVersion.get(versionId)!;
        distinct.add(buildId);
        keeps.push({
          buildId,
          reason: index === 0 ? "online" : "recent",
          source: `version ${versionId.slice(0, 8)}`,
        });
      }
    }
    start += window.length;
  }
  return { keeps, scanned, distinct: distinct.size };
}

/** 预览：每个 Preview 的 URL 永远指向它最新的 deployment，读一次就是它当前的 BUILD_ID。 */
async function collectPreviewKeeps(
  source: CloudflareSource,
  probe: Probe,
  concurrency: number,
  signal: AbortSignal,
): Promise<KeptBuild[]> {
  const previews = await source.api.listPreviews(source.worker, signal);
  return mapWithConcurrency(previews, concurrency, signal, async (preview) => {
    const url = preview.urls[0];
    if (!url) {
      throw new BuildIdProbeError(
        `预览 ${preview.name} 没有可访问的 URL，读不到它的 BUILD_ID。请确认 Worker 开启了 workers.dev 与预览 URL。`,
      );
    }
    const buildId = await explainProbe(
      WORKER_HINT,
      () => probe(buildIdUrlFor(url), signal),
      `预览 ${preview.name}`,
    );
    return { buildId, reason: "preview" as const, source: preview.name };
  });
}

async function probeVersion(
  api: CloudflareApi,
  worker: string,
  versionId: string,
  probe: Probe,
  signal: AbortSignal,
): Promise<string> {
  const label = `版本 ${versionId.slice(0, 8)}`;
  const url = (await api.getVersionUrls(worker, versionId, signal))[0];
  if (!url) {
    throw new BuildIdProbeError(
      `${label} 没有可访问的 URL，读不到它的 BUILD_ID。请确认 Worker 开启了 workers.dev 与 preview_urls。\n` +
        `注意：实现了 Durable Object 的 Worker（例如用了 OpenNext 的 DO 队列或 DO tag cache）` +
        `不会生成版本预览 URL，开了也没用 —— 这种情况请改用 --url 与 --keep。`,
    );
  }
  return explainProbe(WORKER_HINT, () => probe(buildIdUrlFor(url), signal), label);
}

const SITE_HINT = "请改用 --keep 显式指定要保留的 build id。";

/**
 * 读 Worker 版本或预览失败时，--keep 帮不上忙：失败的那个 build 仍然读不到，整趟照样中止。
 * 能做的是让地址可读，或者整个退回 --url 模式。
 */
const WORKER_HINT =
  "请确认该地址能公开访问（workers.dev 已开启、未被 Cloudflare Access 挡住）；" +
  "做不到时请去掉 --worker，改用 --url 与 --keep。";

/**
 * probeBuildId 只说哪里不对，这里按模式补上怎么办；读版本 / 预览时再补上是哪一个，
 * 否则一长串 workers.dev 地址很难对上号。
 */
async function explainProbe<T>(hint: string, fn: () => Promise<T>, label?: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof BuildIdProbeError) {
      // 暂时性失败的报错里已经说了「稍后重跑」，再建议改配置只会把人带偏
      const suffix = error.transient ? "" : `\n${hint}`;
      throw new BuildIdProbeError(`${label ? `${label}：` : ""}${error.message}${suffix}`, error.transient);
    }
    throw error;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  // 任何一项失败整体就已失败，其余 worker 不再领新任务，免得把剩下的请求白白发完；
  // 别的线失败（signal 中止）时同理
  let failed = false;
  // limit 小于 1 时一个 worker 都起不来，结果里会全是空洞
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (!failed && !signal.aborted && cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await fn(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  // 被中止时 worker 是悄悄退出的，results 里留着空洞，不能当成功交回去
  signal.throwIfAborted();
  return results;
}
