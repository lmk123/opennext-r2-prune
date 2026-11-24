import { describe, expect, it } from "vitest";
import { BuildIdProbeError } from "../src/build-id.ts";
import { CloudflareApi } from "../src/cloudflare.ts";
import { collectPlan, writeAndVerify } from "../src/run.ts";
import { PlanError } from "../src/plan.ts";
import { R2Store, S3Error } from "../src/store.ts";
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

  it("探测不到线上 build 时直接失败，不发任何写请求", async () => {
    const { store, calls } = fakeR2({ buildIds: ["live", "old1"] });
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        siteUrl: "https://example.com",
        fetchImpl: siteReplying("<html>404</html>", { headers: { "content-type": "text/html" } }),
      }),
    ).rejects.toThrow(/HTML[\s\S]*请改用 --keep/);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
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
  /** deployment 每页几条；不给就一页装下全部 */
  deploymentsPerPage?: number;
  versions: Record<string, string | null>;
  previews?: Record<string, string>;
}) {
  const probed: string[] = [];
  const deploymentPages: number[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    const json = (result: unknown) => new Response(JSON.stringify({ success: true, result }));

    if (url.hostname === "api.cloudflare.com") {
      if (url.pathname.endsWith("/deployments")) {
        // 没有 result_info，客户端会一直翻到空页
        const page = Number(url.searchParams.get("page"));
        deploymentPages.push(page);
        const size = opts.deploymentsPerPage ?? opts.deployments.length;
        return json({
          deployments: opts.deployments.slice((page - 1) * size, page * size).map((ids, i) => ({
            id: `d${(page - 1) * size + i}`,
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

  return { probed, deploymentPages, fetchImpl, api: new CloudflareApi({ accountId: "acct", apiToken: "tok", fetchImpl }) };
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
    expect(state.cloudflare).toEqual({ deploymentsScanned: 5, recentBuilds: 3, previews: 0 });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("deployment 翻完仍凑不够名额时，如实回报凑到了几个", async () => {
    const cf = fakeCloudflare({
      deployments: [["v3"], ["v2"], ["v1"]],
      versions: { v3: "b2", v2: "b2", v1: "b1" },
    });
    const { store } = fakeR2({ buildIds: ["b2", "b1", "b0"] });
    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      cloudflare: { api: cf.api, worker: "w", recentBuilds: 3 },
      fetchImpl: cf.fetchImpl,
    });
    expect(state.cloudflare).toEqual({ deploymentsScanned: 3, recentBuilds: 2, previews: 0 });
  });

  it("先列 bucket 再探测：探测期间新上传的 build 不会被判作废", async () => {
    const cf = fakeCloudflare({ deployments: [["v1"]], versions: { v1: "live" } });
    const buildIds = ["live", "old"];
    const { store } = fakeR2({ buildIds });
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      // 模拟探测进行到一半时 CI 刚好上传了新 build 的缓存
      if (new URL(input).hostname.endsWith("workers.dev")) buildIds.push("fresh");
      return cf.fetchImpl(input, init);
    }) as unknown as typeof fetch;

    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      cloudflare: { api: cf.api, worker: "w" },
      fetchImpl,
    });
    expect(buildIds).toContain("fresh");
    expect(state.plan.expire.map((b) => b.buildId)).toEqual(["old"]);
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

  it("一条线失败时中止另一条上还在退避重试的请求，不把进程拖住", async () => {
    const cf = fakeCloudflare({
      deployments: [["v1"]],
      versions: { v1: "live" },
      previews: { broken: "<fail>" },
    });
    let v1Probes = 0;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      if (new URL(input).hostname.startsWith("v1-")) {
        v1Probes++;
        // 限流且要求等一分钟：不中止的话这里会一直挂着
        return new Response("busy", { status: 429, headers: { "retry-after": "60" } });
      }
      return cf.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    const { store } = fakeR2({ buildIds: ["live"] });

    const started = Date.now();
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        cloudflare: {
          api: new CloudflareApi({ accountId: "acct", apiToken: "tok", fetchImpl }),
          worker: "w",
        },
        fetchImpl,
      }),
    ).rejects.toThrow(/预览 broken/);
    // 给被中止的退避一点时间收尾，确认它没有再发请求
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(v1Probes).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
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

  it("第一页凑不够时按需往后翻页，凑够就不再翻", async () => {
    const cf = fakeCloudflare({
      // 前两页全是只改了 secret 的部署
      deployments: [["v5"], ["v4"], ["v3"], ["v2"], ["v1"], ["v0"]],
      deploymentsPerPage: 2,
      versions: { v5: "b2", v4: "b2", v3: "b2", v2: "b2", v1: "b1", v0: "b0" },
    });
    const { store } = fakeR2({ buildIds: ["b2", "b1", "b0"] });
    const state = await collectPlan({
      store,
      prefix: "incremental-cache",
      cloudflare: { api: cf.api, worker: "w", recentBuilds: 2 },
      fetchImpl: cf.fetchImpl,
    });
    expect(state.plan.keep.map((b) => b.buildId)).toEqual(["b2", "b1"]);
    expect(state.cloudflare?.recentBuilds).toBe(2);
    expect(cf.deploymentPages).toEqual([1, 2, 3]);
  });

  it("站点探测失败时中止在途的 Cloudflare 探测", async () => {
    const cf = fakeCloudflare({ deployments: [["v1"]], versions: { v1: "live" } });
    const { store } = fakeR2({ buildIds: ["live"] });
    let cfAborted = false;
    let cfProbing!: () => void;
    const cfStarted = new Promise<void>((resolve) => (cfProbing = resolve));
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname === "site.example") {
        // 等 Cloudflare 那条线的探测发出去再失败
        await cfStarted;
        return new Response("nope", { status: 404 });
      }
      if (url.hostname.endsWith("workers.dev")) {
        cfProbing();
        // 读版本 BUILD_ID 一直挂着，直到被中止
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => {
            cfAborted = true;
            reject(init.signal!.reason);
          }),
        );
      }
      return cf.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        siteUrl: "https://site.example",
        cloudflare: { api: cf.api, worker: "w" },
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(cfAborted).toBe(true);
  });

  it("只走 Cloudflare 时 online 的保留项就是最新 deployment 的 build", async () => {
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
    const online = state.plan.keep.filter((b) => b.reason === "online");
    expect(online.map((b) => b.buildId)).toEqual(["bNew", "bOld"]);
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

  it("任何一个预览读不到 BUILD_ID 就整体失败，不发任何写请求", async () => {
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
    expect(calls.every((c) => c.method === "GET")).toBe(true);
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
    expect(calls.every((c) => c.method === "GET")).toBe(true);
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

/**
 * 有状态的假 R2：PUT 进来的配置存下来，GET 时经 mangle 处理后返回，用来模拟服务端的静默改写。
 * mangle 收到的第二个参数是第几次 GET（从 0 起），可以模拟「刚写完读到旧配置」。
 */
function statefulR2(
  opts: {
    mangle?: (xml: string, getIndex: number) => string;
    /** 第几次 PUT（从 0 起）起，之后的 GET 全部失败 */
    failGetAfterPut?: number;
    failSecondPut?: boolean;
    /** 第一次 PUT 报错；applied = 报错前其实已经写进去了（比如响应在路上丢了） */
    firstPutError?: "applied" | "rejected";
  } = {},
) {
  const puts: string[] = [];
  let gets = 0;
  let putCalls = 0;
  let stored = "<LifecycleConfiguration><Rule><ID>mine</ID><Status>Enabled</Status><Filter><Prefix>logs/</Prefix></Filter><Expiration><Days>30</Days></Expiration></Rule></LifecycleConfiguration>";
  const fetchImpl = (async (request: Request) => {
    if (request.method === "PUT") {
      if (opts.firstPutError && putCalls++ === 0) {
        if (opts.firstPutError === "applied") {
          puts.push(await request.text());
          stored = puts[puts.length - 1]!;
        }
        return new Response("<Error><Code>RequestTimeout</Code></Error>", { status: 400 });
      }
      if (opts.failSecondPut && puts.length === 1) {
        return new Response("<Error><Code>InternalError</Code></Error>", { status: 400 });
      }
      puts.push(await request.text());
      stored = puts[puts.length - 1]!;
      return new Response("", { status: 200 });
    }
    if (opts.failGetAfterPut !== undefined && puts.length > opts.failGetAfterPut) {
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    }
    return new Response((opts.mangle ?? ((x) => x))(stored, gets++), { status: 200 });
  }) as unknown as typeof fetch;
  return { puts, store: new R2Store({ ...CREDS, fetchImpl }), getCount: () => gets };
}

const FOREIGN = "<ID>mine</ID><Status>Enabled</Status><Filter><Prefix>logs/</Prefix></Filter><Expiration><Days>30</Days></Expiration>";
const DOC = {
  own: [{ buildId: "old1", prefix: "incremental-cache/old1/", expireDays: 1, enabled: true }],
  foreign: [FOREIGN],
};
const NO_WAIT = { sleep: async () => {} };
const dropOwnPrefix = (xml: string) =>
  xml.replace(/<Filter><Prefix>incremental-cache\/[^<]*<\/Prefix><\/Filter>/g, "");

describe("writeAndVerify", () => {
  it("回读一致时只写一次", async () => {
    const { puts, store } = statefulR2();
    const result = await writeAndVerify(store, DOC, NO_WAIT);
    expect(result).toEqual({ problems: [], warnings: [], rolledBack: null });
    expect(puts).toHaveLength(1);
  });

  it("刚写完读到旧配置时隔一会儿重读，读到一致就不撤销", async () => {
    const before = "<LifecycleConfiguration><Rule>" + FOREIGN + "</Rule></LifecycleConfiguration>";
    const sleeps: number[] = [];
    const { puts, store } = statefulR2({ mangle: (xml, i) => (i === 0 ? before : xml) });
    const result = await writeAndVerify(store, DOC, {
      sleep: async (ms) => void sleeps.push(ms),
      readBackDelayMs: 10,
    });
    expect(result.rolledBack).toBeNull();
    expect(sleeps).toEqual([10]);
    expect(puts).toHaveLength(1);
  });

  it("服务端丢掉前缀时报出问题，撤掉本工具的全部规则、保留外部规则，并回读确认撤销", async () => {
    // 模拟实测到的 R2 行为：规则里的前缀被丢掉，删除规则变成作用于整个 bucket
    const { puts, store, getCount } = statefulR2({ mangle: dropOwnPrefix });
    const result = await writeAndVerify(store, DOC, NO_WAIT);
    expect(result.rolledBack).toBe(true);
    expect(result.problems.join()).toContain("作用于整个 bucket");
    expect(puts).toHaveLength(2);
    expect(puts[1]).not.toContain("opennext-r2-prune:");
    expect(puts[1]).toContain("<ID>mine</ID>");
    // 写入后读满 3 次仍不符，撤销后再读 1 次确认
    expect(getCount()).toBe(4);
  });

  it("自有规则的 ID 被改得认不出时，撤销用写入前的外部规则，不会把它当外部规则留下", async () => {
    const { puts, store } = statefulR2({
      mangle: (xml) => dropOwnPrefix(xml).replace("<ID>opennext-r2-prune:old1</ID>", "<ID>renamed</ID>"),
    });
    const result = await writeAndVerify(store, DOC, NO_WAIT);
    expect(result.problems).toContain("规则 old1 读回来不见了");
    expect(result.rolledBack).toBe(true);
    expect(puts[1]).not.toContain("renamed");
    expect(puts[1]).toContain("<ID>mine</ID>");
  });

  it("撤销也失败时如实报告", async () => {
    const { store } = statefulR2({ mangle: dropOwnPrefix, failSecondPut: true });
    const result = await writeAndVerify(store, DOC, NO_WAIT);
    expect(result.rolledBack).toBe(false);
    expect(result.rollbackError).toBeDefined();
  });

  it("撤销写入成功、但读回来仍有本工具的规则时，不报已撤销", async () => {
    // 撤销之后服务端仍返回带自有规则的旧配置
    const { store } = statefulR2({
      mangle: (xml, i) =>
        i < 3 ? dropOwnPrefix(xml) : "<LifecycleConfiguration><Rule><ID>opennext-r2-prune:old1</ID><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>",
    });
    const result = await writeAndVerify(store, DOC, NO_WAIT);
    expect(result.rolledBack).toBe(false);
    expect(String(result.rollbackError)).toContain("撤销后读回来仍有本工具的规则");
  });

  it("写入成功但回读失败时无从核对，照样撤销", async () => {
    const { puts, store } = statefulR2({ failGetAfterPut: 0 });
    const result = await writeAndVerify(store, DOC, NO_WAIT);
    expect(result.readBackError).toBeDefined();
    expect(puts).toHaveLength(2);
    expect(puts[1]).not.toContain("opennext-r2-prune:");
    // 撤销之后也读不回来，无法确认
    expect(result.rolledBack).toBe(false);
    expect(String(result.rollbackError)).toContain("回读确认失败");
  });

  it("只有外部规则条数不符时只给提示，不撤销本工具的规则", async () => {
    const { puts, store } = statefulR2({ mangle: (xml) => xml.replace(/<Rule><ID>mine<\/ID>[\s\S]*?<\/Rule>/, "") });
    const result = await writeAndVerify(store, DOC, NO_WAIT);
    expect(result.rolledBack).toBeNull();
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual(["外部规则写入 1 条，读回来 0 条"]);
    expect(puts).toHaveLength(1);
  });

  it("本工具的规则已核对一致时，不因外部规则不符而重读", async () => {
    const { store, getCount } = statefulR2({ mangle: (xml) => xml.replace(/<Rule><ID>mine<\/ID>[\s\S]*?<\/Rule>/, "") });
    await writeAndVerify(store, DOC, NO_WAIT);
    expect(getCount()).toBe(1);
  });

  it("撤销后读回来外部规则不符也要报出，不能只看本工具的规则", async () => {
    const { store } = statefulR2({
      mangle: (xml, i) => (i < 3 ? dropOwnPrefix(xml) : xml.replace(/<Rule><ID>mine<\/ID>[\s\S]*?<\/Rule>/, "")),
    });
    const result = await writeAndVerify(store, DOC, NO_WAIT);
    expect(result.rolledBack).toBe(true);
    expect(result.warnings).toContain("撤销后外部规则写入 1 条，读回来 0 条");
  });

  it("写入请求报错但其实已生效时，回读一致就当作已写入", async () => {
    const { puts, store } = statefulR2({ firstPutError: "applied" });
    const result = await writeAndVerify(store, DOC, NO_WAIT);
    expect(result.problems).toEqual([]);
    expect(result.rolledBack).toBeNull();
    expect(result.writeError).toBeInstanceOf(S3Error);
    expect(puts).toHaveLength(1);
  });

  it("写入请求报错且读回来仍是旧配置时，照常报写入失败，不撤销", async () => {
    const { puts, store } = statefulR2({ firstPutError: "rejected" });
    await expect(writeAndVerify(store, DOC, NO_WAIT)).rejects.toThrow(S3Error);
    expect(puts).toHaveLength(0);
  });

  it("写入请求报错、读回来却有对整个 bucket 生效的规则时，照样撤销", async () => {
    const { puts, store } = statefulR2({ firstPutError: "applied", mangle: dropOwnPrefix });
    const result = await writeAndVerify(store, DOC, NO_WAIT);
    expect(result.problems[0]).toContain("写入请求报错");
    expect(result.problems.join()).toContain("作用于整个 bucket");
    expect(result.rolledBack).toBe(true);
    expect(puts).toHaveLength(2);
    expect(puts[1]).not.toContain("opennext-r2-prune:");
  });
});

describe("collectPlan 报出对整个 bucket 生效的现有规则", () => {
  it("在探测之前回调，探测失败时也已经报过", async () => {
    const lifecycle = `<LifecycleConfiguration><Rule><ID>opennext-r2-prune:old1</ID><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>`;
    const { store, calls } = fakeR2({ buildIds: ["old1", "live"], lifecycle });
    const seen: string[][] = [];
    await expect(
      collectPlan({
        store,
        prefix: "incremental-cache",
        keep: [],
        onWholeBucketRules: (ids) => void seen.push(ids),
      }),
    ).rejects.toThrow(PlanError);
    expect(seen).toEqual([["old1"]]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("列目录失败时也先报出危险规则，再中止", async () => {
    const lifecycle = `<LifecycleConfiguration><Rule><ID>opennext-r2-prune:old1</ID><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>`;
    const fetchImpl = (async (request: Request) =>
      new URL(request.url).searchParams.has("lifecycle")
        ? new Response(lifecycle)
        : new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })) as unknown as typeof fetch;
    const seen: string[][] = [];
    await expect(
      collectPlan({
        store: new R2Store({ ...CREDS, fetchImpl }),
        prefix: "incremental-cache",
        keep: ["live"],
        onWholeBucketRules: (ids) => void seen.push(ids),
      }),
    ).rejects.toThrow(S3Error);
    expect(seen).toEqual([["old1"]]);
  });
});
