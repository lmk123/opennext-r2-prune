import { CloudflareApi, CloudflareApiError } from "./cloudflare.ts";
import type { DeferredBuild, ExpiringBuild, KeptBuild, ReclaimedRule } from "./plan.ts";
import type { OnRetry } from "./retry.ts";
import { assertLifecycleUnchanged, collectPlan, writeAndVerify, WriteNotAppliedError } from "./run.ts";
import { R2Store, S3Error } from "./store.ts";
import { ruleId } from "./xml.ts";

/**
 * 供其它 JS 代码调用的入口。和 run.ts 一样只用 Web 标准 API，Node 与 Cloudflare Worker 里都能跑；
 * 参数、环境变量、终端交互仍归 cli.ts。
 *
 * 参数校验（validate）按库选项名报错；探测与安全校验阶段的报错沿用 CLI 的开关名（--keep、--url……），
 * 对应关系见 README「作为库调用」。
 */

export { BuildIdProbeError } from "./build-id.ts";
export { CloudflareApiError } from "./cloudflare.ts";
export { PlanError } from "./plan.ts";
export type {
  DeferredBuild,
  ExpireState,
  ExpiringBuild,
  KeepReason,
  KeptBuild,
  ReclaimReason,
  ReclaimedRule,
} from "./plan.ts";
export type { OnRetry } from "./retry.ts";
export { S3Error } from "./store.ts";
export { XmlAssumptionError } from "./xml.ts";

export interface PruneOptions {
  /** R2 bucket 名 */
  bucket: string;
  /** Cloudflare account id。用来拼 S3 endpoint，用 worker 时还要拿它调 Cloudflare API */
  accountId?: string;
  /** 覆盖 S3 endpoint，默认 https://<accountId>.r2.cloudflarestorage.com */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;

  // 保留哪些 build：worker、siteUrl / buildIdUrl、keep 至少给一种
  /** Worker 名。配合 apiToken 与 accountId，保留近期线上与全部预览的 build */
  worker?: string;
  /** Cloudflare API token，需 Workers Scripts 读权限 */
  apiToken?: string;
  /** 保留最近几个不同的线上 build，默认 3，只在给了 worker 时有意义 */
  recentBuilds?: number;
  /** 站点地址，从 <站点>/BUILD_ID 读线上 build id */
  siteUrl?: string;
  /** 覆盖 BUILD_ID 的探测地址，优先于 siteUrl */
  buildIdUrl?: string;
  /** 额外保留的 build id */
  keep?: string[];

  /** 缓存前缀，默认 incremental-cache */
  prefix?: string;
  /** 规则的过期天数，默认 1 */
  expireDays?: number;
  /** 目录写入不满这么多小时的 build 不判作废（可能是还没上线的新部署），默认 24；0 关闭 */
  graceHours?: number;
  /** 跳过「保留的 build 必须存在于 bucket」这项检查 */
  force?: boolean;
  /** 承认前缀为空（缓存直接放在 bucket 根下） */
  allowRootPrefix?: boolean;

  /**
   * 计算请求体的 base64 MD5，用来带上 Content-MD5。Web Crypto 没有 MD5，所以由调用方注入；
   * 不给就不带这个头（实测 R2 不校验它）。Node 里可传
   * `(body) => createHash("md5").update(body, "utf8").digest("base64")`。
   */
  md5Base64?: (body: string) => string;
  /** 替换全部网络请求用的 fetch，默认全局 fetch */
  fetch?: typeof fetch;
  /** 网络请求重试时的回调 */
  onRetry?: OnRetry;
  /**
   * 读到 bucket 上有对整个 bucket 生效的本工具规则时立即回调（在探测之前），参数是这些规则的 ID，
   * 含别的前缀下的、ID 格式不对的。探测或校验失败时整趟会中止、拿不到结果，这是调用方唯一能得知这些危险规则的地方，务必报出来。
   */
  onWholeBucketRules?: (ruleIds: string[]) => void;
}

