#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  BuildIdProbeError,
  CloudflareApiError,
  describeError,
  type ExpireState,
  type KeptBuild,
  PlanError,
  type PrunePlanSummary,
  planPrune,
  PruneOptionsError,
  PruneWriteError,
  S3Error,
  XmlAssumptionError,
} from "./index.ts";
import { MAX_RULES, RESERVED_RULES } from "./plan.ts";
import { normalizePrefix } from "./prefix.ts";
import { plural } from "./text.ts";
import { ruleId } from "./xml.ts";

/** 唯一允许使用 Node 专属 API 的一层：参数、环境变量、终端交互。 */

const USAGE = `Usage: opennext-r2-prune [options]

Attaches lifecycle rules to obsolete OpenNext cache directories in R2, so R2 deletes them in the background within 24 hours.
The tool never walks the cached objects, so the number of files in a directory doesn't affect how long it takes.

Required (environment variables can be used instead):
  --bucket <name>              R2 bucket name              [R2_BUCKET]
  --account-id <id>            Cloudflare account id       [CLOUDFLARE_ACCOUNT_ID]
  --access-key-id <id>         R2 access key id            [R2_ACCESS_KEY_ID / AWS_ACCESS_KEY_ID]
  --secret-access-key <key>    R2 secret access key        [R2_SECRET_ACCESS_KEY / AWS_SECRET_ACCESS_KEY]

Which builds to keep (at least one):
  --worker <name>              Worker name. With --api-token, keeps recent live builds and every preview's build
                                                           [WORKER_NAME]
  --api-token <token>          Cloudflare API token with Workers Scripts read permission
                                                           [CLOUDFLARE_API_TOKEN]
  --url <site URL>             Read the live build id from <site>/BUILD_ID  [SITE_URL]
  --keep <build-id>            Extra build id to keep; can be repeated

Optional:
  --recent-builds <n>          How many distinct recent live builds to keep, default 3 (requires --worker)
  --build-id-url <URL>         Override the URL BUILD_ID is probed from
  --endpoint <URL>             Override the S3 endpoint, derived from the account id by default
  --prefix <prefix>            Cache prefix, default incremental-cache   [NEXT_INC_CACHE_R2_PREFIX]
                               Sites sharing a bucket must each use their own, non-nested prefix; each run only manages rules under its own prefix
  --expire-days <n>            Expiration days of the rules, default 1
  --grace-hours <n>            Don't judge builds obsolete until their directory was written n hours ago, default 24; 0 disables
                               OpenNext writes the cache before shifting traffic, so a new build caught mid-deploy isn't live yet; this protects it.
                               When there aren't enough rule slots and rules go in batches, the oldest by this write time go first; with 0, by build id.
                               Write times aren't read when no slots are left (except when slots can never be freed and the run aborts)
  --dry-run                    Only print the plan, don't write
  --yes, -y                    Skip confirmation. Required in non-interactive environments
  --json                       Print a machine-readable result at the end, after any write (includes written / verified / rolledBack / warnings;
                               deferred lists builds that got no rule for lack of slots; quotaExhausted true means slots can never be freed and rules need manual cleanup)
  --force                      Skip the "kept builds must exist in the bucket" check
  --allow-root-prefix          Acknowledge an empty --prefix (cache stored directly at the bucket root)
  --verbose                    Print extra information such as retries
  --help, -h                   Show this help

Exit codes: 0 success (including builds deferred for lack of rule slots) / 1 invalid options or a failed check (including rule slots that can never be freed) / 2 writing rules failed, or the read-back after writing didn't match (the tool tried to remove its own rules)`;

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      bucket: { type: "string" },
      "account-id": { type: "string" },
      "access-key-id": { type: "string" },
      "secret-access-key": { type: "string" },
      url: { type: "string" },
      keep: { type: "string", multiple: true },
      worker: { type: "string" },
      "api-token": { type: "string" },
      "recent-builds": { type: "string" },
      "build-id-url": { type: "string" },
      endpoint: { type: "string" },
      prefix: { type: "string" },
      "expire-days": { type: "string" },
      "grace-hours": { type: "string" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      force: { type: "boolean" },
      "allow-root-prefix": { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  }).values;
}

