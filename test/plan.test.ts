import { describe, expect, it } from "vitest";
import {
  makePlan,
  MAX_RULES,
  PlanError,
  type PlanInput,
  RESERVED_RULES,
  verifyWritten,
  wholeBucketRules,
} from "../src/plan.ts";
import { rulePrefix } from "../src/prefix.ts";
import { type OwnRule, type ParsedLifecycle, XmlAssumptionError } from "../src/xml.ts";

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    existing: ["online1", "old1", "old2"],
    keep: [{ buildId: "online1", reason: "online" }],
    current: { prefix: "incremental-cache/", own: [], foreign: [], others: [], malformed: [] },
    prefix: "incremental-cache",
    expireDays: 1,
    ...overrides,
  };
}

/** 一条「本工具上次就该写成这样」的规则 */
function ownRule(buildId: string, overrides: Partial<OwnRule> = {}): OwnRule {
  return {
    buildId,
    prefix: `incremental-cache/${buildId}/`,
    expireDays: 1,
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

  it("刚写入的 build 不能充当保留集", () => {
    // 只剩 fresh 时等于什么都没探测到；它也不能替填错的 --keep 撑起「有交集」
    expect(() => makePlan(input({ keep: [{ buildId: "old1", reason: "fresh" }] }))).toThrow(/保留集为空/);
    expect(() =>
      makePlan(
        input({
          keep: [
            { buildId: "bogus", reason: "explicit" },
            { buildId: "old1", reason: "fresh" },
          ],
          force: true,
        }),
      ),
    ).toThrow(/没有交集/);
  });

  it("刚写入的 build 照常保留，不挂规则", () => {
    const plan = makePlan(
      input({
        keep: [
          { buildId: "online1", reason: "online" },
          { buildId: "old1", reason: "fresh" },
        ],
      }),
    );
    expect(plan.keep.map((b) => b.buildId)).toEqual(["online1", "old1"]);
    expect(plan.expire.map((b) => b.buildId)).toEqual(["old2"]);
  });
});

