import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { BuildIdProbeError } from "./build-id.ts";
import { type ExpireState, PlanError, type PrunePlan } from "./plan.ts";
import { normalizePrefix } from "./prefix.ts";
import { R2Store, S3Error } from "./store.ts";
import { collectPlan } from "./run.ts";
import { XmlAssumptionError } from "./xml.ts";

/** 唯一允许使用 Node 专属 API 的一层：参数、环境变量、终端交互。 */

const USAGE = `用法：opennext-r2-prune [选项]

给 R2 里作废的 OpenNext 缓存目录挂上 lifecycle 规则，由 R2 在 24 小时内后台删除。
本工具不列举缓存对象，所以目录里有多少个文件都不影响耗时。

必填（可用环境变量代替）：
  --bucket <名字>              R2 bucket 名                [R2_BUCKET]
  --account-id <id>            Cloudflare account id       [CLOUDFLARE_ACCOUNT_ID]
  --access-key-id <id>         R2 access key id            [R2_ACCESS_KEY_ID / AWS_ACCESS_KEY_ID]
  --secret-access-key <key>    R2 secret access key        [R2_SECRET_ACCESS_KEY / AWS_SECRET_ACCESS_KEY]
  --url <站点地址>              从 <站点>/BUILD_ID 读线上 build id  [SITE_URL]
                               传了 --keep 就不是必填

可选：
  --keep <build-id>            额外保留的 build id，可重复传
  --build-id-url <地址>         覆盖 BUILD_ID 的探测地址
  --endpoint <地址>             覆盖 S3 endpoint，默认按 account id 拼
  --prefix <前缀>               缓存前缀，默认 incremental-cache   [NEXT_INC_CACHE_R2_PREFIX]
  --expire-days <n>            规则的过期天数，默认 1
  --lifecycle-style <式样>      filter（默认）或 bare，规则里 Prefix 的包装形式
  --dry-run                    只打印计划，不写入
  --yes, -y                    跳过确认。非交互环境下必须显式传
  --json                       输出机器可读的结果（写入之后才输出，含 written 字段）
  --force                      跳过「保留的 build 必须存在于 bucket」这项检查
  --allow-root-prefix          承认 --prefix 为空（缓存直接放在 bucket 根下）
  --verbose                    打印重试等额外信息
  --help, -h                   显示本帮助

退出码：0 成功 / 1 参数或校验失败 / 2 写入规则失败`;

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
      "build-id-url": { type: "string" },
      endpoint: { type: "string" },
      prefix: { type: "string" },
      "expire-days": { type: "string" },
      "lifecycle-style": { type: "string" },
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
  const json = values.json ?? false;

  const missing: string[] = [];
  if (!bucket) missing.push("--bucket");
  if (!endpoint) missing.push("--account-id 或 --endpoint");
  if (!accessKeyId) missing.push("--access-key-id");
  if (!secretAccessKey) missing.push("--secret-access-key");
  if (!siteUrl && !values["build-id-url"] && keep.length === 0) {
    missing.push("--url（或 --build-id-url / --keep）");
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

  const style = values["lifecycle-style"] ?? "filter";
  if (style !== "filter" && style !== "bare") {
    console.error("--lifecycle-style 只能是 filter 或 bare");
    return 1;
  }

  const store = new R2Store({
    endpoint: endpoint!,
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    // Web Crypto 没有 MD5，而 S3 规范要求 PutBucketLifecycleConfiguration 带上它
    md5Base64: (body) => createHash("md5").update(body, "utf8").digest("base64"),
    onRetry: values.verbose
      ? (attempt, reason) => console.error(`  第 ${attempt} 次重试：${reason}`)
      : undefined,
  });

  const state = await collectPlan({
    store,
    prefix,
    siteUrl,
    buildIdUrl: values["build-id-url"],
    keep,
    force: values.force,
    allowRootPrefix: values["allow-root-prefix"],
    expireDays,
    style,
  });

  const { plan } = state;
  // --json 时 stdout 只放最后那一份 JSON，人类可读的内容一律改走 stderr
  const note = (message: string) => (json ? console.error(message) : console.log(message));

  if (!json) printPlan(state.onlineBuildId, state.probedFrom, bucket!, prefix, plan);

  let written = false;
  let cancelled = false;
  let failure: string | undefined;
  let code = 0;

  if (!plan.changed) {
    note("\n规则已经是最新的，无需改动。");
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
      await store.putLifecycle(plan.nextDoc);
      written = true;
      const added = plan.expire.filter((b) => b.state === "new").length;
      const updated = plan.expire.filter((b) => b.state === "updated").length;
      note(
        `\n已写入规则：新增 ${added} 条，更新 ${updated} 条，回收 ${plan.reclaim.length} 条。` +
          `\nR2 通常会在 24 小时内删完这些目录，下次运行会自动回收已完成的规则。`,
      );
    } catch (error) {
      failure = describe(error);
      console.error(`\n写入 lifecycle 规则失败：${failure}`);
      code = 2;
    }
  }

  // 写完再输出，这样 written 反映的是真实结果而不只是意图
  if (json) {
    console.log(
      JSON.stringify(
        {
          ...toJson(state.onlineBuildId, prefix, plan),
          expireDays,
          style,
          written,
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
  updated: "改写规则（原规则与当前前缀 / 过期设置不符）",
  pending: "规则已存在，R2 仍在删",
};

function printPlan(
  onlineBuildId: string | null,
  probedFrom: string | null,
  bucket: string,
  prefix: string,
  plan: PrunePlan,
): void {
  console.log(`bucket: ${bucket}    前缀: ${normalizePrefix(prefix) || "（bucket 根）"}`);
  if (onlineBuildId) console.log(`线上 BUILD_ID: ${onlineBuildId}  （读自 ${probedFrom}）`);

  console.log(`\n保留 ${plan.keep.length} 个 build：`);
  for (const build of plan.keep) {
    const why = build.reason === "online" ? "线上正在使用" : "--keep 指定";
    console.log(`  保留  ${build.buildId}  ${why}`);
  }

  if (plan.expire.length > 0) {
    console.log(`\n交给 R2 删除 ${plan.expire.length} 个 build：`);
    for (const build of plan.expire) {
      console.log(`  删除  ${build.buildId}  ${EXPIRE_NOTE[build.state]}`);
    }
  }

  const revived = plan.reclaim.filter((r) => r.reason === "revived");
  const emptied = plan.reclaim.filter((r) => r.reason === "emptied");

  if (emptied.length > 0) {
    console.log(`\n回收 ${emptied.length} 条已完成的规则：`);
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

function toJson(onlineBuildId: string | null, prefix: string, plan: PrunePlan) {
  return {
    prefix,
    onlineBuildId,
    changed: plan.changed,
    keep: plan.keep,
    expire: plan.expire,
    reclaim: plan.reclaim,
  };
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

function describe(error: unknown): string {
  if (error instanceof S3Error) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // 这几类是「预期内的失败」，只报结论，不甩堆栈
  if (
    error instanceof PlanError ||
    error instanceof BuildIdProbeError ||
    error instanceof XmlAssumptionError ||
    error instanceof S3Error
  ) {
    console.error(describe(error));
    process.exitCode = 1;
  } else {
    throw error;
  }
}
