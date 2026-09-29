import { BuildIdProbeError, buildIdUrlFor, probeBuildId } from "./build-id.ts";
import type { CloudflareApi } from "./cloudflare.ts";
import { type KeptBuild, makePlan, type PrunePlan } from "./plan.ts";
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
  /** --url / --build-id-url 探测到的线上 build，与 probedFrom 成对 */
  onlineBuildId: string | null;
  /** 此刻承载线上流量的全部 build：--url 探测到的加上最新 deployment 里的（灰度时不止一个） */
  onlineBuildIds: string[];
  probedFrom: string | null;
  /** 走了 Cloudflare API 时的概要：翻看了几条 deployment、有几个预览 */
  cloudflare: { deploymentsScanned: number; previews: number } | null;
  plan: PrunePlan;
}

export async function collectPlan(opts: RunOptions): Promise<RunState> {
  const keeps: KeptBuild[] = [];
  const fetchImpl = opts.fetchImpl ?? fetch;

  const probeUrl = opts.buildIdUrl ?? (opts.siteUrl ? buildIdUrlFor(opts.siteUrl) : undefined);
  let onlineBuildId: string | null = null;
  if (probeUrl) {
    onlineBuildId = await probeBuildId(probeUrl, fetchImpl);
    keeps.push({ buildId: onlineBuildId, reason: "online" });
  }

  let cloudflare: RunState["cloudflare"] = null;
  if (opts.cloudflare) {
    const found = await collectCloudflareKeeps(opts.cloudflare, fetchImpl, opts.concurrency ?? 8);
    keeps.push(...found.keeps);
    cloudflare = { deploymentsScanned: found.deploymentsScanned, previews: found.previews };
  }

  for (const buildId of opts.keep ?? []) {
    keeps.push({ buildId, reason: "explicit" });
  }

  const existing = await opts.store.listBuildIds(opts.prefix);
  const current = await opts.store.getLifecycle();

  return {
    onlineBuildId,
    onlineBuildIds: [...new Set(keeps.filter((b) => b.reason === "online").map((b) => b.buildId))],
    probedFrom: probeUrl ?? null,
    cloudflare,
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

/**
 * 近期线上：从最新的 deployment 往回翻，凑够 recentBuilds 个互不相同的 BUILD_ID 就停。
 * 只改 secret / vars 也会产生新 version 和 deployment，但 BUILD_ID 不变，这类不占名额。
 * 最新那条 deployment 里的全部 version（灰度时是两个）都算线上。
 *
 * 预览：每个 Preview 的 URL 永远指向它最新的 deployment，读一次就是它当前的 BUILD_ID。
 *
 * 任何一个读不到都整体失败 —— 读不到就无从判断它的缓存该不该留，宁可不跑也不误删。
 */
async function collectCloudflareKeeps(
  source: CloudflareSource,
  fetchImpl: typeof fetch,
  concurrency: number,
): Promise<{ keeps: KeptBuild[]; deploymentsScanned: number; previews: number }> {
  const { api, worker } = source;
  // 小于 1 时窗口大小为 0，下面的循环永远走不动
  const wanted = Math.max(1, source.recentBuilds ?? 3);
  const keeps: KeptBuild[] = [];

  const deployments = await api.listDeployments(worker);
  if (deployments.length === 0) {
    throw new BuildIdProbeError(`Worker ${worker} 没有任何 deployment，请确认 --worker 填对了。`);
  }

  // 按窗口往回翻：每个窗口里的 version 并发探测。窗口大小取「还差几个」—— 每条 deployment
  // 至多贡献一个新 build（灰度除外），所以窗口里的都是凑数可能要用到的，不会为了凑数把
  // 全部历史 version 都探一遍；没有只改配置的部署时一轮就够
  const byVersion = new Map<string, string>();
  const distinct = new Set<string>();
  let scanned = 0;
  const enough = (index: number) => index > 0 && distinct.size >= wanted;
  for (let start = 0; start < deployments.length && !enough(start); ) {
    const window = deployments.slice(start, start + Math.max(1, wanted - distinct.size));
    const pending = [...new Set(window.flatMap((d) => d.versionIds))].filter((id) => !byVersion.has(id));
    const buildIds = await mapWithConcurrency(pending, concurrency, (versionId) =>
      probeVersion(api, worker, versionId, fetchImpl),
    );
    pending.forEach((versionId, i) => byVersion.set(versionId, buildIds[i]!));

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

  const previews = await api.listPreviews(worker);
  const previewKeeps = await mapWithConcurrency(previews, concurrency, async (preview) => {
    const url = preview.urls[0];
    if (!url) {
      throw new BuildIdProbeError(
        `预览 ${preview.name} 没有可访问的 URL，读不到它的 BUILD_ID。请确认 Worker 开启了 workers.dev 与预览 URL。`,
      );
    }
    const buildId = await withContext(`预览 ${preview.name}`, () =>
      probeBuildId(buildIdUrlFor(url), fetchImpl),
    );
    return { buildId, reason: "preview" as const, source: preview.name };
  });
  keeps.push(...previewKeeps);

  return { keeps, deploymentsScanned: scanned, previews: previews.length };
}

async function probeVersion(
  api: CloudflareApi,
  worker: string,
  versionId: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const label = `版本 ${versionId.slice(0, 8)}`;
  const url = (await api.getVersionUrls(worker, versionId))[0];
  if (!url) {
    throw new BuildIdProbeError(
      `${label} 没有可访问的 URL，读不到它的 BUILD_ID。请确认 Worker 开启了 workers.dev 与 preview_urls。\n` +
        `注意：实现了 Durable Object 的 Worker（例如用了 OpenNext 的 DO 队列或 DO tag cache）` +
        `不会生成版本预览 URL，开了也没用 —— 这种情况请改用 --url 与 --keep。`,
    );
  }
  return withContext(label, () => probeBuildId(buildIdUrlFor(url), fetchImpl));
}

/** 探测失败时补上是哪个版本 / 预览，否则一长串 workers.dev 地址很难对上号 */
async function withContext<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof BuildIdProbeError) {
      throw new BuildIdProbeError(`${label}：${error.message}`);
    }
    throw error;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  // limit 小于 1 时一个 worker 都起不来，结果里会全是空洞
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