describe("规则总数上限", () => {
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);
  const foreign = (n: number) => Array.from({ length: n }, (_, i) => `<ID>user-${i}</ID>`);
  const lifecycle = (own: OwnRule[], foreignRules: string[]): ParsedLifecycle => ({
    prefix: "incremental-cache/",
    own,
    foreign: foreignRules,
    others: [],
    malformed: [],
  });
  /** n 条本工具为别的前缀 site-b/ 写的规则（原文同样在 foreign 里） */
  const otherSite = (n: number) =>
    ids("b", n).map((buildId) => ({
      buildId,
      prefix: `site-b/${buildId}/`,
      expireDays: 1,
      enabled: true,
      id: `opennext-r2-prune:site-b/${buildId}/`,
      scope: "site-b/",
    }));

  it("名额不够时只挂到上限减去给用户留的余量，其余列为推迟，既不挂规则也不算保留", () => {
    const olds = ids("old", 2000);
    const plan = makePlan(
      input({ existing: ["online1", ...olds], current: lifecycle([], foreign(300)) }),
    );
    expect(plan.expire).toHaveLength(MAX_RULES - RESERVED_RULES - 300);
    expect(plan.deferred).toHaveLength(2000 - (MAX_RULES - RESERVED_RULES - 300));
    expect(plan.nextDoc.own.length + plan.nextDoc.foreign.length).toBe(MAX_RULES - RESERVED_RULES);
    const deferred = new Set(plan.deferred.map((b) => b.buildId));
    expect(plan.expire.some((b) => deferred.has(b.buildId))).toBe(false);
    expect(plan.keep.some((b) => deferred.has(b.buildId))).toBe(false);
    expect(plan.changed).toBe(true);
  });

  it("没给写入时间时按 buildId 挑", () => {
    const plan = makePlan(
      input({ existing: ["online1", "c", "a", "b"], current: lifecycle([], foreign(MAX_RULES - 2)) }),
    );
    expect(plan.expire.map((b) => b.buildId)).toEqual(["a", "b"]);
    expect(plan.deferred).toEqual([{ buildId: "c" }]);
  });

  it("先挂写入最早的；读不到时间（目录已空）的排在最后", () => {
    const writtenAt = new Map<string, Date | null>([
      ["a", null],
      ["b", new Date("2026-01-03T00:00:00Z")],
      ["c", new Date("2026-01-01T00:00:00Z")],
      ["d", new Date("2026-01-02T00:00:00Z")],
    ]);
    const plan = makePlan(
      input({
        existing: ["online1", "a", "b", "c", "d"],
        current: lifecycle([], foreign(MAX_RULES - 2)),
        writtenAt,
      }),
    );
    // expire 按 bucket 里的顺序列出，挑中的是最早写入的 c 和 d
    expect(plan.expire.map((b) => b.buildId)).toEqual(["c", "d"]);
    expect(plan.deferred.map((b) => b.buildId)).toEqual(["a", "b"]);
  });

  it("已挂着规则、仍该删的 build 不因名额被摘掉，哪怕规则要改写", () => {
    const ruled = ids("ruled", 10);
    const own = ruled.map((id, i) => ownRule(id, i === 0 ? { expireDays: 7 } : {}));
    // 分批时只挂到上限减余量，这里留给新规则的正好一条
    const news = ids("new", RESERVED_RULES + 2);
    const plan = makePlan(
      input({
        existing: ["online1", ...ruled, ...news],
        current: lifecycle(own, foreign(MAX_RULES - RESERVED_RULES - 11)),
      }),
    );
    expect(plan.nextDoc.own.map((r) => r.buildId)).toEqual([...ruled, news[0]]);
    expect(plan.expire.find((b) => b.buildId === ruled[0])!.state).toBe("updated");
    expect(plan.deferred.map((b) => b.buildId)).toEqual(news.slice(1));
  });

  it("剩余名额为 0 时新判作废的全部推迟，已有规则照旧，无需写入", () => {
    const ruled = ids("ruled", 5);
    const plan = makePlan(
      input({
        existing: ["online1", ...ruled, "new1"],
        current: lifecycle(ruled.map((id) => ownRule(id)), foreign(MAX_RULES - 5)),
      }),
    );
    expect(plan.expire.map((b) => b.buildId)).toEqual(ruled);
    expect(plan.deferred).toEqual([{ buildId: "new1" }]);
    expect(plan.changed).toBe(false);
  });

  it("本趟回收的规则空出的名额当场就能用", () => {
    const plan = makePlan(
      input({
        existing: ["online1", "new1"],
        current: lifecycle([ownRule("gone")], foreign(MAX_RULES - 1)),
      }),
    );
    expect(plan.reclaim).toEqual([{ buildId: "gone", reason: "emptied" }]);
    expect(plan.expire.map((b) => b.buildId)).toEqual(["new1"]);
    expect(plan.deferred).toEqual([]);
  });

  it("用户的规则已挤进余量时把余量让给本工具，每轮仍能挂上几条", () => {
    const plan = makePlan(
      input({ existing: ["online1", ...ids("old", 20)], current: lifecycle([], foreign(MAX_RULES - 5)) }),
    );
    expect(plan.expire).toHaveLength(5);
    expect(plan.deferred).toHaveLength(15);
  });

  it("名额被本工具为别的前缀写的规则占满时只推迟、不中止：那个前缀删完会自己回收", () => {
    const others = otherSite(MAX_RULES - 300);
    const plan = makePlan(
      input({
        existing: ["online1", "new1"],
        current: { ...lifecycle([], [...foreign(300), ...others.map((rule) => `<ID>${rule.id}</ID>`)]), others },
      }),
    );
    expect(plan.expire).toEqual([]);
    expect(plan.deferred).toEqual([{ buildId: "new1" }]);
    expect(plan.changed).toBe(false);
  });

  it("用户自己的规则占满上限、一条新规则都挂不上时中止，并说明怎么补救", () => {
    expect(() => makePlan(input({ current: lifecycle([], foreign(MAX_RULES)) }))).toThrow(
      /核对 lifecycle 规则名额时中止[\s\S]*1000 条[\s\S]*wrangler r2 bucket lifecycle list/,
    );
  });

  it("外部规则占满上限、但没有要新挂规则的 build 时照常通过", () => {
    const plan = makePlan(input({ existing: ["online1"], current: lifecycle([], foreign(MAX_RULES)) }));
    expect(plan.changed).toBe(false);
  });

  it("名额正好够时不推迟", () => {
    const plan = makePlan(input({ current: lifecycle([], foreign(MAX_RULES - 2)) }));
    expect(plan.expire.map((b) => b.buildId)).toEqual(["old1", "old2"]);
    expect(plan.deferred).toEqual([]);
  });

  it("全部挂得下时也只挂到上限减余量，余量照样留给用户", () => {
    const plan = makePlan(
      input({ existing: ["online1", ...ids("old", 495)], current: lifecycle([], foreign(500)) }),
    );
    expect(plan.expire).toHaveLength(MAX_RULES - RESERVED_RULES - 500);
    expect(plan.deferred).toHaveLength(495 - (MAX_RULES - RESERVED_RULES - 500));
  });

  it("用户的规则还没挤进余量时，总数不超过上限减余量", () => {
    const users = MAX_RULES - RESERVED_RULES - 5;
    const plan = makePlan(
      input({ existing: ["online1", ...ids("old", 20)], current: lifecycle([], foreign(users)) }),
    );
    expect(plan.expire).toHaveLength(5);
    expect(plan.nextDoc.own.length + plan.nextDoc.foreign.length).toBe(MAX_RULES - RESERVED_RULES);
  });

  it("弃用前缀（下面已经没有对象）的规则加上用户的规则占满名额时中止，并列出那些前缀", () => {
    const others = otherSite(MAX_RULES - RESERVED_RULES - 500);
    expect(() =>
      makePlan(
        input({
          existing: ["online1", "new1"],
          current: { ...lifecycle([], [...foreign(500), ...others.map((rule) => `<ID>${rule.id}</ID>`)]), others },
          emptyScopes: new Set(["site-b/"]),
        }),
      ),
    ).toThrow(/核对 lifecycle 规则名额时中止[\s\S]*site-b\/[\s\S]*wrangler r2 bucket lifecycle list/);
  });

  it("名额永远空不出来、但还有回收要写时先照常写入，不中止", () => {
    const others = otherSite(MAX_RULES - RESERVED_RULES - 500);
    const plan = makePlan(
      input({
        existing: ["online1", "new1"],
        current: {
          ...lifecycle([ownRule("online1")], [...foreign(500), ...others.map((rule) => `<ID>${rule.id}</ID>`)]),
          others,
        },
        emptyScopes: new Set(["site-b/"]),
      }),
    );
    expect(plan.reclaim).toEqual([{ buildId: "online1", reason: "revived" }]);
    expect(plan.deferred).toEqual([{ buildId: "new1" }]);
    expect(plan.changed).toBe(true);
  });

  it("skipRuleLimit 时不截断也不中止", () => {
    const plan = makePlan(input({ current: lifecycle([], foreign(MAX_RULES)), skipRuleLimit: true }));
    expect(plan.expire.map((b) => b.buildId)).toEqual(["old1", "old2"]);
    expect(plan.deferred).toEqual([]);
  });
});

