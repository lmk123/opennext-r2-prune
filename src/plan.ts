import { normalizePrefix, rulePrefix } from "./prefix.ts";
import {
  type LifecycleDoc,
  MAX_RULE_ID_LENGTH,
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

/** R2 的 lifecycle 规则总数上限 */
export const MAX_RULES = 1000;

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
  current: ParsedLifecycle;
  prefix: string;
  /** 规则的过期天数 */
  expireDays: number;
  /** 跳过「保留集必须存在于 bucket」这条校验 */
  force?: boolean;
  /** 承认「前缀为空、缓存直接放在 bucket 根下」这种布局 */
  allowRootPrefix?: boolean;
  /**
   * 跳过「规则总数不超过上限」这条校验。只给 collectPlan 挑候选用：那一遍还没排除刚写入的 build，
   * 会把它们也算成要挂规则的，拿它判上限会在接近上限时误中止。最终计划必须带着这条校验再算一遍
   */
  skipRuleLimit?: boolean;
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
      "--prefix 为空意味着把 bucket 根下的每一个一级目录都当成 build 缓存，" +
        "非缓存目录（assets/、backups/ 等）会一并被挂上删除规则。\n" +
        "确认这个 bucket 只用来存 OpenNext 缓存，可加 --allow-root-prefix。",
    );
  }

  // 规则归属按前缀划分，拿 A 前缀的配置给 B 前缀算计划会把 A 的规则全部回收掉
  if (normalizePrefix(prefix) !== current.prefix) {
    throw new PlanError(
      `内部错误：lifecycle 配置按前缀「${current.prefix}」分拣，计划却按「${normalizePrefix(prefix)}」计算，已中止，` +
        `没有写入任何改动。直接调用 makePlan 时请确认 current 是用同一个前缀读出的（getLifecycle(prefix)）；` +
        `否则这是本工具的缺陷，请带上这条报错提 issue。`,
    );
  }

  // 拆不出归属的规则不猜：它可能是任何一个站点的。对整个 bucket 生效的已由调用方先报过
  if (current.malformed.length > 0) {
    const listed = current.malformed
      .map((rule) => (isWholeBucket(rule) ? `${rule.id}（没有 <Filter><Prefix>，正对整个 bucket 生效！）` : rule.id))
      .join("、");
    throw new XmlAssumptionError(
      `bucket 上有规则以本工具的标记开头，却拆不出「${RULE_ID_PREFIX}<规则作用的前缀>」里的缓存前缀与 buildId：${listed}，` +
        `无从判断它属于哪个缓存前缀，已中止。请用 npx wrangler r2 bucket lifecycle list 核对后手动删除这些规则再重跑。`,
    );
  }

  // 外层前缀的「一级目录」里就有内层前缀所在的那一段，外层那一趟会把它当成一个作废 build，
  // 整个删掉内层站点的缓存。别的前缀写过规则就说明那里有站点在用，两个方向都中止。
  const nested = current.others.filter(
    (rule) => rule.scope.startsWith(current.prefix) || current.prefix.startsWith(rule.scope),
  );
  if (nested.length > 0) {
    const shown = (scope: string) => (scope === "" ? "（空，即 bucket 根）" : scope);
    const scopes = [...new Set(nested.map((rule) => rule.scope))];
    throw new PlanError(
      `bucket 上有本工具为缓存前缀 ${scopes.map(shown).join("、")} 写的规则，与本次的前缀 ${shown(current.prefix)} 互相嵌套：` +
        `外层前缀的运行会把内层前缀所在的目录当成一个 build，判作废后连同另一个站点的缓存整个删掉，已中止。\n` +
        `请给共用 bucket 的每个站点换成互不嵌套的前缀；若那些前缀已经弃用，用 npx wrangler r2 bucket lifecycle list ` +
        `找出这些规则手动删除后重跑：${nested.map((rule) => rule.id).join("、")}。`,
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
        ? `目录名本身就太长，换前缀也没用：OpenNext 的 build id 不会这么长，请确认它是不是缓存目录，不是就把它移出 ${normalizePrefix(prefix) || "bucket 根"}。`
        : `请换一个更短的 --prefix（同时改 OpenNext 的 NEXT_INC_CACHE_R2_PREFIX）；若目录名长得反常，先确认它是不是缓存目录。`;
    throw new PlanError(
      `目录 ${tooLong} 判作废时要写的规则 ID ${id} 长 ${id.length} 个字符（缓存前缀占 ${prefixLength}、目录名占 ${tooLong.length}），` +
        `超过 lifecycle 规则 ID 的 ${MAX_RULE_ID_LENGTH} 字符上限，已中止。${fix}`,
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
  if (expireIds.length > 0 && !existing.some((id) => judged.has(id))) {
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
  // 按 buildId 去重：同一个 build 有多条规则时，回收的是这个 build，它的规则写回时会一并消失
  const reclaim: ReclaimedRule[] = [...new Set(current.own.map((rule) => rule.buildId))]
    .filter((buildId) => !existingSet.has(buildId) || keepMap.has(buildId))
    .map((buildId) => ({
      buildId,
      // 不在 bucket 里的 build 没什么可「复活」的，哪怕它在保留集里（预览 / 历史 build，
      // 或 --force 硬留的），目录空了就是空了；留下的规则按过滤条件必然属于保留集
      reason: existingSet.has(buildId) ? ("revived" as const) : ("emptied" as const),
    }));

  // 该删的 build 一律按当前选项重新生成规则，而不是沿用已有的那条：已有规则可能是用
  // 另一个 --expire-days 写下的，或前缀已被服务端丢掉，沿用就等于永远修不好它。
  // current.own 中没进 reclaim 的条目，其 buildId 必然落在 expireIds 里，所以这里不会丢规则。
  const nextOwn: OwnRule[] = expireIds.map((buildId) => ({
    buildId,
    prefix: rulePrefix(prefix, buildId),
    expireDays,
    enabled: true,
  }));

  const total = current.foreign.length + nextOwn.length;
  if (!input.skipRuleLimit && total > MAX_RULES) {
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
    nextDoc: { prefix: current.prefix, own: nextOwn, foreign: current.foreign },
    changed:
      current.own.length !== nextOwn.length ||
      nextOwn.some((rule) => !sameRule(currentById.get(rule.buildId), rule)),
  };
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
        const shown =
          got.prefix !== ""
            ? got.prefix
            : got.barePrefix
              ? `空，只有 R2 不认的裸 <Prefix>${got.barePrefix}（按作用于整个 bucket 对待！）`
              : "空（作用于整个 bucket！）";
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