/** 计划：写入前就能确定的全部信息 */
export interface PrunePlanSummary {
  bucket: string;
  prefix: string;
  expireDays: number;
  graceHours: number;
  /** 想保留的近期线上 build 个数；没给 worker 时为 null */
  recentBuilds: number | null;
  /** siteUrl / buildIdUrl 探测到的线上 build，与 probedFrom 成对 */
  onlineBuildId: string | null;
  probedFrom: string | null;
  /** 此刻承载线上流量的全部 build（灰度时不止一个） */
  onlineBuildIds: string[];
  /**
   * 走了 Cloudflare API 时的概要。recentBuilds 小于期望值说明全部 deployment 已经翻完，
   * 更早的 build 会被判作废，需要保留的请放进 keep
   */
  cloudflare: { deploymentsScanned: number; recentBuilds: number; previews: number } | null;
  /**
   * 运行前就已对整个 bucket 生效（前缀为空）的本工具规则的 ID，含别的前缀下的、ID 格式不对的。只有本次前缀下的
   * 会被写入改写，别的前缀下的得手动删除
   */
  wholeBucketRules: string[];
  /** 与现状一致时为 false，此时无需写入 */
  changed: boolean;
  /** 保留、且在 bucket 里的 build */
  keep: KeptBuild[];
  /** 要保留、但 bucket 里本来就没有的 build，仅供展示 */
  absent: KeptBuild[];
  /** 交给 R2 删除的 build */
  expire: ExpiringBuild[];
  /**
   * 已判作废、但 lifecycle 规则名额不够（R2 每个 bucket 最多 1000 条，分批挂时给用户自己的规则留些余量），这次没挂规则的 build（不算保留）。
   * 之后的运行回收已删完的规则、空出名额后再挂，逐轮清完
   */
  deferred: DeferredBuild[];
  /** 要回收或摘除的已有规则 */
  reclaim: ReclaimedRule[];
}

/** 写入成功的结果 */
export interface PruneWriteOutcome {
  /** 本次的新规则是否留在了 bucket 上；无需改动时为 false */
  written: boolean;
  /** 写入后回读核对是否一致；没有写入时为 null */
  verified: boolean | null;
  /** 成功时总是 null：核对不符而撤销的情况会以 PruneWriteError 抛出 */
  rolledBack: null;
  /** 外部规则条数不符这类不影响本工具规则安全、只需提示的核对结果 */
  warnings: string[];
  /** 写入请求报了错、但回读确认规则已按原样生效时的报错原因 */
  writeError: string | null;
}

export interface PrunePlanned extends PrunePlanSummary {
  /**
   * 按计划写入规则并回读核对。changed 为 false 时什么都不发。只能调用一次。
   * 写入前会重读 lifecycle 配置：算出计划之后被改过就抛 PlanError（重读失败抛 S3Error），不发写请求。
   * 不会重新探测线上 build，planPrune 之后有部署或回滚的话请重新 planPrune。
   * 写入失败、核对不符（无论撤销成功与否）都抛 PruneWriteError。
   */
  apply(): Promise<PruneWriteOutcome>;
}

/**
 * 写入阶段的失败。message 是完整的多行说明（含补救办法），detail 是一行的原因；
 * 其余字段说明 bucket 此刻处于什么状态。
 */
export class PruneWriteError extends Error {
  readonly detail: string;
  /** 本次的新规则是否（可能）留在了 bucket 上。撤销失败、写入阶段意外出错时为 true，务必手动检查 */
  readonly written: boolean;
  /** 没走到核对（写入请求失败、写入阶段意外出错）时为 null，否则为 false */
  readonly verified: false | null;
  /** 核对不符时是否已撤掉本工具的规则并回读确认；没有发生撤销时为 null */
  readonly rolledBack: boolean | null;
  readonly warnings: string[];

  constructor(
    message: string,
    fields: { detail: string; written: boolean; verified: false | null; rolledBack: boolean | null; warnings: string[] },
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PruneWriteError";
    this.detail = fields.detail;
    this.written = fields.written;
    this.verified = fields.verified;
    this.rolledBack = fields.rolledBack;
    this.warnings = fields.warnings;
  }
}

/** 参数本身不对，还没发出任何请求 */
export class PruneOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PruneOptionsError";
  }
}