describe("规则合并与回收", () => {
  const withRules = (own: OwnRule[], foreign: string[] = []): ParsedLifecycle => ({
    prefix: "incremental-cache/",
    own,
    foreign,
    others: [],
    malformed: [],
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

  it("同一个 build 有多条规则时，回收只列一次", () => {
    const plan = makePlan(
      input({
        current: withRules([ownRule("gone"), ownRule("gone", { prefix: "" }), ownRule("online1"), ownRule("online1")]),
      }),
    );
    expect(plan.reclaim).toEqual([
      { buildId: "gone", reason: "emptied" },
      { buildId: "online1", reason: "revived" },
    ]);
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

  it("已有规则的前缀被服务端丢掉（读回为空）时改写", () => {
    // 实测 R2 会静默丢掉裸 <Prefix>，读回来的规则没有前缀、实际作用于整个 bucket
    const plan = makePlan(input({ current: withRules([ownRule("old1", { prefix: "" })]) }));
    expect(plan.changed).toBe(true);
    expect(plan.expire.find((b) => b.buildId === "old1")!.state).toBe("updated");
    expect(plan.nextDoc.own.find((r) => r.buildId === "old1")!.prefix).toBe("incremental-cache/old1/");
  });

  it("同一个 build 有重复规则时算改写，不会因 Map 留下的恰是正确那条而显示成仍在删", () => {
    const plan = makePlan(
      input({ current: withRules([ownRule("old1", { prefix: "" }), ownRule("old1"), ownRule("old2")]) }),
    );
    expect(plan.changed).toBe(true);
    expect(plan.expire.find((b) => b.buildId === "old1")!.state).toBe("updated");
    expect(plan.expire.find((b) => b.buildId === "old2")!.state).toBe("pending");
    expect(plan.nextDoc.own.filter((r) => r.buildId === "old1")).toHaveLength(1);
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
    const plan = makePlan(input({ prefix: "", allowRootPrefix: true, current: { prefix: "", own: [], foreign: [], others: [], malformed: [] } }));
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
        current: { prefix: "incremental-cache/", own: [ownRule("gone")], foreign: [], others: [], malformed: [] },
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

describe("verifyWritten", () => {
  const doc = { prefix: "incremental-cache/", own: [ownRule("old1"), ownRule("old2")], foreign: ["<ID>mine</ID>"] };

  it("读回来一致时没有问题", () => {
    expect(verifyWritten(doc, structuredClone(doc))).toEqual({ own: [], foreign: [] });
  });

  it("前缀被丢掉、天数或状态不符、规则缺失或多出，都记为本工具规则的问题；外部规则条数单独列出", () => {
    const actual = {
      prefix: "incremental-cache/",
      own: [ownRule("old1", { prefix: "", expireDays: 2, enabled: false }), ownRule("extra")],
      foreign: [],
    };
    expect(verifyWritten(doc, actual)).toEqual({
      own: [
        "规则 old1 的前缀读回来是 空（作用于整个 bucket！），应为 incremental-cache/old1/",
        "规则 old1 的过期天数读回来是 2，应为 1",
        "规则 old1 的状态读回来是 停用，应为 启用",
        "规则 old2 读回来不见了",
        "读回来多出一条本工具的规则 extra",
      ],
      foreign: ["外部规则写入 1 条，读回来 0 条"],
    });
  });

  it("同一个 buildId 读回来多条时逐条核对，危险的那条不会被正确的那条盖住", () => {
    const actual = {
      prefix: "incremental-cache/",
      own: [ownRule("old1", { prefix: "" }), ownRule("old1"), ownRule("old2")],
      foreign: ["<ID>mine</ID>"],
    };
    expect(verifyWritten(doc, actual).own).toEqual([
      "规则 old1 读回来有 2 条",
      "规则 old1 的前缀读回来是 空（作用于整个 bucket！），应为 incremental-cache/old1/",
    ]);
  });

  it("只有外部规则条数不符时，本工具的规则没有问题", () => {
    expect(verifyWritten(doc, { ...structuredClone(doc), foreign: [] }).own).toEqual([]);
  });
});

describe("verifyWritten 报出裸 Prefix", () => {
  it("读回来只有裸 <Prefix> 时如实写出原值，并仍按整个 bucket 对待", () => {
    const doc = { prefix: "incremental-cache/", own: [ownRule("old1")], foreign: [] };
    const actual = {
      prefix: "incremental-cache/",
      own: [ownRule("old1", { prefix: "", barePrefix: "incremental-cache/old1/" })],
      foreign: [],
      others: [],
      malformed: [],
    };
    expect(verifyWritten(doc, actual).own).toEqual([
      "规则 old1 的前缀读回来是 空，只有 R2 不认的裸 <Prefix>incremental-cache/old1/（按作用于整个 bucket 对待！），应为 incremental-cache/old1/",
    ]);
    expect(wholeBucketRules(actual)).toEqual(["opennext-r2-prune:incremental-cache/old1/"]);
  });
});

describe("wholeBucketRules", () => {
  it("只挑出启用中、前缀为空的规则，按 ID 列出", () => {
    const doc = {
      prefix: "incremental-cache/",
      own: [ownRule("ok"), ownRule("bad", { prefix: "" }), ownRule("off", { prefix: "", enabled: false })],
      foreign: [],
      others: [],
      malformed: [],
    };
    expect(wholeBucketRules(doc)).toEqual(["opennext-r2-prune:incremental-cache/bad/"]);
  });

  it("别的前缀下的、格式不对的也报出来，且照 bucket 上的原样写出 ID", () => {
    const doc = {
      prefix: "incremental-cache/",
      own: [ownRule("b0", { prefix: "", id: "opennext-r2-prune:incremental-cache/b0" })],
      foreign: [],
      others: [
        // 前导斜杠的 scope 重新拼 ID 会被归一化掉，用户照着找不到
        { ...ownRule("b1", { prefix: "" }), id: "opennext-r2-prune:/old-cache/b1/", scope: "/old-cache/" },
        { ...ownRule("b2", { prefix: "old-cache/b2/" }), id: "opennext-r2-prune:old-cache/b2/", scope: "old-cache/" },
      ],
      malformed: [
        { id: "opennext-r2-prune:", prefix: "", expireDays: 1, enabled: true },
        { id: "opennext-r2-prune:/", prefix: "x/", expireDays: 1, enabled: true },
      ],
    };
    expect(wholeBucketRules(doc)).toEqual([
      "opennext-r2-prune:incremental-cache/b0",
      "opennext-r2-prune:/old-cache/b1/",
      "opennext-r2-prune:",
    ]);
  });
});

describe("多个前缀共用 bucket", () => {
  const other = (scope: string) => ({ ...ownRule("x", { prefix: `${scope}x/` }), id: `opennext-r2-prune:${scope}x/`, scope });
  const withOthers = (prefix: string, ...scopes: string[]): ParsedLifecycle => ({
    prefix,
    own: [],
    foreign: scopes.map(() => "<ID>placeholder</ID>"),
    others: scopes.map(other),
    malformed: [],
  });

  it("别的前缀与本前缀互不嵌套时照常计算", () => {
    const plan = makePlan(input({ current: withOthers("incremental-cache/", "site-b/", "incremental-cache-2/") }));
    expect(plan.expire.map((e) => e.buildId)).toEqual(["old1", "old2"]);
  });

  it("别的前缀在本前缀之下时中止：本前缀的一级目录里就有那个站点", () => {
    expect(() => makePlan(input({ current: withOthers("incremental-cache/", "incremental-cache/nested/") }))).toThrow(
      /互相嵌套/,
    );
  });

  it("本前缀在别的前缀之下时同样中止", () => {
    expect(() =>
      makePlan(input({ prefix: "site-a/nested", current: withOthers("site-a/nested/", "site-a/") })),
    ).toThrow(/互相嵌套/);
  });

  it("前缀为空、而 bucket 上有别的前缀的规则时中止", () => {
    expect(() =>
      makePlan(input({ prefix: "", allowRootPrefix: true, current: withOthers("", "site-a/") })),
    ).toThrow(/互相嵌套/);
  });

  it("别的前缀嵌套时，报错里照原样列出那些规则的 ID", () => {
    expect(() => makePlan(input({ current: withOthers("incremental-cache/", "incremental-cache/nested/") }))).toThrow(
      "opennext-r2-prune:incremental-cache/nested/x/",
    );
  });

  it("规则 ID 超出长度上限时中止，说明是前缀太长", () => {
    const prefix = `${"p".repeat(240)}/`;
    expect(() => makePlan(input({ prefix, current: withOthers(prefix) }))).toThrow(/更短的 --prefix/);
  });

  it("目录名本身就让 ID 超长时，不叫人换前缀", () => {
    const long = "d".repeat(240);
    const error = (() => {
      try {
        makePlan(input({ existing: ["online1", long], current: withOthers("incremental-cache/") }));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(PlanError);
    expect(error!.message).toMatch(/目录名本身就太长/);
    expect(error!.message).not.toMatch(/更短的 --prefix/);
  });

  it("有格式不对的本工具规则时中止，并点出其中对整个 bucket 生效的", () => {
    const current = {
      ...withOthers("incremental-cache/"),
      malformed: [{ id: "opennext-r2-prune:", prefix: "", expireDays: 1, enabled: true }],
    };
    expect(() => makePlan(input({ current }))).toThrow(XmlAssumptionError);
    expect(() => makePlan(input({ current }))).toThrow(/opennext-r2-prune:（没有 <Filter><Prefix>，正对整个 bucket 生效！）/);
  });

  it("计划用的前缀与配置分拣时的前缀不一致时中止", () => {
    expect(() => makePlan(input({ current: withOthers("site-b/") }))).toThrow(/内部错误/);
  });
});
