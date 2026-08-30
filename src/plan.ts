import { normalizePrefix } from "./prefix.ts";
import type { LifecycleDoc, OwnRule } from "./xml.ts";

/**
 * 判定哪些 build 该留、哪些该交给 R2 删，以及最终要写回的规则集。
 * 这里不发任何请求，全部安全校验都在此完成 —— 校验不过就抛错，调用方不会走到写入。
 */

/** R2 的 lifecycle 规则总数上限 */
export const MAX_RULES = 1000;

export type KeepReason = "online" | "explicit";
export type ReclaimReason = "emptied" | "revived";
/** new = 本次新增；updated = 已有规则但内容与期望不符，要改写；pending = 已是期望的样子，R2 还在删 */
export type ExpireState = "new" | "updated" | "pending";

export interface KeptBuild {
  buildId: string;
  reason: KeepReason;
}

export interface ExpiringBuild {
  buildId: string;
  state: ExpireState;
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
  /** 要保留的 build 及其原因 */
  keep: { buildId: string; reason: KeepReason }[];
  current: LifecycleDoc;
  prefix: string;
  /** 规则的过期天数 */
  expireDays: number;
  /** 规则里 Prefix 的包装形式 */
  style: "filter" | "bare";
  /** 跳过「保留集必须存在于 bucket」这条校验 */
  force?: boolean;
  /** 承认「前缀为空、缓存直接放在 bucket 根下」这种布局 */
  allowRootPrefix?: boolean;
}

export function makePlan(input: PlanInput): PrunePlan {
  const { existing, current, prefix, expireDays, style } = input;
  const existingSet = new Set(existing);

  // 前缀为空时，「一级目录」就是 bucket 根下的全部目录 —— 除缓存外还堆着别的东西
  // （静态资源、备份……）的 bucket 会把它们统统当成作废 build 挂上删除规则。
  // 这是本工具唯一能删到非缓存数据的路径，所以要求显式承认。
  if (normalizePrefix(prefix) === "" && !input.allowRootPrefix) {
    throw new PlanError(
      "--prefix 为空意味着把 bucket 根下的每一个一级目录都当成 build 缓存，" +
        "非缓存目录（assets/、backups/ 等）会一并被挂上删除规则。\n" +
        "确认这个 bucket 只用来存 OpenNext 缓存，可加 --allow-root-prefix。",
    );
  }

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

  const currentById = new Map(current.own.map((rule) => [rule.buildId, rule]));

  // 已经空掉的目录说明 R2 删完了，规则可以回收；重新上线的 build 必须立刻摘掉规则，
  // 否则它新写入的缓存会被这条残留规则继续删（Next.js 16.2+ 的确定性 build id 会撞上）
  const reclaim: ReclaimedRule[] = current.own
    .filter((rule) => !existingSet.has(rule.buildId) || keepMap.has(rule.buildId))
    .map((rule) => ({
      buildId: rule.buildId,
      reason: keepMap.has(rule.buildId) ? ("revived" as const) : ("emptied" as const),
    }));

  // 该删的 build 一律按当前选项重新生成规则，而不是沿用已有的那条：已有规则可能是用
  // 另一个 --prefix、另一个 --expire-days 或另一种式样写下的，沿用就等于永远修不好它。
  // current.own 中没进 reclaim 的条目，其 buildId 必然落在 expireIds 里，所以这里不会丢规则。
  const nextOwn: OwnRule[] = expireIds.map((buildId) => ({
    buildId,
    prefix: rulePrefix(prefix, buildId),
    expireDays,
    style,
    enabled: true,
  }));

  const total = current.foreign.length + nextOwn.length;
  if (total > MAX_RULES) {
    throw new PlanError(
      `规则总数会达到 ${total} 条，超过 R2 的 ${MAX_RULES} 条上限。` +
        `等已有规则删完后重跑一次即可自动回收，或手动清理 bucket 上的 lifecycle 规则。`,
    );
  }

  return {
    keep: [...keepMap].map(([buildId, reason]) => ({ buildId, reason })),
    expire: nextOwn.map((rule) => ({
      buildId: rule.buildId,
      state: expireState(currentById.get(rule.buildId), rule),
    })),
    reclaim,
    nextDoc: { own: nextOwn, foreign: current.foreign },
    changed:
      current.own.length !== nextOwn.length ||
      nextOwn.some((rule) => !sameRule(currentById.get(rule.buildId), rule)),
  };
}

/** 规则作用的前缀。结尾的斜杠不能省，否则某个 buildId 恰是另一个的前缀时会误删。 */
export function rulePrefix(prefix: string, buildId: string): string {
  return `${normalizePrefix(prefix)}${buildId}/`;
}

/** 逐字段比对，任何一项不同都意味着这条规则得重写 —— 只比条数会漏掉选项变更。 */
function sameRule(before: OwnRule | undefined, after: OwnRule): boolean {
  return (
    before !== undefined &&
    before.prefix === after.prefix &&
    before.expireDays === after.expireDays &&
    sameStyle(before.style, after.style) &&
    before.enabled === after.enabled
  );
}

/**
 * 式样是否算一致。S3 的 GetBucketLifecycle(v2) 会把写入时裸挂在 <Rule> 下的 <Prefix>
 * 规范化成 <Filter><Prefix>，所以「读回来是 filter」无法区分服务端规范化与上次就写的
 * filter。若在这个方向上较真，`--lifecycle-style bare` 的每次运行都会把全部规则判成要
 * 改写、重发一次 PUT，changed 永远为 true，收敛不了。
 * 反方向仍然较真：读回来是 bare 就说明服务端不做规范化，此时式样确实不符。
 * 已有 filter 规则本身就证明 R2 认 <Filter>，所以这里不会挡住真正需要的切换。
 */
function sameStyle(before: OwnRule["style"], after: OwnRule["style"]): boolean {
  return before === after || (before === "filter" && after === "bare");
}

function expireState(before: OwnRule | undefined, after: OwnRule): ExpireState {
  if (before === undefined) return "new";
  return sameRule(before, after) ? "pending" : "updated";
}