async function main(argv: string[]): Promise<number> {
  let values: ReturnType<typeof parseCliArgs>;
  try {
    values = parseCliArgs(argv);
  } catch (error) {
    // 未知开关、缺参数值等：报结论加用法。这类是 parseArgs 抛的原生 TypeError，
    // 不在文件末尾那张「预期内失败」清单里，漏在这儿就会变成一段 Node 堆栈。
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 1;
  }

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const env = process.env;
  const bucket = values.bucket ?? env.R2_BUCKET;
  const accountId = values["account-id"] ?? env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = values["access-key-id"] ?? env.R2_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    values["secret-access-key"] ?? env.R2_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  const siteUrl = values.url ?? env.SITE_URL;
  const prefix = values.prefix ?? env.NEXT_INC_CACHE_R2_PREFIX ?? "incremental-cache";
  const endpoint = values.endpoint ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  const keep = values.keep ?? [];
  const worker = values.worker ?? env.WORKER_NAME;
  const apiToken = values["api-token"] ?? env.CLOUDFLARE_API_TOKEN;
  const json = values.json ?? false;

  const missing: string[] = [];
  if (!bucket) missing.push("--bucket");
  if (!endpoint) missing.push("--account-id or --endpoint");
  if (!accessKeyId) missing.push("--access-key-id");
  if (!secretAccessKey) missing.push("--secret-access-key");
  // WORKER_NAME 是个很泛的名字，CI 里可能是别的步骤设的：报错要说清楚 --worker 模式是被谁打开的
  const workerFrom = values.worker ? "--worker" : `the environment variable WORKER_NAME=${worker}`;
  if (worker && !apiToken) {
    missing.push(
      `--api-token (${workerFrom} turned on --worker mode${values.worker ? "" : "; unset that variable if you don't mean to use it"})`,
    );
  }
  // 只查命令行显式给的：CLOUDFLARE_API_TOKEN 在 CI 里常常是给 wrangler deploy 准备的，
  // 只用 --url 的人环境里带着它不该被拦下
  if (values["api-token"] && !worker) missing.push("--worker (--api-token was given)");
  if (worker && !accountId) missing.push(`--account-id (${workerFrom} needs it to call the Cloudflare API)`);
  if (!worker && !siteUrl && !values["build-id-url"] && keep.length === 0) {
    missing.push("--worker and --api-token (or --url / --build-id-url / --keep)");
  }
  if (missing.length > 0) {
    console.error(`Missing required options: ${missing.join(", ")}\n\n${USAGE}`);
    return 1;
  }

  const expireDays = Number(values["expire-days"] ?? 1);
  if (!Number.isInteger(expireDays) || expireDays < 1) {
    console.error("--expire-days must be an integer of at least 1");
    return 1;
  }

  // 只认纯数字：Number() 会把 "0x3"、"1e1"、" 3 " 都当成合法整数；位数太多会变成不精确的数或 Infinity，
  // 漏到库的校验就会按选项名 graceHours / recentBuilds 报错
  const graceHoursRaw = values["grace-hours"] ?? "24";
  const graceHours = Number(graceHoursRaw);
  if (!/^\d+$/.test(graceHoursRaw) || !Number.isSafeInteger(graceHours)) {
    console.error("--grace-hours must be an integer of at least 0");
    return 1;
  }

  const recentBuildsRaw = values["recent-builds"] ?? "3";
  const recentBuilds = Number(recentBuildsRaw);
  if (!/^\d+$/.test(recentBuildsRaw) || !Number.isSafeInteger(recentBuilds) || recentBuilds < 1) {
    console.error("--recent-builds must be an integer of at least 1");
    return 1;
  }
  // 没有 --worker 就没有近期版本可翻，悄悄忽略会让人以为保住了近几个 build
  if (values["recent-builds"] !== undefined && !worker) {
    console.error("--recent-builds requires --worker and --api-token");
    return 1;
  }

  const onRetry = values.verbose
    ? (attempt: number, reason: string) => console.error(`  Retry ${attempt}: ${reason}`)
    : undefined;

  const planned = await planPrune({
    bucket: bucket!,
    accountId,
    endpoint: endpoint!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    worker,
    // 环境变量里的 CLOUDFLARE_API_TOKEN 可能是给 wrangler 准备的，没开 --worker 时不能传下去：
    // 库的校验见到 apiToken 就要求 worker，会把只用 --url 的人拦下
    apiToken: worker ? apiToken : undefined,
    recentBuilds: worker ? recentBuilds : undefined,
    siteUrl,
    buildIdUrl: values["build-id-url"],
    keep,
    prefix,
    expireDays,
    graceHours,
    force: values.force,
    allowRootPrefix: values["allow-root-prefix"],
    // Web Crypto 没有 MD5，而 S3 规范要求 PutBucketLifecycleConfiguration 带上它
    md5Base64: (body) => createHash("md5").update(body, "utf8").digest("base64"),
    onRetry,
    // 在探测之前就报：探测或校验失败时整趟中止，这条警告是用户唯一能看到它的地方
    onWholeBucketRules: (ruleIds) => {
      const one = ruleIds.length === 1;
      console.error(
        `\n⚠️ Warning: ${plural(ruleIds.length, "rule")} written by this tool ${one ? "has" : "have"} no <Filter><Prefix>` +
          ` (missing, or only a bare <Prefix> that R2 ignores), so ${one ? "it applies" : "they apply"} to the whole bucket: ${ruleIds.join(", ")}.\n` +
          `R2 will use ${one ? "it" : "them"} to delete every object in the bucket. A successful write in this run only rewrites those under the current prefix (${ruleId(prefix, "<buildId>")}); ` +
          `for those under other prefixes, or if this run aborts or is only a --dry-run, ` +
          `check them right away with npx wrangler r2 bucket lifecycle list ${bucket} and delete them manually.`,
      );
    },
  });

  // --json 时 stdout 只放最后那一份 JSON，人类可读的内容一律改走 stderr
  const note = (message: string) => (json ? console.error(message) : console.log(message));

  if (!json) printPlan(planned);
  // deployment 翻完了还凑不够名额时不能悄悄少保留：回滚目标可能就在被判作废的那几个里
  if (planned.cloudflare && planned.cloudflare.recentBuilds < recentBuilds) {
    console.error(
      `\nNote: only found ${plural(planned.cloudflare.recentBuilds, "distinct recent live build")} (--recent-builds is ${recentBuilds}) ` +
        `after going through ${planned.cloudflare.deploymentsScanned === 1 ? "the only deployment" : `all ${planned.cloudflare.deploymentsScanned} deployments`}. Older builds will be judged obsolete; ` +
        `keep the ones you need explicitly with --keep.`,
    );
  }

  /**
   * 本次的新规则是否留在了 bucket 上：核对不过但已撤销确认时为 false；撤销失败时为 true（可能还在），
   * 除非能确认写入本身就没生效
   */
  let written = false;
  /** 写入后回读核对是否一致：没有写入时为 null；读不回来、无从核对也算 false */
  let verified: boolean | null = null;
  /** 核对不过时是否已撤掉本工具的规则并回读确认；没有发生撤销时为 null */
  let rolledBack: boolean | null = null;
  /** 不影响本工具规则安全、只需提示的核对结果（外部规则条数不符） */
  let warnings: string[] = [];
  let cancelled = false;
  let failure: string | undefined;
  let code = 0;

  if (!planned.changed) {
    note(
      planned.deferred.length > 0
        ? "\nNot enough rule slots, so nothing to change this time; deferred builds get rules once a later run reclaims rules and frees slots."
        : "\nRules are already up to date, no changes needed.",
    );
  } else if (values["dry-run"]) {
    note("\n--dry-run: nothing was written.");
  } else if (!values.yes && !process.stdin.isTTY) {
    console.error("\nIn a non-interactive environment, pass --yes explicitly to write the rules.");
    code = 1;
  } else if (!values.yes && !(await confirm())) {
    cancelled = true;
    note("Cancelled.");
  } else {
    try {
      const outcome = await planned.apply();
      ({ written, verified, warnings } = outcome);
      for (const warning of warnings) {
        console.error(`\nNote: ${warning}. This tool's rules verified correctly, but check that your own lifecycle rules are intact.`);
      }
      if (outcome.writeError !== null) {
        console.error(`\nNote: the write request errored (${outcome.writeError}), but reading back confirmed the rules took effect as written.`);
      }
      const added = planned.expire.filter((b) => b.state === "new").length;
      const updated = planned.expire.filter((b) => b.state === "updated").length;
      note(
        `\nRules written and verified by reading back: ${added} added, ${updated} updated, rules reclaimed for ${plural(planned.reclaim.length, "build")}.` +
          `\nR2 usually finishes deleting these directories within 24 hours; the next run reclaims the finished rules automatically.` +
          (planned.deferred.length > 0 && !planned.quotaExhausted
            ? `\n${plural(planned.deferred.length, "more obsolete build")} got no rule for lack of rule slots; a later run attaches the rules once slots are freed.`
            : ""),
      );
      if (planned.quotaExhausted) console.error(`\nNote: ${quotaExhaustedNote(planned.deferred.length)}`);
    } catch (error) {
      if (!(error instanceof PruneWriteError)) throw error;
      ({ written, verified, rolledBack, warnings } = error);
      for (const warning of warnings) {
        console.error(`\nNote: ${warning}; check that your own lifecycle rules are intact.`);
      }
      failure = error.detail;
      console.error(`\n${error.message}`);
      code = 2;
    }
  }

  // 写完再输出，这样 written 反映的是真实结果而不只是意图
  if (json) {
    console.log(
      JSON.stringify(
        {
          ...toJson(planned),
          expireDays,
          written,
          verified,
          rolledBack,
          warnings,
          cancelled,
          error: failure ?? null,
        },
        null,
        2,
      ),
    );
  }
  return code;
}

