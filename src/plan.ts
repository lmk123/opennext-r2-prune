import type { LifecycleDoc, OwnRule } from "./xml.ts";

/**
 * 判定哪些 build 该留、哪些该交给 R2 删，以及最终要写回的规则集。
 * 这里不发任何请求，全部安全校验都在此完成 —— 校验不过就抛错，调用方不会走到写入。
 */

/** R2 的 lifecycle 规则总数上限 */
export const MAX_RULES = 1000;

export type KeepReason = "online" | "explicit";
export type ReclaimReason = "emptied" | "revived";

export interface KeptBuild {
  buildId: string;
  lastModified: Date | null;
  reason: KeepReason;
}

export interface ExpiringBuild {
  buildId: string;
  lastModified: Date | null;
  /** false 表示上次运行已经加过规则，R2 还在删 */
  isNew: boolean;
}

export interface ReclaimedRule {
  buildId: string;
  reason: ReclaimReason;
}

export interface PrunePlan {
  keep: KeptBuild[];
  expire: ExpiringBuild[];
  reclaim: ReclaimedRule[];
  nextDoc: LifecycleDoc;
  /** 与现状一致时为 false，此时无需发 PUT */
  changed: boolean;
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

export interface PlanInput {
  /** bucket 里当前还有对象的 build 目录 */
  existing: string[];
  /** 各 build 的近似部署时间，仅用于展示 */
  lastModified: Map<string, Date | null>;
  /** 要保留的 build 及其原因 */
  keep: { buildId: string; reason: KeepReason }[];
  current: LifecycleDoc;
  prefix: string;
  /** 跳过「保留集必须存在于 bucket」这条校验 */
  force?: boolean;
}

export function makePlan(input: PlanInput): PrunePlan {
  const { existing, current, prefix } = input;
  const existingSet = new Set(existing);

  // 同一个 buildId 可能既被探测到又被 --keep 传入，线上探测的原因优先展示
  const keepMap = new Map<string, KeepReason>();
  for (const { buildId, reason } of input.keep) {
    if (reason === "online" || !keepMap.has(buildId)) keepMap.set(buildId, reason);
  }

  if (keepMap.size === 0) {
    throw new PlanError("保留集为空，拒绝继续 —— 那会把所有 build 缓存都标记为删除。");
  }

  const missing = [...keepMap.keys()].filter((id) => !existingSet.has(id));
  if (missing.length > 0 && !input.force) {
    throw new PlanError(
      `要保留的 build 在 bucket 里不存在：${missing.join(", ")}。\n` +
        `通常意味着 bucket、--prefix 或站点域名有一个填错了。确认无误可加 --force 跳过这项检查。`,
    );
  }

  const expireIds = existing.filter((id) => !keepMap.has(id));
  if (expireIds.length > 0 && expireIds.length === existing.length) {
    throw new PlanError(
      "保留集与 bucket 里现存的 build 没有交集，拒绝把全部 build 缓存标记为删除。",
    );
  }

  const ruledIds = new Set(current.own.map((rule) => rule.buildId));

  // 已经空掉的目录说明 R2 删完了，规则可以回收；重新上线的 build 必须立刻摘掉规则，
  // 否则它新写入的缓存会被这条残留规则继续删（Next.js 16.2+ 的确定性 build id 会撞上）
  const reclaim: ReclaimedRule[] = current.own
    .filter((rule) => !existingSet.has(rule.buildId) || keepMap.has(rule.buildId))
    .map((rule) => ({
      buildId: rule.buildId,
      reason: keepMap.has(rule.buildId) ? ("revived" as const) : ("emptied" as const),
    }));
  const reclaimSet = new Set(reclaim.map((r) => r.buildId));

  const nextOwn: OwnRule[] = [
    ...current.own.filter((rule) => !reclaimSet.has(rule.buildId)),
    ...expireIds
      .filter((id) => !ruledIds.has(id))
      .map((id) => ({ buildId: id, prefix: rulePrefix(prefix, id) })),
  ];

  const total = current.foreign.length + nextOwn.length;
  if (total > MAX_RULES) {
    throw new PlanError(
      `规则总数会达到 ${total} 条，超过 R2 的 ${MAX_RULES} 条上限。` +
        `等已有规则删完后重跑一次即可自动回收，或手动清理 bucket 上的 lifecycle 规则。`,
    );
  }

  return {
    keep: [...keepMap].map(([buildId, reason]) => ({
      buildId,
      lastModified: input.lastModified.get(buildId) ?? null,
      reason,
    })),
    expire: expireIds.map((buildId) => ({
      buildId,
      lastModified: input.lastModified.get(buildId) ?? null,
      isNew: !ruledIds.has(buildId),
    })),
    reclaim,
    nextDoc: { own: nextOwn, foreign: current.foreign },
    changed: reclaim.length > 0 || nextOwn.length !== current.own.length,
  };
}

/** 规则作用的前缀。结尾的斜杠不能省，否则某个 buildId 恰是另一个的前缀时会误删。 */
export function rulePrefix(prefix: string, buildId: string): string {
  const base = prefix.replace(/^\/+|\/+$/g, "");
  return `${base}/${buildId}/`;
}
