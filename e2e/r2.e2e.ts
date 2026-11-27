import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PlanError, planPrune, prune, type PruneRunOptions, XmlAssumptionError } from "../src/index.ts";
import { R2Store } from "../src/store.ts";
import {
  BASELINE_EXPECTED,
  BASELINE_RULES,
  E2E_ROOT,
  eventually,
  isE2eRuleId,
  lifecycleXml,
  loadEnv,
  md5Base64,
  parseRules,
  RawR2,
  type RawRule,
  SNAPSHOT_KEY,
  spyFetch,
} from "./r2.ts";

/**
 * 在真实 R2 bucket 上把整个流程跑一遍：布置 build 目录与 lifecycle 配置 → 调库或 CLI → 绕开被测代码
 * 直接读回 lifecycle 核对。开跑前记下 bucket 原有的 lifecycle 配置，跑完原样写回；对象只碰 e2e/ 之下的。
 * R2 真正删掉对象要等最长 24 小时，这里只核对规则，不等删除。
 */

const env = loadEnv();
const r2 = new RawR2(env);
const SITE_A = `${E2E_ROOT}/site-a`;
const SITE_B = `${E2E_ROOT}/site-b`;

/** 开跑前读到的 lifecycle 原文：null 是原本没有任何配置，undefined 是没读到（beforeAll 中止了），此时不能动 lifecycle */
let snapshot: string | null | undefined;

const ownId = (prefix: string, buildId: string) => `opennext-r2-prune:${prefix}/${buildId}/`;

/** 本工具为 prefix 下 buildId 写的、完全合乎预期的规则 */
const ownRule = (prefix: string, buildId: string, days = 1): RawRule => ({
  id: ownId(prefix, buildId),
  enabled: true,
  filterPrefix: `${prefix}/${buildId}/`,
  days,
});

/** 读回的规则与期望逐条一致（不计顺序）。刚写完可能读到旧配置，对不上时隔一会儿重读 */
async function expectRules(expected: RawRule[]) {
  const sort = (rules: RawRule[]) => [...rules].sort((a, b) => a.id.localeCompare(b.id));
  await eventually(async () => expect(sort(await r2.rules())).toEqual(sort(expected)));
}

function options(prefix: string, extra: Partial<PruneRunOptions> = {}) {
  const spy = spyFetch();
  const opts: PruneRunOptions = {
    bucket: env.bucket,
    accountId: env.accountId,
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    prefix,
    md5Base64,
    fetch: spy.impl,
    // 用例里的 build 都是现场布置的，按默认的 24 小时全都算刚写入；只有专门测它的用例才打开
    graceHours: 0,
    ...extra,
  };
  return { opts, spy };
}

const ids = (builds: { buildId: string }[]) => builds.map((b) => b.buildId).sort();

beforeAll(async () => {
  // 只看残留规则不够：上次若在清空配置的用例前后被打断，bucket 上是一份一条规则都没有的配置，认不出是残留
  const snapshotExistsError = async () => {
    const saved = await r2.getObject(SNAPSHOT_KEY);
    return new Error(
      `bucket ${env.bucket} 上有 ${SNAPSHOT_KEY}：另一趟实测正在跑，或上次中途被打断、没来得及写回原配置，已中止。` +
        `确认没有别的实测在跑后，把其中记下的原配置写回 lifecycle（xml 为 null 表示原本没有任何配置），` +
        `再删掉这个对象后重跑：\n${saved ?? "（读的时候它已经不在了，多半是另一趟实测刚跑完）"}`,
    );
  };
  // 先查一次只为报对原因：另一趟正在跑时，它的规则会被下面误报成上次的残留。真正的互斥靠后面的条件写入
  if ((await r2.getObject(SNAPSHOT_KEY)) !== null) throw await snapshotExistsError();
  const { xml } = await r2.getLifecycle();
  // 快照对象被手动删掉、规则却没写回时，只剩实测的规则：照常跑会把这份残留当成原配置记下、跑完照样写回
  const leftovers = xml === null ? [] : parseRules(xml).map((rule) => rule.id).filter(isE2eRuleId);
  if (leftovers.length > 0) {
    throw new Error(
      `bucket ${env.bucket} 上还留着实测写的规则：${leftovers.join("、")}，多半是上次中途被打断、没来得及写回，已中止。` +
        `请照上次开跑时打在 stderr 上的原配置手动写回（或删掉这些规则）后再跑。`,
    );
  }
  // 快照存进 bucket 之后才算开跑：存失败时 snapshot 仍是 undefined，afterAll 不会动 lifecycle
  if (!(await r2.createObject(SNAPSHOT_KEY, JSON.stringify({ bucket: env.bucket, xml })))) throw await snapshotExistsError();
  snapshot = xml;
  // 先打出原配置：中途被打断（Ctrl-C、超时）时 afterAll 来不及写回，只能照这份（或 SNAPSHOT_KEY 里的）手动恢复
  console.error(
    `实测 bucket：${env.bucket}，跑完会写回下面这份原配置（${SNAPSHOT_KEY} 里也存着一份）；中途被打断时请照它手动写回：\n` +
      `${xml ?? "（原本没有任何配置）"}`,
  );
});

