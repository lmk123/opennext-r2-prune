import { normalizePrefix, rulePrefix } from "./prefix.ts";
import {
  type LifecycleDoc,
  MAX_RULE_ID_LENGTH,
  type OtherScopeRule,
  type OwnRule,
  type ParsedLifecycle,
  RULE_ID_PREFIX,
  ruleId,
  XmlAssumptionError,
} from "./xml.ts";

/**
 * 判定哪些 build 该留、哪些该交给 R2 删，以及最终要写回的规则集。
 * 这里不发任何请求，全部安全校验都在此完成 —— 校验不过就抛错，调用方不会走到写入。
 */

/** R2 每个 bucket 的 lifecycle 规则总数上限。实测超出时 PUT 回 400 MalformedXML，不说是条数超了 */
export const MAX_RULES = 1000;

/**
 * 本工具挂规则时给用户自己的规则留的余量：总数只挂到 MAX_RULES - RESERVED_RULES。不留的话 bucket 会被挂满，
 * 用户新加规则会被 R2 以 MalformedXML 拒绝，很难查出是条数超了
 */
export const RESERVED_RULES = 10;

/**
 * online = 此刻承载线上流量；recent = 近期上过线；preview = 某个 Preview 当前的 build；
 * explicit = --keep 传入；fresh = 目录刚写入不久，可能是还没上线的新部署。
 * 同一个 build 有多个来源时按这个顺序取第一个展示。
 *
 * fresh 不是对线上状态的判断，只是「暂且不判」：它不算进「保留集不能为空」「保留集必须与现存 build
 * 有交集」这两条校验，否则一个刚写进 bucket 的 build 就能让填错的前缀或站点蒙混过关。
 */
export type KeepReason = "online" | "recent" | "preview" | "explicit" | "fresh";

const KEEP_PRIORITY: KeepReason[] = ["online", "recent", "preview", "explicit", "fresh"];

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
  /** 来源细节：预览名、version id 前缀、写入时间等 */
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

/**
 * 保留集之外、但 lifecycle 规则名额不够，这次没挂上规则的 build。之后的运行回收规则、空出名额后再挂。
 * 名额为 0 时不读写入时间（见 collectPlan），刚写入、本该暂且不判的 build 这时也列在这里
 */
export interface DeferredBuild {
  buildId: string;
}

export interface PrunePlan {
  keep: KeptBuild[];
  /** 要保留、但 bucket 里本来就没有的 build（只可能是 recent / preview），仅供展示 */
  absent: KeptBuild[];
  expire: ExpiringBuild[];
  /** 名额不够，这次不挂规则的作废 build。它们不在 expire 里，也不算保留 */
  deferred: DeferredBuild[];
  /**
   * 名额永远空不出来：deferred 等多少轮也挂不上，得手动清理规则。只在这趟还有别的改动要写时可能为 true，
   * 没别的可写时 makePlan 直接中止
   */
  quotaExhausted: boolean;
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
  current: ParsedLifecycle;
  prefix: string;
  /** 规则的过期天数 */
  expireDays: number;
  /** 跳过「保留集必须存在于 bucket」这条校验 */
  force?: boolean;
  /** 承认「前缀为空、缓存直接放在 bucket 根下」这种布局 */
  allowRootPrefix?: boolean;
  /**
   * 各 build 目录的写入时间（null = 目录已空、读不到）。规则名额不够时先给写入最早的挂规则；
   * 不在这里或为 null 的排在后面，彼此按 buildId 排
   */
  writtenAt?: ReadonlyMap<string, Date | null>;
  /**
   * 不按规则总数上限截断。只给 collectPlan 筛掉刚写入的 build 之前那一遍用：那时算上限，
   * 刚写入的 build 会占名额，名额被外部规则占满时还会白白中止
   */
  skipRuleLimit?: boolean;
  /**
   * 本工具为别的前缀写的规则里，目录眼下一个对象都没有（列那个前缀时没列出来）的那些（键见 otherRuleDir）。目录删完了规则还在，
   * 说明那个前缀的运行还没回收、也可能再也不会回收（改 --prefix 前的旧前缀），算名额时和用户自己的规则
   * 一样当成永久占用
   */
  emptyRuleDirs?: ReadonlySet<string>;
}

/**
 * 只看前缀、现有配置和 bucket 里列出的目录就能做的校验。collectPlan 在探测之前先调一次：这些错误与
 * 线上状态无关，不该被探测失败挡在后面；makePlan 再调一次，保证单独调用它时也不会漏掉。
 */
