import { describe, expect, it } from "vitest";
import { BuildIdProbeError } from "../src/build-id.ts";
import { CloudflareApi } from "../src/cloudflare.ts";
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
    ).rejects.toThrow(/HTML[\s\S]*请改用 --keep/);
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

/**
 * 一个假的 Cloudflare：API 与 workers.dev 上的 /BUILD_ID 共用一个 fetch。
 * versions 的值为 null 表示这个 version 没有可访问的 URL，"<fail>" 表示读 BUILD_ID 失败。
 */
function fakeCloudflare(opts: {
  deployments: string[][];
  versions: Record<string, string | null>;
  previews?: Record<string, string>;
}) {
  const probed: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const json = (result: unknown) => new Response(JSON.stringify({ success: true, result }));

    if (url.hostname === "api.cloudflare.com") {
      if (url.pathname.endsWith("/deployments")) {
        return json({
          deployments: opts.deployments.map((ids) => ({
            versions: ids.map((version_id) => ({ version_id, percentage: 100 / ids.length })),
          })),
        });
      }
      if (url.pathname.endsWith("/previews")) {
        // 只有一页：没有 result_info，所以客户端会一直翻到空页
        if (url.searchParams.get("page") !== "1") return json([]);
        return json(
          Object.keys(opts.previews ?? {}).map((name) => ({
            name,
            urls: [`https://${name}-w.sub.workers.dev`],
          })),
        );
      }
      const versionId = url.pathname.split("/").pop()!;
      const buildId = opts.versions[versionId];
      return json({ id: versionId, urls: buildId === null ? [] : [`https://${versionId}-w.sub.workers.dev`] });
    }

    // <id>-w.sub.workers.dev/BUILD_ID
    const id = url.hostname.split("-w.")[0]!;
    probed.push(id);
    const buildId = opts.versions[id] ?? opts.previews?.[id];
    // 用 404 而不是 5xx：5xx 会被重试，测试得白等退避
    if (buildId === "<fail>") return new Response("nope", { status: 404 });
    return new Response(buildId, { headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;

  return { probed, fetchImpl, api: new CloudflareApi({ accountId: "acct", apiToken: "tok", fetchImpl }) };
}

describe("collectPlan + Cloudflare API", () => {
  it("往回翻 deployment 凑够 3 个不同的 build，只改 secret 的部署不占名额", async () => {
    const cf = fakeCloudflare({
      // v5、v4 只是改了 secret，BUILD_ID 与 v3 相同
      deployments: [["v5"], ["v4"], ["v3"], ["v2"], ["v1"], ["v0"]],
      versions: { v5: "b3", v4: "b3", v3: "b3", v2: "b2", v1: "b1", v0: "b0" },
    });
    const { store, calls } = fakeR2({ buildIds: ["b3", "b2", "b1", "b0"] });

    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      cloudflare: { api: cf.api, worker: "w" },
      fetchImpl: cf.fetchImpl,
    });

    expect(state.plan.keep.map((b) => [b.buildId, b.reason])).toEqual([
      ["b3", "online"],
      ["b2", "recent"],
      ["b1", "recent"],
    ]);
    expect(state.plan.expire.map((b) => b.buildId)).toEqual(["b0"]);
    // 凑够就停，v0 不会被探测
    expect(cf.probed).not.toContain("v0");
    expect(state.cloudflare).toEqual({ deploymentsScanned: 5, previews: 0 });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("近期版本按窗口并发探测，只探凑数可能用到的 deployment", async () => {
    const cf = fakeCloudflare({
      // v4 只改了 secret；窗口 1 = v4..v2（凑到 b3、b2），窗口 2 只差 1 个 = v1
      deployments: [["v4"], ["v3"], ["v2"], ["v1"], ["v0"]],
      versions: { v4: "b3", v3: "b3", v2: "b2", v1: "b1", v0: "b0" },
    });
    const { store } = fakeR2({ buildIds: ["b3", "b2", "b1", "b0"] });
    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      cloudflare: { api: cf.api, worker: "w" },
      fetchImpl: cf.fetchImpl,
    });
    expect(state.plan.keep.map((b) => b.buildId)).toEqual(["b3", "b2", "b1"]);
    expect(cf.probed.filter((id) => id.startsWith("v")).sort()).toEqual(["v1", "v2", "v3", "v4"]);
    expect(state.cloudflare?.deploymentsScanned).toBe(4);
  });

  it("灰度的 deployment 占两个名额，凑够后窗口里不会多探", async () => {
    const cf = fakeCloudflare({
      // 最新 deployment 灰度（b3、b2 各一个 version），再往回一条就凑够 3 个；
      // v0 早于开启 preview_urls，读不到 —— 探了它就会误中止
      deployments: [["v3", "v2"], ["v1"], ["v0"]],
      versions: { v3: "b3", v2: "b2", v1: "b1", v0: null },
    });
    const { store } = fakeR2({ buildIds: ["b3", "b2", "b1", "bOld"] });
    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      cloudflare: { api: cf.api, worker: "w" },
      fetchImpl: cf.fetchImpl,
    });
    expect(state.plan.keep.map((b) => b.buildId)).toEqual(["b3", "b2", "b1"]);
    expect(cf.probed).not.toContain("v0");
    expect(state.cloudflare?.deploymentsScanned).toBe(2);
  });

  it("有一项探测失败后不再发起新的探测", async () => {
    const previews: Record<string, string> = { broken: "<fail>" };
    for (let i = 0; i < 20; i++) previews[`p${i}`] = `b${i}`;
    const cf = fakeCloudflare({ deployments: [["v1"]], versions: { v1: "live" }, previews });
    const { store } = fakeR2({ buildIds: ["live"] });
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        cloudflare: { api: cf.api, worker: "w" },
        fetchImpl: cf.fetchImpl,
        concurrency: 1,
      }),
    ).rejects.toThrow(/预览 broken/);
    // 并发 1 时 broken 排在第一个，之后的 20 个预览一个都不该再探
    expect(cf.probed.filter((id) => id.startsWith("p"))).toEqual([]);
  });

  it("concurrency 或 recentBuilds 小于 1 时照常工作，不留空洞也不卡死", async () => {
    const cf = fakeCloudflare({
      deployments: [["v2"], ["v1"]],
      versions: { v2: "b2", v1: "b1" },
      previews: { "feat-a": "bA" },
    });
    const { store } = fakeR2({ buildIds: ["b2", "b1", "bA"] });
    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      cloudflare: { api: cf.api, worker: "w", recentBuilds: 0 },
      fetchImpl: cf.fetchImpl,
      concurrency: 0,
    });
    expect(state.plan.keep.map((b) => b.buildId)).toEqual(["b2", "bA"]);
    expect(state.plan.expire.map((b) => b.buildId)).toEqual(["b1"]);
  });

  it("只走 Cloudflare 时 onlineBuildIds 给出最新 deployment 的 build", async () => {
    const cf = fakeCloudflare({
      deployments: [["vnew", "vold"], ["vold"]],
      versions: { vnew: "bNew", vold: "bOld" },
    });
    const { store } = fakeR2({ buildIds: ["bNew", "bOld"] });
    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      cloudflare: { api: cf.api, worker: "w" },
      fetchImpl: cf.fetchImpl,
    });
    expect(state.onlineBuildId).toBeNull();
    expect(state.onlineBuildIds).toEqual(["bNew", "bOld"]);
  });

  it("--recent-builds 可调", async () => {
    const cf = fakeCloudflare({
      deployments: [["v2"], ["v1"]],
      versions: { v2: "b2", v1: "b1" },
    });
    const { store } = fakeR2({ buildIds: ["b2", "b1"] });
    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      cloudflare: { api: cf.api, worker: "w", recentBuilds: 1 },
      fetchImpl: cf.fetchImpl,
    });
    expect(state.plan.keep.map((b) => b.buildId)).toEqual(["b2"]);
    expect(state.plan.expire.map((b) => b.buildId)).toEqual(["b1"]);
  });

  it("灰度中的两个 version 都算线上", async () => {
    const cf = fakeCloudflare({
      deployments: [["vnew", "vold"], ["vold"]],
      versions: { vnew: "bNew", vold: "bOld" },
    });
    const { store } = fakeR2({ buildIds: ["bNew", "bOld", "ancient"] });
    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      cloudflare: { api: cf.api, worker: "w" },
      fetchImpl: cf.fetchImpl,
    });
    expect(state.plan.keep.map((b) => [b.buildId, b.reason])).toEqual([
      ["bNew", "online"],
      ["bOld", "online"],
    ]);
    // 同一个 version 只探一次
    expect(cf.probed.filter((id) => id === "vold")).toHaveLength(1);
  });

  it("保留全部预览的 build；预览的 build 不在 bucket 里不算错", async () => {
    const cf = fakeCloudflare({
      deployments: [["v1"]],
      versions: { v1: "live" },
      previews: { "feat-a": "bA", "feat-b": "bB", "feat-c": "live" },
    });
    const { store } = fakeR2({ buildIds: ["live", "bA", "old"] });
    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      cloudflare: { api: cf.api, worker: "w" },
      fetchImpl: cf.fetchImpl,
    });
    expect(state.plan.keep).toEqual([
      { buildId: "live", reason: "online", source: "version v1" },
      { buildId: "bA", reason: "preview", source: "feat-a" },
    ]);
    expect(state.plan.absent).toEqual([{ buildId: "bB", reason: "preview", source: "feat-b" }]);
    expect(state.plan.expire.map((b) => b.buildId)).toEqual(["old"]);
  });

  it("任何一个预览读不到 BUILD_ID 就整体失败，一个 R2 请求都不发", async () => {
    const cf = fakeCloudflare({
      deployments: [["v1"]],
      versions: { v1: "live" },
      previews: { "feat-a": "bA", broken: "<fail>" },
    });
    const { store, calls } = fakeR2({ buildIds: ["live", "bA", "bX"] });
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        cloudflare: { api: cf.api, worker: "w" },
        fetchImpl: cf.fetchImpl,
      }),
    ).rejects.toThrow(/预览 broken/);
    // --keep 救不了读不到的预览，不能拿它当建议
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        cloudflare: { api: cf.api, worker: "w" },
        fetchImpl: cf.fetchImpl,
      }),
    ).rejects.toThrow(/Cloudflare Access[\s\S]*去掉 --worker/);
    expect(calls).toHaveLength(0);
  });

  it("历史版本读不到 BUILD_ID 同样整体失败", async () => {
    const cf = fakeCloudflare({
      deployments: [["v2"], ["v1"]],
      versions: { v2: "live", v1: "<fail>" },
    });
    const { store, calls } = fakeR2({ buildIds: ["live", "old"] });
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        cloudflare: { api: cf.api, worker: "w" },
        fetchImpl: cf.fetchImpl,
      }),
    ).rejects.toThrow(BuildIdProbeError);
    expect(calls).toHaveLength(0);
  });

  it("version 没有可访问的 URL 时失败并说明原因", async () => {
    const cf = fakeCloudflare({ deployments: [["v1"]], versions: { v1: null } });
    const { store } = fakeR2({ buildIds: ["live"] });
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        cloudflare: { api: cf.api, worker: "w" },
        fetchImpl: cf.fetchImpl,
      }),
    ).rejects.toThrow(/没有可访问的 URL[\s\S]*Durable Object/);
  });

  it("线上 build 不在 bucket 里仍然报错", async () => {
    const cf = fakeCloudflare({ deployments: [["v1"]], versions: { v1: "live" } });
    const { store } = fakeR2({ buildIds: ["old"] });
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        cloudflare: { api: cf.api, worker: "w" },
        fetchImpl: cf.fetchImpl,
      }),
    ).rejects.toThrow(PlanError);
  });

  it("Worker 没有任何 deployment 时拒绝继续", async () => {
    const cf = fakeCloudflare({ deployments: [], versions: {} });
    const { store } = fakeR2({ buildIds: ["b1"] });
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        cloudflare: { api: cf.api, worker: "w" },
        fetchImpl: cf.fetchImpl,
      }),
    ).rejects.toThrow(/没有任何 deployment/);
  });
});