afterAll(async () => {
  if (snapshot === undefined) return;
  // 先还原 lifecycle 再清对象：清对象失败不能连累还原
  try {
    // 原本没有任何配置时写回一份空配置：实测 R2 接受空配置的 PUT，DELETE ?lifecycle 在 R2 上没实测过
    await r2.setLifecycle(snapshot ?? lifecycleXml([]));
  } catch (error) {
    console.error(
      `还原 bucket ${env.bucket} 的 lifecycle 配置失败，请手动写回下面这份原配置，再删掉 ${SNAPSHOT_KEY}：\n` +
        `${snapshot ?? "（原本没有任何配置）"}`,
    );
    // 清对象只是顺手：它再出错也不能盖掉还原失败这个更要紧的错误
    await r2
      .deleteUnder(`${E2E_ROOT}/`)
      .catch((cleanupError: unknown) => console.error(`清理 ${E2E_ROOT}/ 下的对象也失败了：${cleanupError}`));
    throw error;
  }
  // 原配置写回之后才撤掉快照：撤早了，这之间被打断，下一趟就认不出原配置没写回
  await r2.deleteObject(SNAPSHOT_KEY);
  await r2.deleteUnder(`${E2E_ROOT}/`);
});

beforeEach(async () => {
  await r2.deleteUnder(`${E2E_ROOT}/`);
  await r2.setLifecycle(lifecycleXml(BASELINE_RULES));
});

