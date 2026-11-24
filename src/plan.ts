import { normalizePrefix } from "./prefix.ts";
import type { LifecycleDoc, OwnRule } from "./xml.ts";

/**
 * 判定哪些 build 该留、哪些该交给 R2 删，以及最终要写回的规则集。
 * 这里不发任何请求，全部安全校验都在此完成 —— 校验不过就抛错，调用方不会走到写入。
 */

/** R2 的 lifecycle 规则总数上限 */
export const MAX_RULES = 1000;

/**
 * online = 此刻承载线上流量；recent = 近期上过线；preview = 某个 Preview 当前的 build；
 * explicit = --keep 传入。同一个 build 有多个来源时按这个顺序取第一个展示。
 */
export type KeepReason = "online" | "recent" | "preview" | "explicit";

const KEEP_PRIORITY: KeepReason[] = ["online", "recent", "preview", "explicit"];

/**
 * 这两类来源不在 bucket 里是正常的：旧 build 早已删完，预览可能绑了别的 bucket 或还没写缓存。
 * online / explicit 不在则多半是参数填错，仍要报错。
 */
const MAY_BE_ABSENT: ReadonlySet<KeepReason> = new Set(["recent", "preview"]);
export type ReclaimReason = "emptied" | "revived";
/** new = 本次新增；updated = 已有规则但内容与期望不符（或有重复），要改写；pending = 已是期望的样子，R2 还在删 */
export type ExpireState = "new" | "updated" | "pending";

export interface KeptBuild {
  buildId: string;
  reason: KeepReason;
  /** 来源细节：预览名、version id 前缀等 */
  source?: string;
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
  /** 要保留、但 bucket 里本来就没有的 build（只可能是 recent / preview），仅供展示 */
  absent: KeptBuild[];
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
  keep: KeptBuild[];
  current: LifecycleDoc;
  prefix: string;
  /** 规则的过期天数 */
  expireDays: number;
  /** 跳过「保留集必须存在于 bucket」这条校验 */
  force?: boolean;
  /** 承认「前缀为空、缓存直接放在 bucket 根下」这种布局 */
  allowRootPrefix?: boolean;
}

