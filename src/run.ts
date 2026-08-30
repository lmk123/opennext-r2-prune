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
  /** 承认「前缀为空、缓存直接放在 bucket 根下」这种布局 */
  allowRootPrefix?: boolean;
  /** 规则的过期天数，默认 1 */
  expireDays?: number;
  /** 规则里 Prefix 的包装形式，默认 filter */
  style?: "filter" | "bare";
  fetchImpl?: typeof fetch;
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
  const current = await opts.store.getLifecycle();

  return {
    onlineBuildId,
    probedFrom: probeUrl ?? null,
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