export function checkLayout(input: Pick<PlanInput, "existing" | "current" | "prefix" | "allowRootPrefix">): void {
  const { existing, current, prefix } = input;

  // 前缀为空时，「一级目录」就是 bucket 根下的全部目录 —— 除缓存外还堆着别的东西
  // （静态资源、备份……）的 bucket 会把它们统统当成作废 build 挂上删除规则。
  // 这是本工具唯一能删到非缓存数据的路径，所以要求显式承认。
  if (normalizePrefix(prefix) === "" && !input.allowRootPrefix) {
    throw new PlanError(
      "An empty --prefix means treating every top-level directory at the bucket root as a build cache, " +
        "so non-cache directories (assets/, backups/, etc.) would get deletion rules too.\n" +
        "If you're sure this bucket only stores the OpenNext cache, add --allow-root-prefix.",
    );
  }

  // 规则归属按前缀划分，拿 A 前缀的配置给 B 前缀算计划会把 A 的规则全部回收掉
  if (normalizePrefix(prefix) !== current.prefix) {
    throw new PlanError(
      `Internal error: the lifecycle configuration was sorted by prefix "${current.prefix}", but the plan was computed for "${normalizePrefix(prefix)}"; aborted ` +
        `without writing anything. When calling makePlan directly, make sure current was read with the same prefix (getLifecycle(prefix)); ` +
        `otherwise this is a bug in this tool, please open an issue with this error.`,
    );
  }

  // 拆不出归属的规则不猜：它可能是任何一个站点的。对整个 bucket 生效的已由调用方先报过
  if (current.malformed.length > 0) {
    const listed = current.malformed
      .map((rule) => (isWholeBucket(rule) ? `${rule.id} (no <Filter><Prefix>, currently applies to the whole bucket!)` : rule.id))
      .join(", ");
    throw new XmlAssumptionError(
      `The bucket has rules starting with this tool's marker whose IDs can't be split into the cache prefix and buildId of "${RULE_ID_PREFIX}<prefix the rule targets>": ${listed}. ` +
        `There's no way to tell which cache prefix they belong to, so it aborted. Check them with npx wrangler r2 bucket lifecycle list, delete them manually, then run again.`,
    );
  }

  // 外层前缀的「一级目录」里就有内层前缀所在的那一段，外层那一趟会把它当成一个作废 build，
  // 整个删掉内层站点的缓存。别的前缀写过规则就说明那里有站点在用，两个方向都中止。
  const nested = current.others.filter(
    (rule) => rule.scope.startsWith(current.prefix) || current.prefix.startsWith(rule.scope),
  );
  if (nested.length > 0) {
    const shown = (scope: string) => (scope === "" ? "(empty, i.e. the bucket root)" : scope);
    const scopes = [...new Set(nested.map((rule) => rule.scope))];
    throw new PlanError(
      `The bucket has rules this tool wrote for cache prefix ${scopes.map(shown).join(", ")}, which is nested with this run's prefix ${shown(current.prefix)}: ` +
        `a run for the outer prefix would treat the inner prefix's directory as a build, judge it obsolete and delete the other site's cache along with it, so it aborted.\n` +
        `Give every site sharing the bucket a prefix that isn't nested with the others; if those prefixes are abandoned, find these rules with npx wrangler r2 bucket lifecycle list, ` +
        `delete them manually, then run again: ${nested.map((rule) => rule.id).join(", ")}.`,
    );
  }

  // ID 带着整个缓存前缀，太长时 PUT 会被拒。按 bucket 里现有的每个目录都算一遍，不等判定出
  // 哪些作废：今天保留的 build 迟早也会作废、要写规则，早点拦下，好说清是前缀还是目录名太长
  const tooLong = existing.find((buildId) => ruleId(prefix, buildId).length > MAX_RULE_ID_LENGTH);
  if (tooLong !== undefined) {
    const id = ruleId(prefix, tooLong);
    const prefixLength = normalizePrefix(prefix).length;
    // 前缀为空时 ID 仍超长，只能是目录名本身太长，换前缀无济于事
    const fix =
      ruleId("", tooLong).length > MAX_RULE_ID_LENGTH
        ? `The directory name itself is too long, so changing the prefix won't help: OpenNext build ids are never this long. Check whether it's a cache directory, and if not, move it out of ${normalizePrefix(prefix) || "the bucket root"}.`
        : `Switch to a shorter --prefix (and change OpenNext's NEXT_INC_CACHE_R2_PREFIX too); if the directory name is unusually long, first check whether it's a cache directory.`;
    throw new PlanError(
      `The rule ID ${id} to write if directory ${tooLong} is judged obsolete is ${id.length} characters long (cache prefix ${prefixLength}, directory name ${tooLong.length}), ` +
        `exceeding the ${MAX_RULE_ID_LENGTH}-character limit for lifecycle rule IDs, so it aborted. ${fix}`,
    );
  }
}