export function makePlan(input: PlanInput): PrunePlan {
  const { existing, current, prefix, expireDays } = input;
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

  // 同一个 buildId 可能来自多个来源（既在线上又是某个预览、又被 --keep 传入），按优先级展示；
  // 但「必须在 bucket 里」要看全部来源：--keep 了一个恰好也是历史版本的 id，填错时照样得报出来
  const keepMap = new Map<string, KeptBuild>();
  const mustExist = new Set<string>();
  for (const build of input.keep) {
    const seen = keepMap.get(build.buildId);
    if (!seen || KEEP_PRIORITY.indexOf(build.reason) < KEEP_PRIORITY.indexOf(seen.reason)) {
      keepMap.set(build.buildId, build);
    }
    if (!MAY_BE_ABSENT.has(build.reason)) mustExist.add(build.buildId);
  }

  if (keepMap.size === 0) {
    throw new PlanError("保留集为空，拒绝继续 —— 那会把所有 build 缓存都标记为删除。");
  }

  const keep: KeptBuild[] = [];
  const absent: KeptBuild[] = [];
  const missing: string[] = [];
  for (const build of keepMap.values()) {
    if (existingSet.has(build.buildId)) keep.push(build);
    else if (!mustExist.has(build.buildId)) absent.push(build);
    else {
      // 加了 --force 仍留在 keep 里：它是用户坚持要保留的，只是眼下不在 bucket 里
      keep.push(build);
      missing.push(build.buildId);
    }
  }
  if (missing.length > 0 && !input.force) {
    throw new PlanError(
      `要保留的 build 在 bucket 里不存在：${missing.join(", ")}。\n` +
        `通常意味着 bucket、--prefix、站点域名或 --worker 有一个填错了。确认无误可加 --force 跳过这项检查。`,
    );
  }

  const expireIds = existing.filter((id) => !keepMap.has(id));
  if (expireIds.length > 0 && expireIds.length === existing.length) {
    throw new PlanError(
      "保留集与 bucket 里现存的 build 没有交集，拒绝把全部 build 缓存标记为删除。",
    );
  }

  // 同一个 buildId 有多条规则（比如一条正确、一条前缀被丢掉）时，Map 只能留下其中一条，
  // 拿它判状态会把要改写的显示成「已存在」，所以单独记下，一律算 updated
  const currentById = new Map<string, OwnRule>();
  const duplicated = new Set<string>();
  for (const rule of current.own) {
    if (currentById.has(rule.buildId)) duplicated.add(rule.buildId);
    currentById.set(rule.buildId, rule);
  }

  // 已经空掉的目录说明 R2 删完了，规则可以回收；重新上线的 build 必须立刻摘掉规则，
  // 否则它新写入的缓存会被这条残留规则继续删（Next.js 16.2+ 的确定性 build id 会撞上）
  const reclaim: ReclaimedRule[] = current.own
    .filter((rule) => !existingSet.has(rule.buildId) || keepMap.has(rule.buildId))
    .map((rule) => ({
      buildId: rule.buildId,
      // 不在 bucket 里的 build 没什么可「复活」的，哪怕它在保留集里（预览 / 历史 build，
      // 或 --force 硬留的），目录空了就是空了；留下的规则按过滤条件必然属于保留集
      reason: existingSet.has(rule.buildId) ? ("revived" as const) : ("emptied" as const),
    }));

  // 该删的 build 一律按当前选项重新生成规则，而不是沿用已有的那条：已有规则可能是用
  // 另一个 --prefix、另一个 --expire-days 写下的，或前缀已被服务端丢掉，沿用就等于永远修不好它。
  // current.own 中没进 reclaim 的条目，其 buildId 必然落在 expireIds 里，所以这里不会丢规则。
  const nextOwn: OwnRule[] = expireIds.map((buildId) => ({
    buildId,
    prefix: rulePrefix(prefix, buildId),
    expireDays,
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
    keep,
    absent,
    expire: nextOwn.map((rule) => ({
      buildId: rule.buildId,
      state: duplicated.has(rule.buildId) ? "updated" : expireState(currentById.get(rule.buildId), rule),
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
    before.enabled === after.enabled
  );
}

function expireState(before: OwnRule | undefined, after: OwnRule): ExpireState {
  if (before === undefined) return "new";
  return sameRule(before, after) ? "pending" : "updated";
}

/** 回读核对的结果。own 不为空说明本工具的规则没有按原样生效，必须撤销；foreign 只需提示。 */
export interface VerifyProblems {
  own: string[];
  foreign: string[];
}

/**
 * 写入后把配置读回来，与期望写入的逐条比对，列出所有对不上的地方（两个数组都为空即一致）。
 *
 * PUT 返回 200 不代表规则按原样生效：实测 R2 会静默丢掉裸 <Prefix>，把一条只针对某个
 * build 目录的删除规则变成作用于整个 bucket 的。这类服务端的静默改写只有读回来才看得见。
 * 同一个 buildId 读回来的每一条都要核对：只按 buildId 取一条，会让重复出来的危险规则蒙混过去。
 * 外部规则整块原样搬运，服务端可能调整它们的写法，所以只核对条数，且单独列出 —— 它不影响
 * 本工具规则是否安全，不该因此撤掉本工具的规则。
 */
export function verifyWritten(expected: LifecycleDoc, actual: LifecycleDoc): VerifyProblems {
  const own: string[] = [];
  const actualById = new Map<string, OwnRule[]>();
  for (const rule of actual.own) {
    const rules = actualById.get(rule.buildId);
    if (rules) rules.push(rule);
    else actualById.set(rule.buildId, [rule]);
  }
  const expectedIds = new Set(expected.own.map((rule) => rule.buildId));

  for (const want of expected.own) {
    const rules = actualById.get(want.buildId) ?? [];
    if (rules.length === 0) {
      own.push(`规则 ${want.buildId} 读回来不见了`);
      continue;
    }
    if (rules.length > 1) own.push(`规则 ${want.buildId} 读回来有 ${rules.length} 条`);
    for (const got of rules) {
      if (got.prefix !== want.prefix) {
        const shown = got.prefix === "" ? "空（作用于整个 bucket！）" : got.prefix;
        own.push(`规则 ${want.buildId} 的前缀读回来是 ${shown}，应为 ${want.prefix}`);
      }
      if (got.expireDays !== want.expireDays) {
        own.push(`规则 ${want.buildId} 的过期天数读回来是 ${got.expireDays}，应为 ${want.expireDays}`);
      }
      if (got.enabled !== want.enabled) {
        own.push(`规则 ${want.buildId} 的状态读回来是 ${got.enabled ? "启用" : "停用"}，应为 ${want.enabled ? "启用" : "停用"}`);
      }
    }
  }
  for (const rule of actual.own) {
    if (!expectedIds.has(rule.buildId)) own.push(`读回来多出一条本工具的规则 ${rule.buildId}`);
  }

  const foreign =
    actual.foreign.length === expected.foreign.length
      ? []
      : [`外部规则写入 ${expected.foreign.length} 条，读回来 ${actual.foreign.length} 条`];
  return { own, foreign };
}

/** 启用中、前缀为空的自有规则：它对整个 bucket 生效（旧版 bare 式样被 R2 丢掉前缀后就是这样）。 */
export function wholeBucketRules(doc: LifecycleDoc): string[] {
  return doc.own.filter((rule) => rule.enabled && rule.prefix === "").map((rule) => rule.buildId);
}
