import { describe, expect, it } from "vitest";
import { makePlan, MAX_RULES, PlanError, type PlanInput, rulePrefix } from "../src/plan.ts";
import type { LifecycleDoc, OwnRule } from "../src/xml.ts";

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    existing: ["online1", "old1", "old2"],
    keep: [{ buildId: "online1", reason: "online" }],
    current: { own: [], foreign: [] },
    prefix: "incremental-cache",
    expireDays: 1,
    style: "filter",
    ...overrides,
  };
}

/** 一条「本工具上次就该写成这样」的规则 */
function ownRule(buildId: string, overrides: Partial<OwnRule> = {}): OwnRule {
  return {
    buildId,
    prefix: `incremental-cache/${buildId}/`,
    expireDays: 1,
    style: "filter",
    enabled: true,
    ...overrides,
  };
}

describe("保留集", () => {
  it("只由线上探测与 --keep 决定，其余全部作废", () => {
    const plan = makePlan(input());
    expect(plan.keep.map((b) => b.buildId)).toEqual(["online1"]);
    expect(plan.expire.map((b) => b.buildId)).toEqual(["old1", "old2"]);
    expect(plan.expire.every((b) => b.state === "new")).toBe(true);
  });

  it("--keep 能追加保留", () => {
    const plan = makePlan(
      input({
        keep: [
          { buildId: "online1", reason: "online" },
          { buildId: "old1", reason: "explicit" },
        ],
      }),
    );
    expect(plan.keep.map((b) => b.buildId).sort()).toEqual(["old1", "online1"]);
    expect(plan.expire.map((b) => b.buildId)).toEqual(["old2"]);
  });

  it("同一个 build 既在线上又被 --keep 传入时，展示为线上", () => {
    const plan = makePlan(
      input({
        keep: [
          { buildId: "online1", reason: "explicit" },
          { buildId: "online1", reason: "online" },
        ],
      }),
    );
    expect(plan.keep).toHaveLength(1);
    expect(plan.keep[0]!.reason).toBe("online");
  });
});

describe("安全校验", () => {
  it("保留集为空时拒绝继续", () => {
    expect(() => makePlan(input({ keep: [] }))).toThrow(PlanError);
  });

  it("要保留的 build 不在 bucket 里时拒绝继续", () => {
    expect(() =>
      makePlan(input({ keep: [{ buildId: "bogus", reason: "explicit" }] })),
    ).toThrow(/不存在/);
  });

  it("--force 可以放行「不在 bucket 里」，但仍不允许清空全部", () => {
    expect(() =>
      makePlan(input({ keep: [{ buildId: "bogus", reason: "explicit" }], force: true })),
    ).toThrow(/没有交集/);
  });

  it("规则总数超过上限时拒绝继续", () => {
    const existing = Array.from({ length: MAX_RULES + 2 }, (_, i) => `b${i}`);
    expect(() =>
      makePlan(input({ existing, keep: [{ buildId: "b0", reason: "online" }] })),
    ).toThrow(/上限/);
  });

  it("外部规则也计入上限", () => {
    const foreign = Array.from({ length: MAX_RULES - 1 }, () => "<ID>x</ID>");
    expect(() => makePlan(input({ current: { own: [], foreign } }))).toThrow(/上限/);
  });
});

