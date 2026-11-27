import { describe, expect, it, vi } from "vitest";
import { PlanError, planPrune, prune, PruneOptionsError, PruneWriteError } from "../src/index.ts";

/** 让 writeAndVerify 抛出约定之外的异常；默认不设，照常调用真实实现 */
const hooks = vi.hoisted(() => ({ writeAndVerifyThrows: undefined as unknown }));
vi.mock("../src/run.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/run.ts")>();
  return {
    ...actual,
    writeAndVerify: (...args: Parameters<typeof actual.writeAndVerify>) =>
      hooks.writeAndVerifyThrows === undefined
        ? actual.writeAndVerify(...args)
        : Promise.reject(hooks.writeAndVerifyThrows),
  };
});

/**
 * 库入口：参数校验、dryRun、confirm 取消、写入失败，都不能让写请求漏出去。
 */

const CREDS = {
  bucket: "my-cache",
  accountId: "acct123",
  accessKeyId: "ak",
  secretAccessKey: "sk",
};

/** 有状态的假 R2 + 站点：PUT 进去的配置之后能原样读回来 */
function fakeWorld(opts: {
  buildIds: string[];
  online: string;
  putStatus?: number;
  /** 改写 PUT 进去的配置再存，模拟服务端改写规则 */
  mangle?: (xml: string) => string;
  /** 第几次 PUT（从 0 起）起一律回 403，用来让撤销失败 */
  denyPutFrom?: number;
}) {
  const calls: { method: string; url: string }[] = [];
  let lifecycle: string | undefined;
  let putCount = 0;
  const fetchImpl = (async (input: Request | string) => {
    const request = typeof input === "string" ? new Request(input) : input;
    const url = new URL(request.url);
    calls.push({ method: request.method, url: request.url });

    if (url.hostname === "example.com") {
      return new Response(opts.online, { headers: { "content-type": "text/plain" } });
    }
    if (url.searchParams.has("lifecycle")) {
      if (request.method === "PUT") {
        const index = putCount++;
        const status = opts.putStatus ?? (opts.denyPutFrom !== undefined && index >= opts.denyPutFrom ? 403 : 0);
        if (status) {
          return new Response("<Error><Code>AccessDenied</Code></Error>", { status });
        }
        lifecycle = (opts.mangle ?? ((x) => x))(await request.text());
        return new Response("", { status: 200 });
      }
      return lifecycle
        ? new Response(lifecycle)
        : new Response("<Error><Code>NoSuchLifecycleConfiguration</Code></Error>", { status: 404 });
    }
    const prefixes = opts.buildIds
      .map((id) => `<CommonPrefixes><Prefix>incremental-cache/${id}/</Prefix></CommonPrefixes>`)
      .join("");
    return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${prefixes}</ListBucketResult>`);
  }) as unknown as typeof fetch;
  const puts = () => calls.filter((c) => c.method === "PUT");
  /** 模拟别人在计划与写入之间改了配置 */
  const setLifecycle = (xml: string) => {
    lifecycle = xml;
  };
  return { calls, puts, setLifecycle, fetch: fetchImpl };
}

const SITE = { siteUrl: "https://example.com" };
/** 服务端丢掉本工具规则的前缀：这条删除规则会作用于整个 bucket，核对必须不过 */
const dropOwnPrefix = (xml: string) =>
  xml.replace(/<Filter><Prefix>incremental-cache\/[^<]*<\/Prefix><\/Filter>/g, "");

describe("prune", () => {
  it("不给任何保留来源时直接拒绝，一个请求都不发", async () => {
    const world = fakeWorld({ buildIds: ["live"], online: "live" });
    await expect(prune({ ...CREDS, fetch: world.fetch })).rejects.toThrow(PruneOptionsError);
    expect(world.calls).toHaveLength(0);
  });

  it("recentBuilds 不配 worker、expireDays / graceHours 非法都拒绝，一个请求都不发", async () => {
    const world = fakeWorld({ buildIds: ["live"], online: "live" });
    await expect(prune({ ...CREDS, ...SITE, recentBuilds: 5, fetch: world.fetch })).rejects.toThrow(
      /recentBuilds requires worker/,
    );
    await expect(prune({ ...CREDS, ...SITE, expireDays: 1.5, fetch: world.fetch })).rejects.toThrow(/expireDays/);
    await expect(prune({ ...CREDS, ...SITE, graceHours: -1, fetch: world.fetch })).rejects.toThrow(/graceHours/);
    await expect(prune({ ...CREDS, ...SITE, graceHours: 1.5, fetch: world.fetch })).rejects.toThrow(/graceHours/);
    await expect(prune({ ...CREDS, worker: "w", fetch: world.fetch })).rejects.toThrow(/apiToken/);
    expect(world.calls).toHaveLength(0);
  });

  it("dryRun 只算计划，不写入", async () => {
    const world = fakeWorld({ buildIds: ["live", "old"], online: "live" });
    const confirm = vi.fn(() => true);
    const result = await prune({ ...CREDS, ...SITE, dryRun: true, confirm, fetch: world.fetch });
    expect(result.expire.map((b) => b.buildId)).toEqual(["old"]);
    expect(result.onlineBuildIds).toEqual(["live"]);
    expect(result).toMatchObject({ changed: true, written: false, verified: null, cancelled: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(world.puts()).toHaveLength(0);
  });

  it("confirm 返回 false 时取消，不写入", async () => {
    const world = fakeWorld({ buildIds: ["live", "old"], online: "live" });
    const confirm = vi.fn(() => false);
    const result = await prune({ ...CREDS, ...SITE, confirm, fetch: world.fetch });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ expire: [{ buildId: "old", state: "new" }] }));
    expect(result).toMatchObject({ cancelled: true, written: false });
    expect(world.puts()).toHaveLength(0);
  });

  it("写入并回读核对；第二次运行无需改动", async () => {
    const world = fakeWorld({ buildIds: ["live", "old"], online: "live" });
    const first = await prune({ ...CREDS, ...SITE, fetch: world.fetch });
    expect(first).toMatchObject({ written: true, verified: true, rolledBack: null, warnings: [], writeError: null });
    expect(world.puts()).toHaveLength(1);

    const confirm = vi.fn(() => true);
    const second = await prune({ ...CREDS, ...SITE, confirm, fetch: world.fetch });
    expect(second).toMatchObject({ changed: false, written: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(world.puts()).toHaveLength(1);
  });

  it("保留的 build 不在 bucket 里时抛 PlanError，没有写请求", async () => {
    const world = fakeWorld({ buildIds: ["old"], online: "live" });
    await expect(prune({ ...CREDS, ...SITE, fetch: world.fetch })).rejects.toThrow(PlanError);
    expect(world.puts()).toHaveLength(0);
  });

  it("写入被拒时抛 PruneWriteError，标明没有写入", async () => {
    const world = fakeWorld({ buildIds: ["live", "old"], online: "live", putStatus: 403 });
    const error = await prune({ ...CREDS, ...SITE, fetch: world.fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PruneWriteError);
    expect(error).toMatchObject({ written: false, verified: null, rolledBack: null });
    expect((error as PruneWriteError).message).toMatch(/Writing lifecycle rules failed \(HTTP 403/);
  });

  it("核对不符时撤销并抛 PruneWriteError，撤销成功则标明规则已不在", async () => {
    const world = fakeWorld({ buildIds: ["live", "old"], online: "live", mangle: dropOwnPrefix });
    const error = await prune({ ...CREDS, ...SITE, fetch: world.fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PruneWriteError);
    expect(error).toMatchObject({ written: false, verified: false, rolledBack: true });
    expect((error as PruneWriteError).message).toMatch(/Removed all of this tool's rules under this prefix/);
    expect(world.puts()).toHaveLength(2);
  });

  it("核对不符且撤销失败时标明规则可能还在（written 为 true）", async () => {
    const world = fakeWorld({ buildIds: ["live", "old"], online: "live", mangle: dropOwnPrefix, denyPutFrom: 1 });
    const error = await prune({ ...CREDS, ...SITE, fetch: world.fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PruneWriteError);
    expect(error).toMatchObject({ written: true, verified: false, rolledBack: false });
    expect((error as PruneWriteError).message).toMatch(/Removing this tool's rules failed[\s\S]*rules with IDs like opennext-r2-prune:incremental-cache\/<buildId>\//);
  });

  it("endpoint 为空串时按 accountId 拼默认地址", async () => {
    const world = fakeWorld({ buildIds: ["live"], online: "live" });
    await prune({ ...CREDS, ...SITE, endpoint: "", dryRun: true, fetch: world.fetch });
    expect(world.calls.some((c) => c.url.startsWith("https://acct123.r2.cloudflarestorage.com/my-cache"))).toBe(true);
  });

  it("规则名额不够时分批挂，R2 删完一批后下一轮回收规则、挂上推迟的", async () => {
    const buildIds = ["live", "a", "b", "c", "d"];
    const world = fakeWorld({ buildIds, online: "live" });
    const userRules = Array.from(
      { length: 998 },
      (_, i) =>
        `<Rule><ID>user-${i}</ID><Status>Enabled</Status><Filter><Prefix>uploads/${i}/</Prefix></Filter>` +
        `<Expiration><Days>30</Days></Expiration></Rule>`,
    ).join("");
    world.setLifecycle(`<LifecycleConfiguration>${userRules}</LifecycleConfiguration>`);

    const first = await prune({ ...CREDS, ...SITE, fetch: world.fetch });
    expect(first.expire).toEqual([
      { buildId: "a", state: "new" },
      { buildId: "b", state: "new" },
    ]);
    expect(first.deferred).toEqual([{ buildId: "c" }, { buildId: "d" }]);
    expect(first).toMatchObject({ written: true, verified: true });

    // R2 还没删完：名额仍满，推迟的接着等，不写入
    const second = await prune({ ...CREDS, ...SITE, fetch: world.fetch });
    expect(second).toMatchObject({ changed: false, written: false });
    expect(second.deferred).toEqual([{ buildId: "c" }, { buildId: "d" }]);
    expect(world.puts()).toHaveLength(1);

    // R2 删完了 a、b：回收它们的规则，空出的名额当场给 c、d
    buildIds.splice(1, 2);
    const third = await prune({ ...CREDS, ...SITE, fetch: world.fetch });
    expect(third.reclaim).toEqual([
      { buildId: "a", reason: "emptied" },
      { buildId: "b", reason: "emptied" },
    ]);
    expect(third.expire.map((b) => b.buildId)).toEqual(["c", "d"]);
    expect(third.deferred).toEqual([]);
    expect(third).toMatchObject({ written: true, verified: true, warnings: [] });
  });
});

describe("planPrune", () => {
  it("计划之后 lifecycle 被改过时 apply 抛 PlanError，没有写请求", async () => {
    const world = fakeWorld({ buildIds: ["live", "old"], online: "live" });
    const planned = await planPrune({ ...CREDS, ...SITE, fetch: world.fetch });
    world.setLifecycle(
      "<LifecycleConfiguration><Rule><ID>mine</ID><Status>Enabled</Status><Filter><Prefix>logs/</Prefix></Filter>" +
        "<Expiration><Days>30</Days></Expiration></Rule></LifecycleConfiguration>",
    );
    await expect(planned.apply()).rejects.toThrow(PlanError);
    await expect(planned.apply()).rejects.toThrow(/can only be called once/);
    expect(world.puts()).toHaveLength(0);
  });

  it("写入阶段意外出错时按「可能已写入」报，并给出手动检查的办法", async () => {
    const world = fakeWorld({ buildIds: ["live", "old"], online: "live" });
    const planned = await planPrune({ ...CREDS, ...SITE, fetch: world.fetch });
    hooks.writeAndVerifyThrows = new TypeError("unexpected");
    try {
      const error = await planned.apply().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PruneWriteError);
      expect(error).toMatchObject({ written: true, verified: null, rolledBack: null });
      expect((error as PruneWriteError).message).toMatch(/can't confirm whether the rules were written[\s\S]*rules with IDs like opennext-r2-prune:incremental-cache\/<buildId>\//);
    } finally {
      hooks.writeAndVerifyThrows = undefined;
    }
  });

  it("apply 只能调用一次", async () => {
    const world = fakeWorld({ buildIds: ["live", "old"], online: "live" });
    const planned = await planPrune({ ...CREDS, ...SITE, fetch: world.fetch });
    expect(world.puts()).toHaveLength(0);
    await planned.apply();
    await expect(planned.apply()).rejects.toThrow(/can only be called once/);
    expect(world.puts()).toHaveLength(1);
  });
});