const EXPIRE_NOTE: Record<ExpireState, string> = {
  new: "new rule",
  updated: "rewritten rule (the old rule didn't match the current prefix / expiration, or was duplicated)",
  pending: "rule already exists, R2 is still deleting",
};

const KEEP_NOTE: Record<KeptBuild["reason"], string> = {
  online: "live",
  recent: "recent live",
  preview: "preview",
  explicit: "given with --keep",
  fresh: "just written, not judged obsolete yet",
};

function keepNote(build: KeptBuild): string {
  return build.source ? `${KEEP_NOTE[build.reason]} (${build.source})` : KEEP_NOTE[build.reason];
}

function printPlan(plan: PrunePlanSummary): void {
  console.log(`bucket: ${plan.bucket}    prefix: ${normalizePrefix(plan.prefix) || "(bucket root)"}`);
  if (plan.onlineBuildId) {
    console.log(`Live BUILD_ID: ${plan.onlineBuildId}  (read from ${plan.probedFrom})`);
  }
  // 同时给了 --url 与 --worker 时，最新 deployment 里还可能有别的线上 build（灰度）
  const fromDeployment = plan.onlineBuildIds.filter((id) => id !== plan.onlineBuildId);
  if (fromDeployment.length > 0) {
    console.log(
      `${plan.onlineBuildId ? "Other live" : "Live"} BUILD_ID: ${fromDeployment.join(", ")}  (read from the latest deployment)`,
    );
  }
  if (plan.cloudflare) {
    console.log(
      `Cloudflare: looked through the latest ${plural(plan.cloudflare.deploymentsScanned, "deployment")}, ` +
        `${plural(plan.cloudflare.previews, "preview")} in total`,
    );
  }

  console.log(`\nKeeping ${plural(plan.keep.length, "build")}:`);
  for (const build of plan.keep) {
    console.log(`  keep      ${build.buildId}  ${keepNote(build)}`);
  }

  if (plan.absent.length > 0) {
    console.log(`\nThese builds to keep aren't in the bucket, nothing to do:`);
    for (const build of plan.absent) {
      console.log(`  skip      ${build.buildId}  ${keepNote(build)}`);
    }
  }

  if (plan.expire.length > 0) {
    console.log(`\nHanding ${plural(plan.expire.length, "build")} to R2 for deletion:`);
    for (const build of plan.expire) {
      console.log(`  delete    ${build.buildId}  ${EXPIRE_NOTE[build.state]}`);
    }
  }

  if (plan.deferred.length > 0) {
    console.log(
      `\nNot enough lifecycle rule slots (R2 allows at most ${MAX_RULES} per bucket; this tool normally leaves ${RESERVED_RULES} spare for your own rules, ` +
        `filling all ${MAX_RULES} only when your own rules plus other prefixes' rules whose directories are empty but not reclaimed have eaten into that margin), ` +
        `so no rule is attached this time to the following ${plural(plan.deferred.length, "build")} outside the keep set (with no slots left, write times may not have been read, so freshly written builds may be listed here too):`,
    );
    if (plan.quotaExhausted) {
      for (const build of plan.deferred) console.log(`  defer     ${build.buildId}  slots can never be freed, rules need manual cleanup`);
      console.log(`  ${quotaExhaustedNote(plan.deferred.length)}`);
    } else {
      for (const build of plan.deferred) console.log(`  defer     ${build.buildId}  not enough slots, a later run attaches it`);
      console.log(
        `  Once R2 finishes deleting the directories that have rules, later runs reclaim those rules and free slots, attaching the rest round by round. ` +
          `Slots held by this tool's rules for other prefixes wait for that prefix's run to reclaim them; rules left by an old prefix from before a --prefix change are never reclaimed and must be deleted manually.`,
      );
    }
  }

  const revived = plan.reclaim.filter((r) => r.reason === "revived");
  const emptied = plan.reclaim.filter((r) => r.reason === "emptied");

  if (emptied.length > 0) {
    console.log(`\nReclaiming finished rules for ${plural(emptied.length, "build")}:`);
    for (const rule of emptied) console.log(`  reclaim   ${rule.buildId}  directory is empty`);
  }

  if (revived.length > 0) {
    console.log(`\nWarning: these builds have deletion rules but must be kept; the rules will be removed right away:`);
    for (const rule of revived) console.log(`  remove    ${rule.buildId}`);
    console.log(
      `  This usually happens after rolling back to an old build. R2 may already have deleted part of its cache before the removal; ` +
        `those pages will be re-rendered from the origin on their next visit.`,
    );
  }
}

