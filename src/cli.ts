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
import { ruleId } from "./xml.ts";

/** 唯一允许使用 Node 专属 API 的一层：参数、环境变量、终端交互。 */

const USAGE = `用法：opennext-r2-prune [选项]

给 R2 里作废的 OpenNext 缓存目录挂上 lifecycle 规则，由 R2 在 24 小时内后台删除。
本工具不遍历缓存对象，所以目录里有多少个文件都不影响耗时。

必填（可用环境变量代替）：
  --bucket <名字>              R2 bucket 名                [R2_BUCKET]
  --account-id <id>            Cloudflare account id       [CLOUDFLARE_ACCOUNT_ID]
  --access-key-id <id>         R2 access key id            [R2_ACCESS_KEY_ID / AWS_ACCESS_KEY_ID]
  --secret-access-key <key>    R2 secret access key        [R2_SECRET_ACCESS_KEY / AWS_SECRET_ACCESS_KEY]

保留哪些 build（至少给一种）：
  --worker <名字>               Worker 名。配合 --api-token，保留近期线上与全部预览的 build
                                                           [WORKER_NAME]
  --api-token <token>          Cloudflare API token，需 Workers Scripts 读权限
                                                           [CLOUDFLARE_API_TOKEN]
  --url <站点地址>              从 <站点>/BUILD_ID 读线上 build id  [SITE_URL]
  --keep <build-id>            额外保留的 build id，可重复传

可选：
  --recent-builds <n>          保留最近几个不同的线上 build，默认 3（需 --worker）
  --build-id-url <地址>         覆盖 BUILD_ID 的探测地址
  --endpoint <地址>             覆盖 S3 endpoint，默认按 account id 拼
  --prefix <前缀>               缓存前缀，默认 incremental-cache   [NEXT_INC_CACHE_R2_PREFIX]
                               多个站点共用一个 bucket 时必须各用各的、互不嵌套的前缀，每趟只管自己前缀下的规则
  --expire-days <n>            规则的过期天数，默认 1
  --grace-hours <n>            目录写入不满 n 小时的 build 不判作废，默认 24；0 关闭
                               OpenNext 部署时先写缓存再切流量，正赶上部署时新 build 还没上线，靠它保住。
                               规则名额不够、要分批挂时，也按这里读到的写入时间先挂最老的；为 0 时按 build id 挑。
                               名额一条不剩时不读写入时间（名额永远空不出来、要中止时照读）
  --dry-run                    只打印计划，不写入
  --yes, -y                    跳过确认。非交互环境下必须显式传
  --json                       输出机器可读的结果（写入之后才输出，含 written / verified / rolledBack / warnings 字段；
                               deferred 是规则名额不够、这次没挂规则的 build；quotaExhausted 为 true 时名额永远空不出来，要手动清理规则）
  --force                      跳过「保留的 build 必须存在于 bucket」这项检查
  --allow-root-prefix          承认 --prefix 为空（缓存直接放在 bucket 根下）
  --verbose                    打印重试等额外信息
  --help, -h                   显示本帮助

退出码：0 成功（有 build 因规则名额不够推迟也算）/ 1 参数或校验失败（含规则名额永远空不出来） / 2 写入规则失败，或写入后回读核对不符（已尝试撤掉本工具的规则）`;

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
  if (!endpoint) missing.push("--account-id 或 --endpoint");
  if (!accessKeyId) missing.push("--access-key-id");
  if (!secretAccessKey) missing.push("--secret-access-key");
  // WORKER_NAME 是个很泛的名字，CI 里可能是别的步骤设的：报错要说清楚 --worker 模式是被谁打开的
  const workerFrom = values.worker ? "--worker" : `环境变量 WORKER_NAME=${worker}`;
  if (worker && !apiToken) {
    missing.push(
      `--api-token（${workerFrom} 开启了 --worker 模式${values.worker ? "" : "；不打算用它就清掉这个变量"}）`,
    );
  }
  // 只查命令行显式给的：CLOUDFLARE_API_TOKEN 在 CI 里常常是给 wrangler deploy 准备的，
  // 只用 --url 的人环境里带着它不该被拦下
  if (values["api-token"] && !worker) missing.push("--worker（给了 --api-token）");
  if (worker && !accountId) missing.push(`--account-id（${workerFrom} 要用它调 Cloudflare API）`);
  if (!worker && !siteUrl && !values["build-id-url"] && keep.length === 0) {
    missing.push("--worker 与 --api-token（或 --url / --build-id-url / --keep）");
  }
  if (missing.length > 0) {
    console.error(`缺少必填项：${missing.join("、")}\n\n${USAGE}`);
    return 1;
  }

  const expireDays = Number(values["expire-days"] ?? 1);
  if (!Number.isInteger(expireDays) || expireDays < 1) {
    console.error("--expire-days 必须是不小于 1 的整数");
    return 1;
  }

  // 只认纯数字：Number() 会把 "0x3"、"1e1"、" 3 " 都当成合法整数；位数太多会变成不精确的数或 Infinity，
  // 漏到库的校验就会按选项名 graceHours / recentBuilds 报错
  const graceHoursRaw = values["grace-hours"] ?? "24";
  const graceHours = Number(graceHoursRaw);
  if (!/^\d+$/.test(graceHoursRaw) || !Number.isSafeInteger(graceHours)) {
    console.error("--grace-hours 必须是不小于 0 的整数");
    return 1;
  }

  const recentBuildsRaw = values["recent-builds"] ?? "3";
  const recentBuilds = Number(recentBuildsRaw);
  if (!/^\d+$/.test(recentBuildsRaw) || !Number.isSafeInteger(recentBuilds) || recentBuilds < 1) {
    console.error("--recent-builds 必须是不小于 1 的整数");
    return 1;
  }
  // 没有 --worker 就没有近期版本可翻，悄悄忽略会让人以为保住了近几个 build
  if (values["recent-builds"] !== undefined && !worker) {
    console.error("--recent-builds 需要配合 --worker 与 --api-token 使用");
    return 1;
  }

  const onRetry = values.verbose
    ? (attempt: number, reason: string) => console.error(`  第 ${attempt} 次重试：${reason}`)
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
    onWholeBucketRules: (ruleIds) =>
      console.error(
        `\n⚠️ 警告：bucket 上有 ${ruleIds.length} 条本工具的规则没有 <Filter><Prefix> 前缀` +
          `（缺失，或只有 R2 不认的裸 <Prefix>），会对整个 bucket 生效：${ruleIds.join(", ")}。\n` +
          `R2 会按它删掉 bucket 里的全部对象。本次运行写入成功只会改写当前前缀（${ruleId(prefix, "<buildId>")}）下的；` +
          `别的前缀下的、或本次中止、只是 --dry-run 时，` +
          `请立即用 npx wrangler r2 bucket lifecycle list ${bucket} 核对并手动删除这些规则。`,
      ),
  });

  // --json 时 stdout 只放最后那一份 JSON，人类可读的内容一律改走 stderr
  const note = (message: string) => (json ? console.error(message) : console.log(message));

  if (!json) printPlan(planned);
  // deployment 翻完了还凑不够名额时不能悄悄少保留：回滚目标可能就在被判作废的那几个里
  if (planned.cloudflare && planned.cloudflare.recentBuilds < recentBuilds) {
    console.error(
      `\n注意：只凑到 ${planned.cloudflare.recentBuilds} 个不同的近期线上 build（--recent-builds 为 ${recentBuilds}），` +
        `全部 ${planned.cloudflare.deploymentsScanned} 次部署已经翻完。更早的 build 会被判作废，` +
        `需要保留的请用 --keep 显式指定。`,
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
        ? "\n规则名额不够，本次无需改动；推迟的 build 等之后的运行回收规则、空出名额后再挂。"
        : "\n规则已经是最新的，无需改动。",
    );
  } else if (values["dry-run"]) {
    note("\n--dry-run：未写入任何改动。");
  } else if (!values.yes && !process.stdin.isTTY) {
    console.error("\n非交互环境下需要显式传 --yes 才会写入规则。");
    code = 1;
  } else if (!values.yes && !(await confirm())) {
    cancelled = true;
    note("已取消。");
  } else {
    try {
      const outcome = await planned.apply();
      ({ written, verified, warnings } = outcome);
      for (const warning of warnings) {
        console.error(`\n注意：${warning}。本工具的规则核对无误，但请检查你自己的 lifecycle 规则是否完好。`);
      }
      if (outcome.writeError !== null) {
        console.error(`\n注意：写入请求报错（${outcome.writeError}），但回读确认规则已按原样生效。`);
      }
      const added = planned.expire.filter((b) => b.state === "new").length;
      const updated = planned.expire.filter((b) => b.state === "updated").length;
      note(
        `\n已写入规则并回读核对无误：新增 ${added} 条，更新 ${updated} 条，回收 ${planned.reclaim.length} 个 build 的规则。` +
          `\nR2 通常会在 24 小时内删完这些目录，下次运行会自动回收已完成的规则。` +
          (planned.deferred.length > 0 && !planned.quotaExhausted
            ? `\n另有 ${planned.deferred.length} 个作废 build 因规则名额不够没有挂规则，之后的运行空出名额后再挂。`
            : ""),
      );
      if (planned.quotaExhausted) console.error(`\n注意：${quotaExhaustedNote(planned.deferred.length)}`);
    } catch (error) {
      if (!(error instanceof PruneWriteError)) throw error;
      ({ written, verified, rolledBack, warnings } = error);
      for (const warning of warnings) {
        console.error(`\n注意：${warning}，请检查你自己的 lifecycle 规则是否完好。`);
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
  new: "新增规则",
  updated: "改写规则（原规则与当前前缀 / 过期设置不符，或有重复）",
  pending: "规则已存在，R2 仍在删",
};

const KEEP_NOTE: Record<KeptBuild["reason"], string> = {
  online: "线上正在使用",
  recent: "近期线上",
  preview: "预览",
  explicit: "--keep 指定",
  fresh: "刚写入，暂不判作废",
};

function keepNote(build: KeptBuild): string {
  return build.source ? `${KEEP_NOTE[build.reason]}（${build.source}）` : KEEP_NOTE[build.reason];
}

function printPlan(plan: PrunePlanSummary): void {
  console.log(`bucket: ${plan.bucket}    前缀: ${normalizePrefix(plan.prefix) || "（bucket 根）"}`);
  if (plan.onlineBuildId) {
    console.log(`线上 BUILD_ID: ${plan.onlineBuildId}  （读自 ${plan.probedFrom}）`);
  }
  // 同时给了 --url 与 --worker 时，最新 deployment 里还可能有别的线上 build（灰度）
  const fromDeployment = plan.onlineBuildIds.filter((id) => id !== plan.onlineBuildId);
  if (fromDeployment.length > 0) {
    console.log(
      `${plan.onlineBuildId ? "另有" : ""}线上 BUILD_ID: ${fromDeployment.join(", ")}  （读自最新的 deployment）`,
    );
  }
  if (plan.cloudflare) {
    console.log(
      `Cloudflare：翻看了最近 ${plan.cloudflare.deploymentsScanned} 次部署，` +
        `共 ${plan.cloudflare.previews} 个预览`,
    );
  }

  console.log(`\n保留 ${plan.keep.length} 个 build：`);
  for (const build of plan.keep) {
    console.log(`  保留  ${build.buildId}  ${keepNote(build)}`);
  }

  if (plan.absent.length > 0) {
    console.log(`\n以下要保留的 build 不在 bucket 里，无需处理：`);
    for (const build of plan.absent) {
      console.log(`  跳过  ${build.buildId}  ${keepNote(build)}`);
    }
  }

  if (plan.expire.length > 0) {
    console.log(`\n交给 R2 删除 ${plan.expire.length} 个 build：`);
    for (const build of plan.expire) {
      console.log(`  删除  ${build.buildId}  ${EXPIRE_NOTE[build.state]}`);
    }
  }

  if (plan.deferred.length > 0) {
    console.log(
      `\nlifecycle 规则名额不够（R2 每个 bucket 最多 ${MAX_RULES} 条；本工具挂规则时一般给你自己的规则留 ${RESERVED_RULES} 条余量，` +
        `你自己的规则加上别的前缀下目录已删空、却没被回收的规则已经挤进这段余量时才挂满 ${MAX_RULES} 条），` +
        `以下 ${plan.deferred.length} 个保留集之外的 build 这次不挂规则（名额一条不剩时可能没读写入时间，刚写入的也可能列在这里）：`,
    );
    if (plan.quotaExhausted) {
      for (const build of plan.deferred) console.log(`  推迟  ${build.buildId}  名额永远空不出来，要手动清理规则`);
      console.log(`  ${quotaExhaustedNote(plan.deferred.length)}`);
    } else {
      for (const build of plan.deferred) console.log(`  推迟  ${build.buildId}  名额不够，之后的运行再挂`);
      console.log(
        `  R2 删完已挂规则的目录后，之后的运行会回收那些规则、空出名额，逐轮挂完。名额若被本工具为别的前缀写的规则占着，` +
          `要等那个前缀的运行回收；改 --prefix 前留下的旧前缀规则不会自己回收，得手动删掉。`,
      );
    }
  }

  const revived = plan.reclaim.filter((r) => r.reason === "revived");
  const emptied = plan.reclaim.filter((r) => r.reason === "emptied");

  if (emptied.length > 0) {
    console.log(`\n回收 ${emptied.length} 个 build 的已完成规则：`);
    for (const rule of emptied) console.log(`  回收  ${rule.buildId}  目录已空`);
  }

  if (revived.length > 0) {
    console.log(`\n警告：以下 build 带着删除规则却又要保留，规则将被立即摘除：`);
    for (const rule of revived) console.log(`  摘除  ${rule.buildId}`);
    console.log(
      `  这通常发生在回滚到旧 build 之后。摘除前 R2 可能已经删掉了它的部分缓存，` +
        `那些页面会在下次访问时回源重新渲染。`,
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
    `你自己的规则加上没人回收的规则（多半是改 --prefix 前的旧前缀写的、目录已经删空的）已经占满 ${MAX_RULES} 条，` +
    `名额永远空不出来，这 ${deferred} 个推迟的 build 等多少轮也挂不上；下一趟没有别的改动可写时会中止（退出码 1）。` +
    `请用 npx wrangler r2 bucket lifecycle list <bucket> 找出不再需要的规则手动删掉，空出名额后重跑。`
  );
}

async function confirm(): Promise<boolean> {
  // 提示走 stderr，免得把 --json 的 stdout 弄脏
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question("\n写入以上规则？[y/N] ");
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