/** 把本工具会抛的错误转成一句话 */
export function describeError(error: unknown): string {
  if (error instanceof S3Error) return error.message;
  if (error instanceof CloudflareApiError) return `Cloudflare API ${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function validate(opts: PruneOptions): void {
  const missing: string[] = [];
  if (!opts.bucket) missing.push("bucket");
  if (!opts.endpoint && !opts.accountId) missing.push("accountId 或 endpoint");
  if (!opts.accessKeyId) missing.push("accessKeyId");
  if (!opts.secretAccessKey) missing.push("secretAccessKey");
  if (opts.worker && !opts.apiToken) missing.push("apiToken（给了 worker）");
  if (opts.worker && !opts.accountId) missing.push("accountId（给了 worker，要用它调 Cloudflare API）");
  if (opts.apiToken && !opts.worker) missing.push("worker（给了 apiToken）");
  if (!opts.worker && !opts.siteUrl && !opts.buildIdUrl && (opts.keep ?? []).length === 0) {
    missing.push("worker 与 apiToken（或 siteUrl / buildIdUrl / keep）");
  }
  if (missing.length > 0) throw new PruneOptionsError(`缺少必填项：${missing.join("、")}`);

  const expireDays = opts.expireDays ?? 1;
  if (!Number.isInteger(expireDays) || expireDays < 1) {
    throw new PruneOptionsError(`expireDays 必须是不小于 1 的整数，收到 ${expireDays}`);
  }
  const graceHours = opts.graceHours ?? 24;
  if (!Number.isInteger(graceHours) || graceHours < 0) {
    throw new PruneOptionsError(`graceHours 必须是不小于 0 的整数，收到 ${graceHours}`);
  }
  if (opts.recentBuilds !== undefined) {
    if (!Number.isInteger(opts.recentBuilds) || opts.recentBuilds < 1) {
      throw new PruneOptionsError(`recentBuilds 必须是不小于 1 的整数，收到 ${opts.recentBuilds}`);
    }
    // 没有 worker 就没有近期版本可翻，悄悄忽略会让人以为保住了近几个 build
    if (!opts.worker) throw new PruneOptionsError("recentBuilds 需要配合 worker 与 apiToken 使用");
  }
}

/**
 * 第一阶段：列目录、读规则、探测保留集、算出计划，全部安全校验都在这里做完。只发读请求。
 * 确认计划后调用返回值的 apply() 写入。
 */
export async function planPrune(opts: PruneOptions): Promise<PrunePlanned> {
  validate(opts);
  const prefix = opts.prefix ?? "incremental-cache";
  const expireDays = opts.expireDays ?? 1;
  const graceHours = opts.graceHours ?? 24;
  const recentBuilds = opts.worker ? (opts.recentBuilds ?? 3) : null;

  const store = new R2Store({
    // 用 || 而不是 ??：validate 把空串当作没给，这里也得回退，否则空串 endpoint 会拼出无效 URL
    endpoint: opts.endpoint || `https://${opts.accountId}.r2.cloudflarestorage.com`,
    bucket: opts.bucket,
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    md5Base64: opts.md5Base64,
    fetchImpl: opts.fetch,
    onRetry: opts.onRetry,
  });

  const state = await collectPlan({
    store,
    prefix,
    siteUrl: opts.siteUrl,
    buildIdUrl: opts.buildIdUrl,
    cloudflare:
      opts.worker && opts.apiToken && recentBuilds !== null
        ? {
            api: new CloudflareApi({
              accountId: opts.accountId!,
              apiToken: opts.apiToken,
              fetchImpl: opts.fetch,
              onRetry: opts.onRetry,
            }),
            worker: opts.worker,
            recentBuilds,
          }
        : undefined,
    keep: opts.keep,
    force: opts.force,
    allowRootPrefix: opts.allowRootPrefix,
    expireDays,
    graceHours,
    fetchImpl: opts.fetch,
    onRetry: opts.onRetry,
    onWholeBucketRules: opts.onWholeBucketRules,
  });

  const { plan } = state;
  let applied = false;
  // 只点出本次前缀下的规则：同一个 bucket 上别的站点的规则不归这一趟管，叫人全删会误伤
  const ownRules = `ID 形如 ${ruleId(prefix, "<buildId>")} 的规则`;

  return {
    bucket: opts.bucket,
    prefix,
    expireDays,
    graceHours,
    recentBuilds,
    onlineBuildId: state.onlineBuildId,
    probedFrom: state.probedFrom,
    // online 优先级最高、又必须在 bucket 里（force 硬留的也在 keep 里），所以 keep 里 reason 为 online 的就是全部
    onlineBuildIds: plan.keep.filter((b) => b.reason === "online").map((b) => b.buildId),
    cloudflare: state.cloudflare,
    wholeBucketRules: state.wholeBucketRules,
    changed: plan.changed,
    keep: plan.keep,
    absent: plan.absent,
    expire: plan.expire,
    deferred: plan.deferred,
    reclaim: plan.reclaim,

    async apply() {
      // 第二次写入用的仍是第一次之前读到的配置，回读核对与撤销都会以错误的现状为准
      if (applied) throw new Error("apply() 只能调用一次；要再写入请重新调用 planPrune()。");
      applied = true;
      if (!plan.changed) return { written: false, verified: null, rolledBack: null, warnings: [], writeError: null };
      // 计划按 planPrune 时的配置算出，这之后被改过就不能照着写：会抹掉别人的改动，撤销也会以错误的现状为准
      await assertLifecycleUnchanged(store, state.lifecycle);

      let result: Awaited<ReturnType<typeof writeAndVerify>>;
      try {
        result = await writeAndVerify(store, plan.nextDoc, state.lifecycle);
      } catch (error) {
        if (error instanceof WriteNotAppliedError) {
          // 能确认写入没有生效：bucket 仍是写入前的样子
          const cause = error.cause;
          const detail = describeError(cause);
          // S3Error 自己就写明了「写入 lifecycle 规则失败」，不再重复一遍
          const message = cause instanceof S3Error ? detail : `写入 lifecycle 规则失败：${detail}`;
          throw new PruneWriteError(
            message,
            { detail, written: false, verified: null, rolledBack: null, warnings: [] },
            cause,
          );
        }
        // 约定之外的异常：不知道写入走到了哪一步，新规则可能已经在 bucket 上，只能按「可能已写入」报
        const detail = `写入阶段意外出错，无从确认规则是否已写入：${describeError(error)}`;
        throw new PruneWriteError(
          `${detail}\n请立即用 npx wrangler r2 bucket lifecycle list ${opts.bucket} 检查，` +
            `并手动删除 ${ownRules}，尤其是 prefix 显示为 (all prefixes) 的 —— 它会删掉整个 bucket。`,
          { detail, written: true, verified: null, rolledBack: null, warnings: [] },
          error,
        );
      }

      if (result.readBackError === undefined && result.problems.length === 0) {
        return {
          written: true,
          verified: true,
          rolledBack: null,
          warnings: result.warnings,
          writeError: result.writeError === undefined ? null : describeError(result.writeError),
        };
      }

      const reasons =
        result.readBackError !== undefined
          ? [...result.problems, `写入后读不回配置，无从核对：${describeError(result.readBackError)}`]
          : result.problems;
      const rollback = result.rolledBack
        ? "已撤掉本工具在该前缀下的全部规则并回读确认（其它规则保留），没有任何目录会因此被删。查明原因前不要重跑写入。"
        : `撤掉本工具的规则时失败了：${describeError(result.rollbackError)}\n` +
          `请立即用 npx wrangler r2 bucket lifecycle list ${opts.bucket} 检查，并手动删除 ${ownRules}，` +
          `尤其是 prefix 显示为 (all prefixes) 的 —— 它会删掉整个 bucket。`;
      throw new PruneWriteError(`写入后回读核对失败：\n  ${reasons.join("\n  ")}\n${rollback}`, {
        detail: `写入后回读核对失败：${reasons.join("；")}`,
        // 撤销成功、或能确认写入根本没生效时为 false；其余撤销失败的情况下新规则可能还在
        written: result.written,
        verified: false,
        rolledBack: result.rolledBack,
        warnings: result.warnings,
      });
    },
  };
}

