import { describe, expect, it } from "vitest";
import { collectPlan } from "../src/run.ts";
import { PlanError } from "../src/plan.ts";
import { R2Store } from "../src/store.ts";
import { XmlAssumptionError } from "../src/xml.ts";

/**
 * 端到端串一遍，重点盯住一件事：任何一条安全校验没过时，
 * 都不能有写请求发出去。
 */

const CREDS = {
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  bucket: "my-cache",
  accessKeyId: "ak",
  secretAccessKey: "sk",
};

/** 一个按 URL 派发的假 R2 */
function fakeR2(opts: { buildIds: string[]; lifecycle?: string }) {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (request: Request) => {
    const url = new URL(request.url);
    calls.push({ method: request.method, url: request.url });

    if (url.searchParams.has("lifecycle")) {
      if (request.method === "PUT") return new Response("", { status: 200 });
      return new Response(
        opts.lifecycle ?? "<Error><Code>NoSuchLifecycleConfiguration</Code></Error>",
        { status: opts.lifecycle ? 200 : 404 },
      );
    }

    const prefixes = opts.buildIds
      .map((id) => `<CommonPrefixes><Prefix>incremental-cache/${id}/</Prefix></CommonPrefixes>`)
      .join("");
    return new Response(
      `<ListBucketResult><IsTruncated>false</IsTruncated>${prefixes}</ListBucketResult>`,
    );
  }) as unknown as typeof fetch;

  return { calls, store: new R2Store({ ...CREDS, fetchImpl }) };
}

const siteReplying = (body: string, init: ResponseInit = {}) =>
  (async () => new Response(body, init)) as unknown as typeof fetch;

describe("collectPlan", () => {
  it("探测线上 build，其余标记作废", async () => {
    const { store, calls } = fakeR2({ buildIds: ["live", "old1", "old2"] });
    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      siteUrl: "https://example.com",
      fetchImpl: siteReplying("live", { headers: { "content-type": "text/plain" } }),
    });

    expect(state.onlineBuildId).toBe("live");
    expect(state.probedFrom).toBe("https://example.com/BUILD_ID");
    expect(state.plan.keep.map((b) => b.buildId)).toEqual(["live"]);
    expect(state.plan.expire.map((b) => b.buildId)).toEqual(["old1", "old2"]);
    expect(state.plan.changed).toBe(true);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("探测不到线上 build 时直接失败，一个 R2 请求都不发", async () => {
    const { store, calls } = fakeR2({ buildIds: ["live", "old1"] });
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        siteUrl: "https://example.com",
        fetchImpl: siteReplying("<html>404</html>", { headers: { "content-type": "text/html" } }),
      }),
    ).rejects.toThrow(/HTML/);
    expect(calls).toHaveLength(0);
  });

  it("线上 build 不在 bucket 里时失败，且没有写请求", async () => {
    const { store, calls } = fakeR2({ buildIds: ["old1", "old2"] });
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        siteUrl: "https://example.com",
        fetchImpl: siteReplying("live", { headers: { "content-type": "text/plain" } }),
      }),
    ).rejects.toThrow(PlanError);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("不传站点地址时只靠 --keep 判定", async () => {
    const { store } = fakeR2({ buildIds: ["b1", "b2"] });
    const state = await collectPlan({ store, prefix: "incremental-cache", keep: ["b1"] });
    expect(state.onlineBuildId).toBeNull();
    expect(state.plan.expire.map((b) => b.buildId)).toEqual(["b2"]);
  });

  it("发给 R2 的请求数与 build 数量无关", async () => {
    const olds = Array.from({ length: 50 }, (_, i) => `old${i}`);
    const { store, calls } = fakeR2({ buildIds: ["live", ...olds] });

    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      siteUrl: "https://example.com",
      fetchImpl: siteReplying("live", { headers: { "content-type": "text/plain" } }),
    });

    expect(state.plan.expire).toHaveLength(50);
    // 只有「列一次目录」和「读一次规则」，50 个 build 和 3 个 build 一样多
    expect(calls).toHaveLength(2);
  });

  it("目录名不符合布局假设时中止，不猜也不降级", async () => {
    // 这些值会被拿去拼删除规则，含 XML 转义字符就说明这个 bucket 不长 OpenNext 的样，
    // 那是别再往下写规则的信号
    const { store, calls } = fakeR2({ buildIds: ["live", "tmp &amp; scratch"] });

    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        siteUrl: "https://example.com",
        fetchImpl: siteReplying("live", { headers: { "content-type": "text/plain" } }),
      }),
    ).rejects.toThrow(XmlAssumptionError);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("已有规则的 build 目录清空后，规则被标记回收", async () => {
    const lifecycle = `<LifecycleConfiguration><Rule>
      <ID>opennext-r2-prune:gone</ID><Status>Enabled</Status>
      <Filter><Prefix>incremental-cache/gone/</Prefix></Filter>
      <Expiration><Days>1</Days></Expiration>
    </Rule></LifecycleConfiguration>`;
    const { store } = fakeR2({ buildIds: ["live"], lifecycle });

    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      siteUrl: "https://example.com",
      fetchImpl: siteReplying("live", { headers: { "content-type": "text/plain" } }),
    });

    expect(state.plan.reclaim).toEqual([{ buildId: "gone", reason: "emptied" }]);
    expect(state.plan.nextDoc.own).toHaveLength(0);
    expect(state.plan.changed).toBe(true);
  });
});