describe("规则合并与回收", () => {
  const withRules = (own: LifecycleDoc["own"], foreign: string[] = []): LifecycleDoc => ({
    own,
    foreign,
  });

  it("已经空掉的目录，其规则被回收", () => {
    const plan = makePlan(
      input({
        current: withRules([ownRule("gone")]),
      }),
    );
    expect(plan.reclaim).toEqual([{ buildId: "gone", reason: "emptied" }]);
    expect(plan.nextDoc.own.map((r) => r.buildId)).toEqual(["old1", "old2"]);
  });

  it("重新上线的 build，其残留规则被立即摘除", () => {
    const plan = makePlan(
      input({
        current: withRules([ownRule("online1")]),
      }),
    );
    expect(plan.reclaim).toEqual([{ buildId: "online1", reason: "revived" }]);
    expect(plan.nextDoc.own.map((r) => r.buildId)).not.toContain("online1");
  });

  it("--force 硬留、但不在 bucket 里的 build，其残留规则按「已删空」回收，不算复活", () => {
    const plan = makePlan(
      input({
        keep: [
          { buildId: "online1", reason: "online" },
          { buildId: "gone", reason: "explicit" },
        ],
        force: true,
        current: withRules([ownRule("gone")]),
      }),
    );
    expect(plan.reclaim).toEqual([{ buildId: "gone", reason: "emptied" }]);
  });

  it("已有规则且内容一致的 build 不重复添加，标记为仍在删", () => {
    const plan = makePlan(input({ current: withRules([ownRule("old1")]) }));
    expect(plan.expire.find((b) => b.buildId === "old1")!.state).toBe("pending");
    expect(plan.nextDoc.own.filter((r) => r.buildId === "old1")).toHaveLength(1);
  });

  it("外部规则原样带进新配置", () => {
    const plan = makePlan(input({ current: withRules([], ["<ID>user-rule</ID>"]) }));
    expect(plan.nextDoc.foreign).toEqual(["<ID>user-rule</ID>"]);
  });

  it("无事可做时 changed 为 false", () => {
    const plan = makePlan(
      input({
        existing: ["online1"],
        current: withRules([]),
      }),
    );
    expect(plan.expire).toHaveLength(0);
    expect(plan.changed).toBe(false);
  });

  it("换了 --expire-days 要改写规则，不能当作没变", () => {
    const plan = makePlan(input({ current: withRules([ownRule("old1")]), expireDays: 7 }));
    expect(plan.changed).toBe(true);
    expect(plan.expire.find((b) => b.buildId === "old1")!.state).toBe("updated");
    expect(plan.nextDoc.own.every((r) => r.expireDays === 7)).toBe(true);
  });

  it("已有规则是 bare、本次要 filter，要改写", () => {
    const plan = makePlan(
      input({ current: withRules([ownRule("old1", { style: "bare" })]), style: "filter" }),
    );
    expect(plan.changed).toBe(true);
    expect(plan.expire.find((b) => b.buildId === "old1")!.state).toBe("updated");
    expect(plan.nextDoc.own.every((r) => r.style === "filter")).toBe(true);
  });

  it("已有规则回读成 filter、本次要 bare 时不反复改写", () => {
    // S3 的 GET 会把裸 <Prefix> 规范化成 <Filter><Prefix>，回读结果区分不出服务端
    // 规范化与「上次就写的 filter」。若在这个方向上较真，--lifecycle-style bare
    // 的每次运行都会重发一次 PUT，changed 永远为 true，收敛不了。
    const current = withRules([ownRule("old1"), ownRule("old2")]);
    const plan = makePlan(input({ current, style: "bare" }));
    expect(plan.changed).toBe(false);
    expect(plan.expire.find((b) => b.buildId === "old1")!.state).toBe("pending");
    // 真要写的时候（别的字段变了）仍然按本次的式样写
    const withOtherChange = makePlan(input({ current, style: "bare", expireDays: 7 }));
    expect(withOtherChange.changed).toBe(true);
    expect(withOtherChange.nextDoc.own.every((r) => r.style === "bare")).toBe(true);
  });

  it("已有规则的前缀对不上当前 --prefix 时，改写而不是沿用", () => {
    const plan = makePlan(
      input({ current: withRules([ownRule("old1", { prefix: "old-cache/old1/" })]) }),
    );
    expect(plan.changed).toBe(true);
    expect(plan.expire.find((b) => b.buildId === "old1")!.state).toBe("updated");
    expect(plan.nextDoc.own.find((r) => r.buildId === "old1")!.prefix).toBe(
      "incremental-cache/old1/",
    );
  });

  it("自有规则被手动停用时重新启用", () => {
    const plan = makePlan(input({ current: withRules([ownRule("old1", { enabled: false })]) }));
    expect(plan.changed).toBe(true);
    expect(plan.nextDoc.own.every((r) => r.enabled)).toBe(true);
  });

  it("规则前缀带结尾斜杠，避免某个 buildId 是另一个的前缀时误删", () => {
    const plan = makePlan(input({ existing: ["online1", "abc", "abcdef"] }));
    expect(plan.nextDoc.own.map((r) => r.prefix)).toEqual([
      "incremental-cache/abc/",
      "incremental-cache/abcdef/",
    ]);
    expect(rulePrefix("incremental-cache/", "abc")).toBe("incremental-cache/abc/");
  });

  it("缓存放在 bucket 根下时，规则前缀不能多出前导斜杠", () => {
    // 多一个前导斜杠，规则就作用在一个不存在的 key 空间上，一个对象都删不掉
    expect(rulePrefix("", "abc")).toBe("abc/");
    expect(rulePrefix("/", "abc")).toBe("abc/");
    const plan = makePlan(input({ prefix: "", allowRootPrefix: true }));
    expect(plan.nextDoc.own.map((r) => r.prefix)).toEqual(["old1/", "old2/"]);
  });

  it("前缀为空时默认拒绝：根下的每个一级目录都会被当成 build", () => {
    // 这是本工具唯一能删到非缓存数据的路径 —— assets/、backups/ 会一并挂上删除规则
    expect(() => makePlan(input({ prefix: "" }))).toThrow(PlanError);
    expect(() => makePlan(input({ prefix: "/" }))).toThrow(/--allow-root-prefix/);
  });
});