function toJson(plan: PrunePlanSummary) {
  const online = plan.onlineBuildIds;
  return {
    prefix: plan.prefix,
    graceHours: plan.graceHours,
    // 只走 --worker 时也要有值；灰度中线上不止一个 build，单个字段说不清，看 onlineBuildIds
    onlineBuildId: plan.onlineBuildId ?? (online.length === 1 ? online[0] : null),
    onlineBuildIds: online,
    cloudflare: plan.cloudflare,
    // 运行前就已对整个 bucket 生效（前缀为空）的本工具规则的 ID，含别的前缀下的、ID 格式不对的。只有当前前缀下的
    // 会在写入成功时被改写，别的前缀下的得手动删除
    wholeBucketRules: plan.wholeBucketRules,
    changed: plan.changed,
    // keep 仍是完整的保留集；其中不在 bucket 里的另见 absent
    keep: [...plan.keep, ...plan.absent],
    absent: plan.absent,
    expire: plan.expire,
    // 名额不够、这次没挂规则的作废 build，不在 expire 里，也不算保留
    deferred: plan.deferred,
    quotaExhausted: plan.quotaExhausted,
    reclaim: plan.reclaim,
  };
}

/** 名额永远空不出来、但这趟仍有别的改动要写时的提示：推迟的 build 不会自己挂上，下一趟没别的可写时会中止 */
function quotaExhaustedNote(deferred: number): string {
  return (
    `Your own rules plus rules nobody will reclaim (most likely written for an old prefix before a --prefix change, with directories already empty) fill all ${MAX_RULES} slots, ` +
    `so slots can never be freed and ${plural(deferred, "deferred build")} will never get rules however many runs you wait; the next run with nothing else to write will abort (exit code 1). ` +
    `Find the rules you no longer need with npx wrangler r2 bucket lifecycle list <bucket>, delete them manually, and run again once slots are freed.`
  );
}

async function confirm(): Promise<boolean> {
  // 提示走 stderr，免得把 --json 的 stdout 弄脏
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question("\nWrite the rules above? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // 这几类是「预期内的失败」，只报结论，不甩堆栈
  if (
    error instanceof PlanError ||
    error instanceof BuildIdProbeError ||
    error instanceof XmlAssumptionError ||
    error instanceof CloudflareApiError ||
    error instanceof S3Error ||
    error instanceof PruneOptionsError
  ) {
    console.error(describeError(error));
    process.exitCode = 1;
  } else {
    throw error;
  }
}
