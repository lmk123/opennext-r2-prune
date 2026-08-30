import { describe, expect, it } from "vitest";
import { makePlan, MAX_RULES, PlanError, type PlanInput, rulePrefix } from "../src/plan.ts";
import type { LifecycleDoc } from "../src/xml.ts";

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    existing: ["online1", "old1", "old2"],
    lastModified: new Map(),
    keep: [{ buildId: "online1", reason: "online" }],
    current: { own: [], foreign: [] },
    prefix: "incremental-cache",
    ...overrides,
  };
}

describe("保留集", () => {
  it("只由线上探测与 --keep 决定，其余全部作废", () => {
    const plan = makePlan(input());
    expect(plan.keep.map((b) => b.buildId)).toEqual(["online1"]);
    expect(plan.expire.map((b) => b.buildId)).toEqual(["old1", "old2"]);
    expect(plan.expire.every((b) => b.isNew)).toBe(true);
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

  it("近似时间只是展示，不影响判定", () => {
    const old = new Date("2020-01-01T00:00:00Z");
    const plan = makePlan(
      input({ lastModified: new Map([["online1", old], ["old1", new Date()]]) }),
    );
    expect(plan.keep[0]!.lastModified).toBe(old);
    expect(plan.expire.map((b) => b.buildId)).toEqual(["old1", "old2"]);
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
        current: withRules([{ buildId: "gone", prefix: "incremental-cache/gone/" }]),
      }),
    );
    expect(plan.reclaim).toEqual([{ buildId: "gone", reason: "emptied" }]);
    expect(plan.nextDoc.own.map((r) => r.buildId)).toEqual(["old1", "old2"]);
  });

  it("重新上线的 build，其残留规则被立即摘除", () => {
    const plan = makePlan(
      input({
        current: withRules([{ buildId: "online1", prefix: "incremental-cache/online1/" }]),
      }),
    );
    expect(plan.reclaim).toEqual([{ buildId: "online1", reason: "revived" }]);
    expect(plan.nextDoc.own.map((r) => r.buildId)).not.toContain("online1");
  });

  it("已有规则的 build 不重复添加，并标记为非新增", () => {
    const plan = makePlan(
      input({ current: withRules([{ buildId: "old1", prefix: "incremental-cache/old1/" }]) }),
    );
    expect(plan.expire.find((b) => b.buildId === "old1")!.isNew).toBe(false);
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

  it("规则前缀带结尾斜杠，避免某个 buildId 是另一个的前缀时误删", () => {
    const plan = makePlan(input({ existing: ["online1", "abc", "abcdef"] }));
    expect(plan.nextDoc.own.map((r) => r.prefix)).toEqual([
      "incremental-cache/abc/",
      "incremental-cache/abcdef/",
    ]);
    expect(rulePrefix("incremental-cache/", "abc")).toBe("incremental-cache/abc/");
  });
});