export interface PruneRunOptions extends PruneOptions {
  /** 只算出计划，不写入 */
  dryRun?: boolean;
  /**
   * 写入前的确认，拿到计划后调用，返回 false 即取消。只在需要写入（changed 且非 dryRun）时调用；
   * 不给就直接写入。
   */
  confirm?: (plan: PrunePlanSummary) => boolean | Promise<boolean>;
}

export interface PruneResult extends PrunePlanSummary, PruneWriteOutcome {
  /** confirm 返回了 false */
  cancelled: boolean;
}

/**
 * 一步跑完：算计划 →（确认）→ 写入并回读核对。
 * 校验或探测失败抛对应的错误（PruneOptionsError、PlanError、BuildIdProbeError……），此时没有任何写请求；
 * 写入阶段失败抛 PruneWriteError。
 */
export async function prune(opts: PruneRunOptions): Promise<PruneResult> {
  const { apply, ...summary } = await planPrune(opts);
  const skipped = { written: false, verified: null, rolledBack: null, warnings: [], writeError: null };
  if (!summary.changed || opts.dryRun) return { ...summary, ...skipped, cancelled: false };
  if (opts.confirm && !(await opts.confirm(summary))) return { ...summary, ...skipped, cancelled: true };
  return { ...summary, ...(await apply()), cancelled: false };
}