describe("基本流程", () => {
  it("保留之外的 build 挂上带 <Filter><Prefix> 的规则，外部规则原样保留，再跑一次无需改动", async () => {
    await r2.seedBuilds(SITE_A, ["build-a", "build-b", "build-c"]);

    const dry = options(SITE_A, { keep: ["build-a"], dryRun: true });
    const planned = await prune(dry.opts);
    expect(planned.changed).toBe(true);
    expect(ids(planned.keep)).toEqual(["build-a"]);
    expect(planned.expire).toEqual([
      { buildId: "build-b", state: "new" },
      { buildId: "build-c", state: "new" },
    ]);
    expect(planned.written).toBe(false);
    expect(dry.spy.writes()).toEqual([]);
    await expectRules(BASELINE_EXPECTED);

    const real = options(SITE_A, { keep: ["build-a"] });
    const result = await prune(real.opts);
    expect(result).toMatchObject({ written: true, verified: true, warnings: [], writeError: null });
    await expectRules([...BASELINE_EXPECTED, ownRule(SITE_A, "build-b"), ownRule(SITE_A, "build-c")]);

    const again = options(SITE_A, { keep: ["build-a"] });
    const second = await prune(again.opts);
    expect(second.changed).toBe(false);
    expect(second.expire.map((b) => b.state)).toEqual(["pending", "pending"]);
    expect(again.spy.writes()).toEqual([]);
  });

  it("刚写入的 build 不判作废：真实 R2 的 LastModified 能解析", async () => {
    await r2.seedBuilds(SITE_A, ["build-a", "build-b"]);

    // fresh 不能替保留集充数由 plan.test 直接测 makePlan：经过 collectPlan 时，保留集填错在读写入时间之前就已中止
    const { opts, spy } = options(SITE_A, { keep: ["build-a"], graceHours: 24 });
    const planned = await planPrune(opts);
    expect(planned.keep).toEqual([
      { buildId: "build-a", reason: "explicit" },
      { buildId: "build-b", reason: "fresh", source: expect.stringMatching(/^written at \d{4}-\d\d-\d\dT/) },
    ]);
    expect(planned.expire).toEqual([]);

    // 写入了多久按 R2 响应的 Date 头算；真实 R2 不带它时会悄悄退回本机时钟
    const store = new R2Store({
      endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
      bucket: env.bucket,
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    });
    const read = await store.buildWrittenAt(SITE_A, "build-b");
    expect(read?.serverTime).toBeInstanceOf(Date);
    expect(Math.abs(read!.serverTime!.getTime() - read!.writtenAt.getTime())).toBeLessThan(3_600_000);
    expect(planned.changed).toBe(false);
    expect(spy.writes()).toEqual([]);
    await expectRules(BASELINE_EXPECTED);
  });

  it("规则名额不够时分批挂：挂满 R2 的 1000 条上限，其余推迟；R2 拒绝第 1001 条", async () => {
    // 外部规则凑到 998 条，只剩两个名额
    const fillers = Array.from(
      { length: 998 - BASELINE_RULES.length },
      (_, i) =>
        `<Rule><ID>e2e-filler-${i}</ID><Status>Enabled</Status><Filter><Prefix>${E2E_ROOT}/filler/${i}/</Prefix></Filter>` +
        "<Expiration><Days>3650</Days></Expiration></Rule>",
    );
    await r2.setLifecycle(lifecycleXml([...BASELINE_RULES, ...fillers]));
    await r2.seedBuilds(SITE_A, ["build-a", "build-b", "build-c", "build-d"]);

    const result = await prune(options(SITE_A, { keep: ["build-a"] }).opts);
    expect(result.expire).toEqual([
      { buildId: "build-b", state: "new" },
      { buildId: "build-c", state: "new" },
    ]);
    expect(result.deferred).toEqual([{ buildId: "build-d" }]);
    expect(result).toMatchObject({ written: true, verified: true, warnings: [], writeError: null });
    // 刚写完可能读到旧配置；等读回的稳定下来，下面第二趟才不会按旧配置再写一次
    await eventually(async () => {
      const rules = await r2.rules();
      expect(rules).toHaveLength(1000);
      expect(rules.filter((rule) => rule.id.startsWith("opennext-r2-prune:")).map((rule) => rule.id).sort()).toEqual([
        ownId(SITE_A, "build-b"),
        ownId(SITE_A, "build-c"),
      ]);
    });

    // 名额仍满时推迟的接着等，不写入
    const again = options(SITE_A, { keep: ["build-a"] });
    const second = await prune(again.opts);
    expect(second).toMatchObject({ changed: false, deferred: [{ buildId: "build-d" }] });
    expect(again.spy.writes()).toEqual([]);

    // MAX_RULES 的依据：同样写法的规则凑到 1001 条，R2 就拒绝（报的是 MalformedXML，不说是条数超了）
    const extra = Array.from(
      { length: 3 },
      (_, i) =>
        `<Rule><ID>e2e-filler-extra-${i}</ID><Status>Enabled</Status><Filter><Prefix>${E2E_ROOT}/filler/extra-${i}/</Prefix></Filter>` +
        "<Expiration><Days>3650</Days></Expiration></Rule>",
    );
    await expect(r2.putLifecycle(lifecycleXml([...BASELINE_RULES, ...fillers, ...extra]))).rejects.toThrow(
      /HTTP 400.*MalformedXML/,
    );
  });

  it("目录删空后回收规则，回滚的 build 摘掉规则，改了过期天数就改写规则", async () => {
    await r2.seedBuilds(SITE_A, ["build-a", "build-b", "build-c"]);
    await prune(options(SITE_A, { keep: ["build-a"] }).opts);

    await r2.deleteUnder(`${SITE_A}/build-b/`);
    const emptied = await prune(options(SITE_A, { keep: ["build-a"] }).opts);
    expect(emptied.reclaim).toEqual([{ buildId: "build-b", reason: "emptied" }]);
    expect(emptied).toMatchObject({ written: true, verified: true });
    await expectRules([...BASELINE_EXPECTED, ownRule(SITE_A, "build-c")]);

    const revived = await prune(options(SITE_A, { keep: ["build-a", "build-c"] }).opts);
    expect(revived.reclaim).toEqual([{ buildId: "build-c", reason: "revived" }]);
    expect(revived).toMatchObject({ written: true, verified: true });
    await expectRules(BASELINE_EXPECTED);

    await r2.seedBuilds(SITE_A, ["build-d"]);
    await prune(options(SITE_A, { keep: ["build-a", "build-c"] }).opts);
    await expectRules([...BASELINE_EXPECTED, ownRule(SITE_A, "build-d")]);
    const longer = await prune(options(SITE_A, { keep: ["build-a", "build-c"], expireDays: 3 }).opts);
    expect(longer.expire).toEqual([{ buildId: "build-d", state: "updated" }]);
    expect(longer).toMatchObject({ written: true, verified: true });
    await expectRules([...BASELINE_EXPECTED, ownRule(SITE_A, "build-d", 3)]);
  });

  it("多个站点共用 bucket：各管各前缀下的规则，同名 build 互不影响", async () => {
    await r2.seedBuilds(SITE_A, ["only-a", "shared"]);
    await r2.seedBuilds(SITE_B, ["only-b", "shared"]);

    await prune(options(SITE_A, { keep: ["only-a"] }).opts);
    await prune(options(SITE_B, { keep: ["only-b"] }).opts);
    await expectRules([...BASELINE_EXPECTED, ownRule(SITE_A, "shared"), ownRule(SITE_B, "shared")]);

    const rerun = options(SITE_A, { keep: ["only-a"] });
    expect((await prune(rerun.opts)).changed).toBe(false);
    expect(rerun.spy.writes()).toEqual([]);

    await r2.deleteUnder(`${SITE_A}/shared/`);
    const reclaimed = await prune(options(SITE_A, { keep: ["only-a"] }).opts);
    expect(reclaimed.reclaim).toEqual([{ buildId: "shared", reason: "emptied" }]);
    await expectRules([...BASELINE_EXPECTED, ownRule(SITE_B, "shared")]);
  });

  it("一条规则都不剩时清空整份配置", async () => {
    // 只留本工具的一条规则、没有任何外部规则，目录删空后回收它，写回的配置就是空的
    await r2.setLifecycle(
      lifecycleXml([
        `<Rule><ID>${ownId(SITE_A, "gone")}</ID><Status>Enabled</Status>` +
          `<Filter><Prefix>${SITE_A}/gone/</Prefix></Filter><Expiration><Days>1</Days></Expiration></Rule>`,
      ]),
    );
    await r2.seedBuilds(SITE_A, ["build-a"]);

    const run = options(SITE_A, { keep: ["build-a"] });
    const result = await prune(run.opts);
    expect(result.reclaim).toEqual([{ buildId: "gone", reason: "emptied" }]);
    expect(result).toMatchObject({ written: true, verified: true });
    await expectRules([]);
    // R2 对空配置的态度没有文档，README 记下的实测结论：接受空配置的 PUT（不退回 DELETE），之后读到 200 和一份空配置
    expect(run.spy.writes().map((c) => c.method)).toEqual(["PUT"]);
    const after = await r2.getLifecycle();
    expect(after.status).toBe(200);
    expect(after.xml).not.toBeNull();

    // 清空之后的配置要能照常读，并判为无需改动
    const rerun = options(SITE_A, { keep: ["build-a"] });
    expect((await prune(rerun.opts)).changed).toBe(false);
    expect(rerun.spy.writes()).toEqual([]);
  });
});

