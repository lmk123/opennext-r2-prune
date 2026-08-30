import { buildIdUrlFor, probeBuildId } from "./build-id.ts";
import { type KeepReason, makePlan, type PrunePlan } from "./plan.ts";
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
  /** 显式保留的 build id */
  keep?: string[];
  force?: boolean;
  /** 规则的过期天数，默认 1 */
  expireDays?: number;
  /** 规则里 Prefix 的包装形式，默认 filter */
  style?: "filter" | "bare";
  fetchImpl?: typeof fetch;
  /** 探测近似部署时间时的并发数 */
  concurrency?: number;
  /** 非致命问题的提示出口 */
  onWarn?: (message: string) => void;
}

export interface RunState {
  onlineBuildId: string | null;
  probedFrom: string | null;
  plan: PrunePlan;
}

export async function collectPlan(opts: RunOptions): Promise<RunState> {
  const keeps: { buildId: string; reason: KeepReason }[] = [];

  const probeUrl = opts.buildIdUrl ?? (opts.siteUrl ? buildIdUrlFor(opts.siteUrl) : undefined);
  let onlineBuildId: string | null = null;
  if (probeUrl) {
    onlineBuildId = await probeBuildId(probeUrl, opts.fetchImpl ?? fetch);
    keeps.push({ buildId: onlineBuildId, reason: "online" });
  }
  for (const buildId of opts.keep ?? []) {
    keeps.push({ buildId, reason: "explicit" });
  }

  const existing = await opts.store.listBuildIds(opts.prefix);
  const lastModified = new Map<string, Date | null>();
  await mapWithConcurrency(existing, opts.concurrency ?? 8, async (buildId) => {
    try {
      lastModified.set(buildId, await opts.store.probeBuild(opts.prefix, buildId));
    } catch (error) {
      // 近似时间纯粹用于展示，取不到就留空 —— 不值得让整次清理失败
      opts.onWarn?.(`读取 ${buildId} 的部署时间失败，本次不展示该时间：${String(error)}`);
    }
  });

  const current = await opts.store.getLifecycle();

  return {
    onlineBuildId,
    probedFrom: probeUrl ?? null,
    plan: makePlan({
      existing,
      lastModified,
      keep: keeps,
      current,
      prefix: opts.prefix,
      expireDays: opts.expireDays ?? 1,
      style: opts.style ?? "filter",
      force: opts.force,
    }),
  };
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
