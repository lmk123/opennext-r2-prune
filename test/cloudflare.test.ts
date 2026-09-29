import { describe, expect, it, vi } from "vitest";
import { CloudflareApi, CloudflareApiError } from "../src/cloudflare.ts";

const ok = (result: unknown, resultInfo?: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], result, result_info: resultInfo }), {
    headers: { "content-type": "application/json" },
  });

function api(handler: (url: URL, init?: RequestInit) => Response) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(url);
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, api: new CloudflareApi({ accountId: "acct", apiToken: "tok", fetchImpl }) };
}

describe("CloudflareApi", () => {
  it("带 Bearer token 列 deployments，保留每条的全部 version", async () => {
    let auth: string | null = null;
    const { api: cf, calls } = api((_, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return ok({
        deployments: [
          { versions: [{ version_id: "v2", percentage: 90 }, { version_id: "v1", percentage: 10 }] },
          { versions: [{ version_id: "v1", percentage: 100 }] },
        ],
      });
    });

    const deployments = await cf.listDeployments("my-worker");
    expect(deployments).toEqual([{ versionIds: ["v2", "v1"] }, { versionIds: ["v1"] }]);
    expect(auth).toBe("Bearer tok");
    expect(calls[0]!.pathname).toBe(
      "/client/v4/accounts/acct/workers/scripts/my-worker/deployments",
    );
     // 默认页太小，只改配置的部署一多就凑不够近期 build
    expect(calls[0]!.searchParams.get("per_page")).toBe("100");
  });

  it("result_info 的字段为 null 时不当成终点，继续翻页", async () => {
    const { api: cf } = api((url) => {
      const page = Number(url.searchParams.get("page"));
      const items = page <= 2 ? [{ name: `p${page}` }] : [];
      return ok(items, { page, per_page: null, total_pages: null, total_count: null });
    });
    expect((await cf.listPreviews("w")).map((p) => p.name)).toEqual(["p1", "p2"]);
  });

  it("读 version 的 urls", async () => {
    const { api: cf, calls } = api(() =>
      ok({ id: "v1", urls: ["https://aaaaaaaa-my-worker.sub.workers.dev"] }),
    );
    expect(await cf.getVersionUrls("my-worker", "v1")).toEqual([
      "https://aaaaaaaa-my-worker.sub.workers.dev",
    ]);
    expect(calls[0]!.pathname).toBe("/client/v4/accounts/acct/workers/workers/my-worker/versions/v1");
  });

  it("预览按 total_pages 翻页；多页时再列一遍核对", async () => {
    const { api: cf, calls } = api((url) => {
      const page = Number(url.searchParams.get("page"));
      return ok([{ name: `p${page}`, urls: [`https://p${page}-w.sub.workers.dev`] }], {
        page,
        total_pages: 2,
      });
    });
    const previews = await cf.listPreviews("w");
    expect(previews.map((p) => p.name)).toEqual(["p1", "p2"]);
    expect(calls).toHaveLength(4);
  });

  it("没有 result_info 时一直翻到空页，不拿「没装满」当终点", async () => {
    const { api: cf, calls } = api((url) =>
      url.searchParams.get("page") === "1" ? ok([{ name: "only" }]) : ok([]),
    );
    expect(await cf.listPreviews("w")).toEqual([{ name: "only", urls: [] }]);
    // 发了两个请求才列完，所以要再列一遍核对
    expect(calls).toHaveLength(4);
  });

  it("服务端把每页压到 50 条时照样翻完，不漏预览", async () => {
    const all = Array.from({ length: 120 }, (_, i) => ({ name: `p${i}` }));
    const { api: cf, calls } = api((url) => {
      const page = Number(url.searchParams.get("page"));
      return ok(all.slice((page - 1) * 50, page * 50), { page, per_page: 50, total_count: 120 });
    });
    expect(await cf.listPreviews("w")).toHaveLength(120);
    expect(calls).toHaveLength(6);
  });

  it("只回报了 per_page 时，按它判断最后一页", async () => {
    const { api: cf, calls } = api((url) => {
      const page = Number(url.searchParams.get("page"));
      const names = page === 1 ? ["a", "b"] : ["c"];
      return ok(names.map((name) => ({ name })), { page, per_page: 2 });
    });
    expect((await cf.listPreviews("w")).map((p) => p.name)).toEqual(["a", "b", "c"]);
    expect(calls).toHaveLength(4);
  });

  it("page 参数被忽略（比如其实是游标分页）时，每一遍第二页都重复，列满次数后中止", async () => {
    const { api: cf, calls } = api(() => ok([{ name: "a" }, { name: "b" }], { cursor: "next" }));
    await expect(cf.listPreviews("w")).rejects.toMatchObject({
      code: "pagination",
      message: expect.stringContaining("分页参数可能没被接受"),
    });
    // 每遍在第二页发现重复就停
    expect(calls).toHaveLength(6);
  });

  it("翻页间有预览新建、导致重复时，重列一遍而不是直接中止", async () => {
    // 第一遍：读完第 1 页后新建了 n（排在最前），b 被挤到第 2 页 —— b 出现两次
    const lists = [
      [["a", "b"], ["b", "c"]],
      [["n", "a"], ["b", "c"]],
      [["n", "a"], ["b", "c"]],
    ];
    let listing = 0;
    const { api: cf } = api((url) => {
      const page = Number(url.searchParams.get("page"));
      const names = lists[Math.min(listing, lists.length - 1)]![page - 1]!;
      if (page === 2) listing++;
      return ok(names.map((name) => ({ name })), { page, total_pages: 2 });
    });
    expect((await cf.listPreviews("w")).map((p) => p.name)).toEqual(["n", "a", "b", "c"]);
  });

  it("两遍之间只是顺序变了（集合相同）时照常采用", async () => {
    const lists = [
      [["a", "b"], ["c"]],
      [["b", "a"], ["c"]],
    ];
    let listing = 0;
    const { api: cf, calls } = api((url) => {
      const page = Number(url.searchParams.get("page"));
      const names = lists[Math.min(listing, lists.length - 1)]![page - 1]!;
      if (page === 2) listing++;
      return ok(names.map((name) => ({ name })), { page, total_pages: 2 });
    });
    expect((await cf.listPreviews("w")).map((p) => p.name)).toEqual(["b", "a", "c"]);
    expect(calls).toHaveLength(4);
  });

  it("分页参数不被认、每页都满时不会无限翻下去", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `p${i}` }));
    const { api: cf } = api(() => ok(full));
    await expect(cf.listPreviews("w")).rejects.toThrow(CloudflareApiError);
  });

  it("接口压根不分页（两页都不带 result_info、内容相同、没装满）时认第一页为全部", async () => {
    const { api: cf, calls } = api(() => ok([{ name: "a" }, { name: "b" }]));
    expect((await cf.listPreviews("w")).map((p) => p.name)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
  });

  it("result 为 null 时当作空列表，而不是甩原生 TypeError", async () => {
    const { api: cf } = api(() => ok(null));
    expect(await cf.listPreviews("w")).toEqual([]);
    expect(await cf.listDeployments("w")).toEqual([]);
    expect(await cf.getVersionUrls("w", "v1")).toEqual([]);
  });

  it("翻页间有预览被删、导致漏项时，靠再列一遍发现并采用稳定的结果", async () => {
    // 第一遍：读完第 1 页后 a 被删，b 前移进了第 1 页，第 2 页从 c 开始 —— b 被漏掉
    const lists = [
      [["a", "x"], ["c"]],
      [["x", "b"], ["c"]],
      [["x", "b"], ["c"]],
    ];
    let listing = 0;
    const { api: cf } = api((url) => {
      const page = Number(url.searchParams.get("page"));
      const names = lists[Math.min(listing, lists.length - 1)]![page - 1]!;
      if (page === 2) listing++;
      return ok(names.map((name) => ({ name })), { page, total_pages: 2 });
    });
    expect((await cf.listPreviews("w")).map((p) => p.name)).toEqual(["x", "b", "c"]);
  });

  it("每次列举结果都不一致时中止", async () => {
    let listing = 0;
    const { api: cf } = api((url) => {
      const page = Number(url.searchParams.get("page"));
      if (page === 2) listing++;
      return ok([{ name: `l${listing}-p${page}` }], { page, total_pages: 2 });
    });
    await expect(cf.listPreviews("w")).rejects.toMatchObject({ code: "pagination" });
  });

  it("429 时按 Retry-After 等待再重试", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const { api: cf } = api(() => {
        call++;
        if (call === 1) {
          return new Response(JSON.stringify({ success: false, errors: [] }), {
            status: 429,
            headers: { "retry-after": "5" },
          });
        }
        return ok({ deployments: [] });
      });
      const result = cf.listDeployments("w");
      await vi.advanceTimersByTimeAsync(4000);
      expect(call).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toEqual([]);
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("success=false 时抛出带错误码的 CloudflareApiError", async () => {
    const { api: cf } = api(
      () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 10007, message: "not found" }] }),
          { status: 404 },
        ),
    );
    await expect(cf.listDeployments("w")).rejects.toMatchObject({
      name: "CloudflareApiError",
      status: 404,
      code: "10007",
    });
  });

  it("网络层失败重试耗尽后归成 CloudflareApiError，不甩原生错误", async () => {
    vi.useFakeTimers();
    try {
      const { api: cf, calls } = api(() => {
        throw new TypeError("fetch failed");
      });
      const result = expect(cf.listDeployments("w")).rejects.toMatchObject({
        name: "CloudflareApiError",
        code: "network",
      });
      await vi.runAllTimersAsync();
      await result;
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("响应不是 JSON 时给出可读的错误", async () => {
    const { api: cf } = api(() => new Response("<html>oops</html>", { status: 403 }));
    await expect(cf.listDeployments("w")).rejects.toThrow(/不是 JSON/);
  });
});