describe("安全校验没过时中止，且没有写请求", () => {
  async function expectAbort(prefix: string, extra: Partial<PruneRunOptions>, error: RegExp, type = PlanError) {
    const before = await r2.rules();
    const { opts, spy } = options(prefix, extra);
    const thrown = await prune(opts).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(type);
    expect((thrown as Error).message).toMatch(error);
    expect(spy.writes()).toEqual([]);
    await expectRules(before);
  }

  it("前缀为空、保留的 build 不存在、保留集与现存 build 无交集", async () => {
    await r2.seedBuilds(SITE_A, ["build-a", "build-b"]);
    await expectAbort("", { keep: ["build-a"] }, /empty --prefix/);
    await expectAbort(SITE_A, { keep: ["no-such-build"] }, /don't exist in the bucket/);
    await expectAbort(SITE_A, { keep: ["no-such-build"], force: true }, /no overlap/);
  });

  it("前缀与已有规则的前缀互相嵌套", async () => {
    await r2.seedBuilds(SITE_A, ["build-a", "build-b"]);
    await prune(options(SITE_A, { keep: ["build-a"] }).opts);

    await expectAbort(E2E_ROOT, { keep: ["site-a"] }, /is nested with/);
    await expectAbort(`${SITE_A}/build-a`, { keep: ["x"] }, /is nested with/);
  });

  it("本工具标记开头、前缀里却有空格这类拆不开的字符的规则", async () => {
    await r2.seedBuilds(SITE_A, ["build-a", "build-b"]);
    await r2.setLifecycle(
      lifecycleXml([
        ...BASELINE_RULES,
        `<Rule><ID>opennext-r2-prune:${SITE_A}/bad id/</ID><Status>Enabled</Status>` +
          `<Filter><Prefix>${E2E_ROOT}/never-used/</Prefix></Filter><Expiration><Days>3650</Days></Expiration></Rule>`,
      ]),
    );
    await expectAbort(SITE_A, { keep: ["build-a"] }, /can't be split/, XmlAssumptionError);
  });

  it("planPrune 之后配置被改过，apply() 不写入", async () => {
    await r2.seedBuilds(SITE_A, ["build-a", "build-b"]);
    const { opts, spy } = options(SITE_A, { keep: ["build-a"] });
    const planned = await planPrune(opts);
    expect(planned.changed).toBe(true);

    const changed = [
      ...BASELINE_RULES,
      `<Rule><ID>e2e-added-meanwhile</ID><Status>Enabled</Status>` +
        `<Filter><Prefix>${E2E_ROOT}/meanwhile/</Prefix></Filter><Expiration><Days>30</Days></Expiration></Rule>`,
    ];
    await r2.setLifecycle(lifecycleXml(changed));

    await expect(planned.apply()).rejects.toBeInstanceOf(PlanError);
    expect(spy.writes()).toEqual([]);
    await expectRules([
      ...BASELINE_EXPECTED,
      { id: "e2e-added-meanwhile", enabled: true, filterPrefix: `${E2E_ROOT}/meanwhile/`, days: 30 },
    ]);
  });
});

describe("对整个 bucket 生效的规则", () => {
  it("在探测之前报出，写入时改写成带 <Filter><Prefix> 的规则", async () => {
    await r2.seedBuilds(SITE_A, ["build-a", "build-b"]);
    // 天数给到 3650：万一没被改写也删不到任何实测期间的对象
    await r2.setLifecycle(
      lifecycleXml([
        ...BASELINE_RULES,
        `<Rule><ID>${ownId(SITE_A, "build-b")}</ID><Status>Enabled</Status>` +
          `<Prefix>${SITE_A}/build-b/</Prefix><Expiration><Days>3650</Days></Expiration></Rule>`,
      ]),
    );

    const reported: string[][] = [];
    const result = await prune(options(SITE_A, { keep: ["build-a"], onWholeBucketRules: (r) => reported.push(r) }).opts);
    expect(reported).toEqual([[ownId(SITE_A, "build-b")]]);
    expect(result.wholeBucketRules).toEqual([ownId(SITE_A, "build-b")]);
    expect(result.expire).toEqual([{ buildId: "build-b", state: "updated" }]);
    expect(result).toMatchObject({ written: true, verified: true });
    await expectRules([...BASELINE_EXPECTED, ownRule(SITE_A, "build-b")]);
  });
});

describe("README 里记下的 R2 实测特性", () => {
  it("R2 静默丢掉直接挂在 <Rule> 下的裸 <Prefix>，规则变成对整个 bucket 生效", async () => {
    await r2.setLifecycle(
      lifecycleXml([
        `<Rule><ID>e2e-bare-prefix</ID><Status>Enabled</Status>` +
          `<Prefix>${E2E_ROOT}/bare/</Prefix><Expiration><Days>3650</Days></Expiration></Rule>`,
      ]),
    );
    const [rule] = await r2.rules();
    expect(rule).toEqual({ id: "e2e-bare-prefix", enabled: true, days: 3650 });
  });

  it("R2 不校验 Content-MD5：带错误摘要、不带摘要的写入都照样成功", async () => {
    const xml = lifecycleXml(BASELINE_RULES);
    expect((await r2.putLifecycle(xml, md5Base64("故意给错的摘要"))).status).toBe(200);
    expect((await r2.putLifecycle(xml, null)).status).toBe(200);
  });

  it("读回的规则按 ID 排序，不保持写入顺序", async () => {
    const rule = (id: string) =>
      `<Rule><ID>${id}</ID><Status>Enabled</Status><Filter><Prefix>${E2E_ROOT}/${id}/</Prefix></Filter>` +
      `<Expiration><Days>3650</Days></Expiration></Rule>`;
    const written = ["e2e-order-c", "e2e-order-a", "e2e-order-b"];
    await r2.setLifecycle(lifecycleXml(written.map(rule)));
    expect((await r2.rules()).map((r) => r.id)).toEqual([...written].sort());
  });
});

describe("CLI", () => {
  function cli(args: string[]) {
    const result = spawnSync(
      process.execPath,
      // 同 options()：现场布置的 build 都算刚写入。同一开关传两次时以后面的为准，用例可以覆盖
      ["--experimental-strip-types", "--no-warnings", "src/cli.ts", "--grace-hours", "0", ...args],
      {
        encoding: "utf8",
        timeout: 120_000,
        // 只传 R2 凭证：环境里的 WORKER_NAME 会让 CLI 切到 --worker 模式
        env: {
          PATH: process.env.PATH,
          R2_BUCKET: env.bucket,
          CLOUDFLARE_ACCOUNT_ID: env.accountId,
          R2_ACCESS_KEY_ID: env.accessKeyId,
          R2_SECRET_ACCESS_KEY: env.secretAccessKey,
        },
      },
    );
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("--dry-run --json 不写入，--yes 写入并核对，非交互又没有 --yes 时拒绝写入", async () => {
    await r2.seedBuilds(SITE_A, ["build-a", "build-b"]);

    const dry = cli(["--prefix", SITE_A, "--keep", "build-a", "--dry-run", "--json"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ changed: true, written: false, expire: [{ buildId: "build-b" }] });
    await expectRules(BASELINE_EXPECTED);

    const refused = cli(["--prefix", SITE_A, "--keep", "build-a"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/--yes/);
    await expectRules(BASELINE_EXPECTED);

    const real = cli(["--prefix", SITE_A, "--keep", "build-a", "--yes", "--json"]);
    expect(real.code, real.stderr).toBe(0);
    expect(JSON.parse(real.stdout)).toMatchObject({ written: true, verified: true, rolledBack: null, error: null });
    await expectRules([...BASELINE_EXPECTED, ownRule(SITE_A, "build-b")]);
  });
});

describe.skipIf(!env.worker)("探测 Worker 的线上与预览 build（需要 WORKER_NAME 与 CLOUDFLARE_API_TOKEN）", () => {
  const SITE_W = `${E2E_ROOT}/site-worker`;
  const worker = () => ({ worker: env.worker!.name, apiToken: env.worker!.apiToken });
  /** 线上状态要探测两次（先拿到 build 去布置，再正式算计划），两次之间 Worker 发版就对不上，这时重来 */
  const ATTEMPTS = 3;

  it("把探测到的 build 布置进测试 bucket，它们被保留，其余判作废", async () => {
    for (let attempt = 1; ; attempt++) {
      // 先用 force 跑一趟只读的计划，拿到 Worker 此刻的线上、近期与预览 build
      await r2.deleteUnder(`${SITE_W}/`);
      await r2.seedBuilds(SITE_W, ["e2e-anchor"]);
      const discover = await planPrune(options(SITE_W, { ...worker(), keep: ["e2e-anchor"], force: true }).opts);
      const probed = [...discover.keep, ...discover.absent].filter((b) => b.reason !== "explicit");
      expect(discover.onlineBuildIds.length).toBeGreaterThan(0);
      console.info(
        `探测到 ${probed.length} 个 build：${probed.map((b) => `${b.buildId}（${b.reason}${b.source ? ` ${b.source}` : ""}）`).join("、")}`,
      );

      await r2.deleteUnder(`${SITE_W}/`);
      const probedIds = [...new Set(probed.map((b) => b.buildId))].sort();
      await r2.seedBuilds(SITE_W, [...probedIds, "e2e-stale"]);

      // 新上线的 build 没布置进来时 planPrune 会以「不存在」中止，所以报错也算对不上
      const planned = await planPrune(options(SITE_W, worker()).opts).catch((error: unknown) => error as Error);
      const reprobed = planned instanceof Error ? null : ids([...planned.keep, ...planned.absent]);
      if (planned instanceof Error || JSON.stringify(reprobed) !== JSON.stringify(probedIds)) {
        if (attempt >= ATTEMPTS) {
          if (planned instanceof Error) throw planned;
          expect(reprobed).toEqual(probedIds);
        }
        console.info(`第二次探测与第一次对不上（${planned instanceof Error ? planned.message : reprobed!.join("、")}），多半是期间发了版，重来`);
        continue;
      }

      expect(ids(planned.keep)).toEqual(probedIds);
      expect(planned.expire).toEqual([{ buildId: "e2e-stale", state: "new" }]);
      expect(await planned.apply()).toMatchObject({ written: true, verified: true });
      await expectRules([...BASELINE_EXPECTED, ownRule(SITE_W, "e2e-stale")]);
      return;
    }
  }, ATTEMPTS * 180_000);
});