describe("多来源保留集", () => {
  it("同一个 build 有多个来源时按 online > recent > preview > explicit 展示", () => {
    const plan = makePlan(
      input({
        existing: ["online1", "b1", "old"],
        keep: [
          { buildId: "b1", reason: "explicit" },
          { buildId: "b1", reason: "preview", source: "feat" },
          { buildId: "b1", reason: "recent", source: "version v1" },
          { buildId: "online1", reason: "preview", source: "feat-x" },
          { buildId: "online1", reason: "online" },
        ],
      }),
    );
    expect(plan.keep).toEqual([
      { buildId: "b1", reason: "recent", source: "version v1" },
      { buildId: "online1", reason: "online" },
    ]);
  });

  it("recent / preview 不在 bucket 里只记入 absent，不报错", () => {
    const plan = makePlan(
      input({
        keep: [
          { buildId: "online1", reason: "online" },
          { buildId: "gone", reason: "recent" },
          { buildId: "elsewhere", reason: "preview", source: "feat" },
        ],
      }),
    );
    expect(plan.keep.map((b) => b.buildId)).toEqual(["online1"]);
    expect(plan.absent.map((b) => b.buildId)).toEqual(["gone", "elsewhere"]);
    expect(plan.expire.map((b) => b.buildId)).toEqual(["old1", "old2"]);
  });

  it("不在 bucket 里的预览 build 残留规则按「目录已空」回收，不当成复活", () => {
    const plan = makePlan(
      input({
        keep: [
          { buildId: "online1", reason: "online" },
          { buildId: "gone", reason: "preview" },
        ],
        current: { own: [ownRule("gone")], foreign: [] },
      }),
    );
    expect(plan.reclaim).toEqual([{ buildId: "gone", reason: "emptied" }]);
  });

  it("online 不在 bucket 里依然报错", () => {
    expect(() =>
      makePlan(input({ keep: [{ buildId: "bogus", reason: "online" }] })),
    ).toThrow(/不存在/);
  });

  it("--keep 的 build 同时是近期版本时，不在 bucket 里仍要报错", () => {
    const keep = [
      { buildId: "online1", reason: "online" as const },
      { buildId: "typo", reason: "recent" as const, source: "version v1" },
      { buildId: "typo", reason: "explicit" as const },
    ];
    expect(() => makePlan(input({ keep }))).toThrow(/typo/);

    // --force 时它留在 keep 里（展示原因仍按优先级取 recent），不会被挪进 absent
    const plan = makePlan(input({ keep, force: true }));
    expect(plan.keep.map((b) => [b.buildId, b.reason])).toEqual([
      ["online1", "online"],
      ["typo", "recent"],
    ]);
    expect(plan.absent).toEqual([]);
  });
});