export function makePlan(input: PlanInput): PrunePlan {
  const { existing, current, prefix, expireDays } = input;
  const existingSet = new Set(existing);
  checkLayout(input);

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

  // fresh 只是暂且不判，不能拿它充当保留集，见 KeepReason
  const judged = new Set(input.keep.filter((b) => b.reason !== "fresh").map((b) => b.buildId));
  if (judged.size === 0) {
    throw new PlanError("The keep set is empty; refusing to continue — that would mark every build cache for deletion.");
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
      `Builds to keep don't exist in the bucket: ${missing.join(", ")}.\n` +
        `This usually means one of the bucket, --prefix, the site domain or --worker is wrong. Once you've confirmed it's correct, add --force to skip this check.`,
    );
  }

  const expireIds = existing.filter((id) => !keepMap.has(id));
  if (expireIds.length > 0 && !existing.some((id) => judged.has(id))) {
    throw new PlanError(
      "The keep set has no overlap with the builds in the bucket; refusing to mark every build cache for deletion.",
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
  // 按 buildId 去重：同一个 build 有多条规则时，回收的是这个 build，它的规则写回时会一并消失
  const reclaim: ReclaimedRule[] = [...new Set(current.own.map((rule) => rule.buildId))]
    .filter((buildId) => !existingSet.has(buildId) || keepMap.has(buildId))
    .map((buildId) => ({
      buildId,
      // 不在 bucket 里的 build 没什么可「复活」的，哪怕它在保留集里（预览 / 历史 build，
      // 或 --force 硬留的），目录空了就是空了；留下的规则按过滤条件必然属于保留集
      reason: existingSet.has(buildId) ? ("revived" as const) : ("emptied" as const),
    }));

  const { attach, deferred, budget } = input.skipRuleLimit
    ? { attach: new Set(expireIds), deferred: [], budget: undefined }
    : fitRuleLimit(expireIds, currentById, current, input.writtenAt, input.emptyRuleDirs);

  // 该删的 build 一律按当前选项重新生成规则，而不是沿用已有的那条：已有规则可能是用
  // 另一个 --expire-days 写下的，或前缀已被服务端丢掉，沿用就等于永远修不好它。
  // current.own 中没进 reclaim 的条目，其 buildId 必然落在 expireIds 里、且 fitRuleLimit 不会推迟它，所以这里不会丢规则。
  const nextOwn: OwnRule[] = expireIds
    .filter((buildId) => attach.has(buildId))
    .map((buildId) => ({
      buildId,
      prefix: rulePrefix(prefix, buildId),
      expireDays,
      enabled: true,
    }));

  const changed =
    current.own.length !== nextOwn.length ||
    nextOwn.some((rule) => !sameRule(currentById.get(rule.buildId), rule));

  // 名额被永远不会自己空出来的规则占满时，推迟的 build 再等多少轮也挂不上，只能由人清理。
  // 还有别的改动（摘掉回滚 build 的规则、回收删完的）时先照常写入，它们不能被名额问题挡住；下一趟没别的可写时再中止
  if (budget?.exhausted && deferred.length > 0 && !changed) {
    throw new PlanError(exhaustedMessage(budget, deferred.length));
  }

  return {
    keep,
    absent,
    deferred: deferred.map((buildId) => ({ buildId })),
    quotaExhausted: (budget?.exhausted ?? false) && deferred.length > 0,
    expire: nextOwn.map((rule) => ({
      buildId: rule.buildId,
      state: duplicated.has(rule.buildId) ? "updated" : expireState(currentById.get(rule.buildId), rule),
    })),
    reclaim,
    nextDoc: { prefix: current.prefix, own: nextOwn, foreign: current.foreign },
    changed,
  };
}

/** 规则名额的核算结果 */
export interface RuleBudget {
  /** 这次还能新挂几条规则 */
  room: number;
  /** 本工具最多挂到的规则总数 */
  cap: number;
  /** 用户自己的规则条数 */
  users: number;
  /** 本工具为别的前缀写的、目录已经删空却还没被回收的规则，眼下看不出有哪一趟会回收 */
  stale: OtherScopeRule[];
  /** 用户的规则加上 stale 就占满了 MAX_RULES：名额永远空不出来 */
  exhausted: boolean;
}

/**
 * 别的前缀下一条规则对应的 build 目录，即 emptyRuleDirs 的键。按规则 ID 拆出的前缀和 buildId 拼，不看规则的
 * Filter 前缀：那个前缀的运行回收规则时，看的就是自己列出的目录里还有没有这个 buildId，两边口径一致才判得准
 * 「有没有哪一趟会回收它」
 */
export function otherRuleDir(rule: OtherScopeRule): string {
  return `${rule.scope}${rule.buildId}/`;
}

/**
 * 核算 lifecycle 规则名额。ruled 是这一趟留着已有规则的作废 build 个数。
 *
 * 总数只挂到上限减去 RESERVED_RULES，给用户自己的规则留余量；永久占用（用户的规则加上 stale）已经挤进
 * 这段余量时让给本工具，否则每轮一条都挂不上。两者要合起来算：只看用户的规则，stale 再占掉几条就会在
 * 还有空位时中止。本工具为别的前缀写的、目录还没删完的规则，R2 删完后那个前缀的运行会回收，不算永久占用。
 *
 * stale 按条看目录，不看整个前缀空不空：改 --prefix 前的旧前缀里通常还留着切换时保留的 build（从没挂过规则），
 * 前缀永远不空，按前缀看就永远认不出它弃用了，推迟会无声地一直持续下去。
 */
export function ruleBudget(current: ParsedLifecycle, ruled: number, emptyRuleDirs?: ReadonlySet<string>): RuleBudget {
  const users = userRuleCount(current);
  const stale = emptyRuleDirs ? current.others.filter((rule) => emptyRuleDirs.has(otherRuleDir(rule))) : [];
  const permanent = users + stale.length;
  const cap = permanent >= MAX_RULES - RESERVED_RULES ? MAX_RULES : MAX_RULES - RESERVED_RULES;
  return {
    room: Math.max(0, cap - current.foreign.length - ruled),
    cap,
    users,
    stale,
    exhausted: permanent >= MAX_RULES,
  };
}

/** 用户自己的规则条数：foreign 里也装着本工具为别的前缀写的、以及拆不开的规则的原文，扣掉才是用户自己的 */
function userRuleCount(current: ParsedLifecycle): number {
  return current.foreign.length - current.others.length - current.malformed.length;
}

/**
 * 别的前缀的规则全算永久占用时，能不能让名额放宽或永远空不出来（见 ruleBudget）。不能的话，
 * 去探查它们的目录空不空也改变不了结果，不必发那些请求
 */
export function othersCanMatter(current: ParsedLifecycle): boolean {
  return current.others.length > 0 && userRuleCount(current) + current.others.length >= MAX_RULES - RESERVED_RULES;
}

function exhaustedMessage(budget: RuleBudget, deferred: number): string {
  const scopes = [...new Set(budget.stale.map((rule) => rule.scope))];
  // 目录删空了规则还在，可能是旧前缀没人回收，也可能是在用的站点还没跑到回收那一趟，所以两种补救都给
  const staleNote =
    budget.stale.length > 0
      ? `, and ${budget.stale.length} of the rules this tool wrote for cache prefix ${scopes.join(", ")} target directories that are already empty but weren't reclaimed — ` +
        `most likely an old prefix from before a --prefix change, which no run will ever reclaim`
      : "";
  const staleFix =
    budget.stale.length > 0
      ? `. If a site still uses those prefixes, run that site once first and it will reclaim its own finished rules; if they're confirmed abandoned, delete them manually ` +
        `(rule IDs look like ${RULE_ID_PREFIX}<old prefix>/<buildId>/; deleting those whose directories are already empty can't delete anything by mistake)`
      : "";
  return (
    `Aborted while checking lifecycle rule slots: R2 allows at most ${MAX_RULES} lifecycle rules per bucket, your own rules on the bucket number ` +
    `${budget.users}${staleNote}. Slots can never be freed, so none of the ${deferred} obsolete builds can get a deletion rule; nothing was written.\n` +
    `Find the rules you no longer need with npx wrangler r2 bucket lifecycle list <bucket> and delete them manually${staleFix}, then run again once slots are freed.`
  );
}

/**
 * 按 R2 的规则总数上限挑出这次挂规则的作废 build，其余推迟到之后的运行。
 *
 * 已经挂着规则的一律留下（哪怕要改写）：摘掉它，R2 正在进行的删除就停了，下次还得重新排队。
 * 名额（见 ruleBudget）够就全挂，不够时按写入时间从早到晚挂满。推迟的 build 不挂规则也不算保留；
 * R2 删完已挂规则的目录后，之后的运行会回收那些规则、空出名额，逐轮挂完。
 *
 * 本工具为别的前缀写的、目录还没删完的规则占着名额时只推迟不中止：R2 删完后那个前缀的运行会自己回收，
 * 中止会让共用 bucket 的另一个站点在对方清积压期间每趟都失败。名额永远空不出来时由 makePlan 中止。
 */
function fitRuleLimit(
  expireIds: string[],
  currentById: ReadonlyMap<string, OwnRule>,
  current: ParsedLifecycle,
  writtenAt: ReadonlyMap<string, Date | null> | undefined,
  emptyRuleDirs: ReadonlySet<string> | undefined,
): { attach: Set<string>; deferred: string[]; budget: RuleBudget } {
  const ruled = expireIds.filter((id) => currentById.has(id));
  const unruled = expireIds.filter((id) => !currentById.has(id));
  const budget = ruleBudget(current, ruled.length, emptyRuleDirs);
  if (unruled.length <= budget.room) return { attach: new Set(expireIds), deferred: [], budget };

  const time = (id: string) => writtenAt?.get(id)?.getTime() ?? Number.POSITIVE_INFINITY;
  // 两边都没有时间时 Infinity - Infinity 是 NaN，同样落到按 buildId 排
  const order = [...unruled].sort((a, b) => time(a) - time(b) || (a < b ? -1 : a > b ? 1 : 0));
  const attach = new Set([...ruled, ...order.slice(0, budget.room)]);
  return { attach, deferred: unruled.filter((id) => !attach.has(id)), budget };
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
      own.push(`rule ${want.buildId} is missing when read back`);
      continue;
    }
    if (rules.length > 1) own.push(`rule ${want.buildId} reads back as ${rules.length} rules`);
    for (const got of rules) {
      if (got.prefix !== want.prefix) {
        const shown =
          got.prefix !== ""
            ? got.prefix
            : got.barePrefix
              ? `empty, with only a bare <Prefix>${got.barePrefix} that R2 ignores (treated as applying to the whole bucket!)`
              : "empty (applies to the whole bucket!)";
        own.push(`rule ${want.buildId} reads back with prefix ${shown}, expected ${want.prefix}`);
      }
      if (got.expireDays !== want.expireDays) {
        own.push(`rule ${want.buildId} reads back with ${got.expireDays} expiration days, expected ${want.expireDays}`);
      }
      if (got.enabled !== want.enabled) {
        own.push(`rule ${want.buildId} reads back as ${got.enabled ? "enabled" : "disabled"}, expected ${want.enabled ? "enabled" : "disabled"}`);
      }
    }
  }
  for (const rule of actual.own) {
    if (!expectedIds.has(rule.buildId)) own.push(`an extra rule of this tool, ${rule.buildId}, was read back`);
  }

  const foreign =
    actual.foreign.length === expected.foreign.length
      ? []
      : [`external rules: ${expected.foreign.length} written, ${actual.foreign.length} read back`];
  return { own, foreign };
}

/**
 * 启用中、没有 <Filter><Prefix> 的规则：它对整个 bucket 生效（被 R2 丢掉前缀后就是这样）。
 * 读回来带着裸 <Prefix> 的也算 —— R2 不认那种写法。
 */
export function isWholeBucket(rule: Pick<OwnRule, "enabled" | "prefix">): boolean {
  return rule.enabled && rule.prefix === "";
}

/**
 * 本工具所有对整个 bucket 生效的规则的 ID（照 bucket 上的原样），别的前缀下的、格式不对的也算：
 * 那些前缀可能已经弃用、再没有运行会报出它们，而它们删的是整个 bucket。只有当前前缀下的会被这一趟
 * 改写，其余只能报出来让人手动删。
 */
export function wholeBucketRules(doc: ParsedLifecycle): string[] {
  return [
    ...doc.own.filter(isWholeBucket).map((rule) => rule.id ?? ruleId(doc.prefix, rule.buildId)),
    ...doc.others.filter(isWholeBucket).map((rule) => rule.id),
    ...doc.malformed.filter(isWholeBucket).map((rule) => rule.id),
  ];
}
