import { BuildIdProbeError, buildIdUrlFor, probeBuildId } from "./build-id.ts";
import type { CloudflareApi, Deployment } from "./cloudflare.ts";
import { type KeptBuild, makePlan, type PrunePlan, type VerifyProblems, verifyWritten, wholeBucketRules } from "./plan.ts";
import type { OnRetry } from "./retry.ts";
import type { R2Store } from "./store.ts";
import type { LifecycleDoc } from "./xml.ts";

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
  fetchImpl?: typeof fetch;
  /** 读 BUILD_ID 重试时的回调 */
  onRetry?: OnRetry;
  /** 并发探测预览时的并发数 */
  concurrency?: number;
  /**
   * 读到现有配置里有对整个 bucket 生效的自有规则时立即回调（在探测之前）。探测或校验失败
   * 时整趟会中止，调用方拿不到 RunState，靠这个回调才能在中止前把危险规则报出来。
   */
  onWholeBucketRules?: (buildIds: string[]) => void;
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
  /** 现有配置里启用中、前缀为空（对整个 bucket 生效）的自有规则的 buildId */
  wholeBucketRules: string[];
  plan: PrunePlan;
}

export async function collectPlan(opts: RunOptions): Promise<RunState> {
  // 先看 bucket 再探测：探测可能要几十秒（上百个地址、重试退避），这期间新上传或上线的
  // build 若出现在后列出的目录里，却不在更早探测出的保留集中，就会被挂上删除规则。
  // 先列目录，中途冒出的 build 根本不在 existing 里，碰不到；它若恰是线上 build，
  // 还会因为「要保留的 build 不在 bucket 里」安全地报错。
  // 用 allSettled 等两边都落地：列目录失败时整趟也要中止，但读到的危险规则必须先报出来
  const [listed, read] = await Promise.allSettled([
    opts.store.listBuildIds(opts.prefix),
    opts.store.getLifecycle(),
  ]);
  const dangerous = read.status === "fulfilled" ? wholeBucketRules(read.value) : [];
  if (dangerous.length > 0) opts.onWholeBucketRules?.(dangerous);
  if (listed.status === "rejected") throw listed.reason;
  if (read.status === "rejected") throw read.reason;
  const existing = listed.value;
  const current = read.value;

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
    wholeBucketRules: dangerous,
    plan: makePlan({
      existing,
      keep: keeps,
      current,
      prefix: opts.prefix,
      expireDays: opts.expireDays ?? 1,
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

export interface WriteResult {
  /** 本工具规则回读后与期望不符的地方，空数组表示本工具的规则已按原样生效（或无从核对） */
  problems: string[];
  /**
   * 外部规则条数不符这类不影响本工具规则安全的问题，只提示、不触发撤销。撤销后回读发现的
   * 外部规则不符同样记在这里（以「撤销后」开头），它可能意味着用户的规则丢了。
   */
  warnings: string[];
  /** 写入成功、但回读失败时的原因。此时无从核对，按「不符」处理并撤销 */
  readBackError?: unknown;
  /**
   * PUT 本身报了错（超时、重试耗尽的 5xx……），但请求可能已在服务端生效，所以仍回读核对：
   * 与期望一致就当作已写入（problems 为空）；读到对整个 bucket 生效的自有规则就撤销。
   * 其余情况（多半是没写进去）直接把这个错误抛给调用方，不会出现在返回值里。
   */
  writeError?: unknown;
  /**
   * 是否撤掉了本工具的全部规则。撤规则只会让删除推迟，绝不会删到数据，所以核对不过（或无从核对）
   * 就先撤，等查明原因再重跑。null = 无需撤销；true = 已撤销并回读确认；false = 撤销失败或无法确认。
   */
  rolledBack: boolean | null;
  /** 撤销失败或无法确认的原因 */
  rollbackError?: unknown;
}

export interface VerifyOptions {
  /** 回读与期望不符时最多读几次（含第一次），默认 3。应对写入后短时间内还读到旧配置 */
  readBackAttempts?: number;
  /** 两次回读之间等多久，默认 2000 毫秒 */
  readBackDelayMs?: number;
  /** 测试注入用 */
  sleep?: (ms: number) => Promise<void>;
}

type ReadBack = { problems: VerifyProblems; actual: LifecycleDoc } | { error: unknown };

/**
 * 读回配置并核对，本工具的规则不符时隔一会儿再读，直到一致或次数用完。读取本身失败就立即返回
 * （withRetry 已重试过）。
 *
 * 只按本工具的规则决定要不要重读：每次写入的外部规则都是写入前原样读到的那份，本工具的规则
 * 一致就说明读到的已是新配置，此时外部规则仍不符就是服务端的改写，重读也不会变，多读一次反而
 * 多一次读失败、把已核对通过的结果当成「无从核对」去撤销的机会。
 */
async function readBack(store: R2Store, expected: LifecycleDoc, opts: VerifyOptions): Promise<ReadBack> {
  const attempts = Math.max(1, opts.readBackAttempts ?? 3);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result: ReadBack = { error: new Error("没有读取") };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(opts.readBackDelayMs ?? 2000);
    let actual: LifecycleDoc;
    try {
      actual = await store.getLifecycle();
    } catch (error) {
      return { error };
    }
    result = { problems: verifyWritten(expected, actual), actual };
    if (result.problems.own.length === 0) break;
  }
  return result;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 写入规则，再读回来逐条核对。本工具的规则对不上、或根本读不回来时，立即重写一份只含外部规则的
 * 配置把本工具的规则全部撤掉 —— 一条前缀被服务端丢掉的删除规则会作用于整个 bucket，不能让它
 * 留在那里等人发现。撤销同样要读回来确认，否则「已撤销」只是一句没有根据的保证。
 */
export async function writeAndVerify(
  store: R2Store,
  doc: LifecycleDoc,
  opts: VerifyOptions = {},
): Promise<WriteResult> {
  let writeError: unknown;
  try {
    await store.putLifecycle(doc);
  } catch (error) {
    writeError = error;
  }
  const check = await readBack(store, doc, opts);

  if (writeError !== undefined) {
    // 写入报错不等于没写进去（比如响应在路上丢了）。回读与期望一致就是已生效；读到对整个 bucket
    // 生效的自有规则（不论是这次写坏的还是原本就有的）必须撤；其余多半是旧配置原封未动，照常报写入失败
    if ("error" in check) throw writeError;
    if (check.problems.own.length === 0) {
      return { problems: [], warnings: check.problems.foreign, rolledBack: null, writeError };
    }
    if (wholeBucketRules(check.actual).length === 0) throw writeError;
  } else if ("problems" in check && check.problems.own.length === 0) {
    return { problems: [], warnings: check.problems.foreign, rolledBack: null };
  }

  const writeNote = writeError === undefined ? [] : [`写入请求报错：${message(writeError)}`];
  const base =
    "error" in check
      ? { problems: [], warnings: [], readBackError: check.error }
      : {
          problems: [...writeNote, ...check.problems.own],
          warnings: check.problems.foreign,
          ...(writeError === undefined ? {} : { writeError }),
        };

  // 外部规则用写入前读到、本次原样搬运的那份，而不是回读到的：被服务端改掉 ID 的自有规则会被
  // 认成外部规则，照着回读结果写回去就等于把它留下了；回读残缺时还会把用户的规则一并弄丢。
  const rollbackDoc: LifecycleDoc = { own: [], foreign: doc.foreign };
  try {
    await store.putLifecycle(rollbackDoc);
  } catch (rollbackError) {
    return { ...base, rolledBack: false, rollbackError };
  }
  const after = await readBack(store, rollbackDoc, opts);
  if ("error" in after) {
    return {
      ...base,
      rolledBack: false,
      rollbackError: new Error(`撤销已写入，但回读确认失败：${message(after.error)}`),
    };
  }
  // 撤销后外部规则不符同样要报：可能是用户的规则丢了，也可能是被改掉 ID 的自有规则还在
  const warnings = [...base.warnings, ...after.problems.foreign.map((warning) => `撤销后${warning}`)];
  if (after.problems.own.length > 0) {
    return {
      ...base,
      warnings,
      rolledBack: false,
      rollbackError: new Error(`撤销后读回来仍有本工具的规则：${after.problems.own.join("；")}`),
    };
  }
  return { ...base, warnings, rolledBack: true };
}
