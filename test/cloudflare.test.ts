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

  it("预览按 total_pages 翻页", async () => {
    const { api: cf, calls } = api((url) => {
      const page = Number(url.searchParams.get("page"));
      return ok([{ name: `p${page}`, urls: [`https://p${page}-w.sub.workers.dev`] }], {
        page,
        total_pages: 2,
      });
    });
    const previews = await cf.listPreviews("w");
    expect(previews.map((p) => p.name)).toEqual(["p1", "p2"]);
    expect(calls).toHaveLength(2);
  });

  it("没有 result_info 时一直翻到空页，不拿「没装满」当终点", async () => {
    const { api: cf, calls } = api((url) =>
      url.searchParams.get("page") === "1" ? ok([{ name: "only" }]) : ok([]),
    );
    expect(await cf.listPreviews("w")).toEqual([{ name: "only", urls: [] }]);
    expect(calls).toHaveLength(2);
  });

  it("服务端把每页压到 50 条时照样翻完，不漏预览", async () => {
    const all = Array.from({ length: 120 }, (_, i) => ({ name: `p${i}` }));
    const { api: cf, calls } = api((url) => {
      const page = Number(url.searchParams.get("page"));
      return ok(all.slice((page - 1) * 50, page * 50), { page, per_page: 50, total_count: 120 });
    });
    expect(await cf.listPreviews("w")).toHaveLength(120);
    expect(calls).toHaveLength(3);
  });

  it("只回报了 per_page 时，按它判断最后一页", async () => {
    const { api: cf, calls } = api((url) => {
      const page = Number(url.searchParams.get("page"));
      const names = page === 1 ? ["a", "b"] : ["c"];
      return ok(names.map((name) => ({ name })), { page, per_page: 2 });
    });
    expect((await cf.listPreviews("w")).map((p) => p.name)).toEqual(["a", "b", "c"]);
    expect(calls).toHaveLength(2);
  });

  it("page 参数被忽略（比如其实是游标分页）时，第二页重复即中止", async () => {
    const { api: cf, calls } = api(() => ok([{ name: "a" }, { name: "b" }], { cursor: "next" }));
    await expect(cf.listPreviews("w")).rejects.toMatchObject({ code: "pagination" });
    expect(calls).toHaveLength(2);
  });

  it("分页参数不被认、每页都满时不会无限翻下去", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `p${i}` }));
    const { api: cf } = api(() => ok(full));
    await expect(cf.listPreviews("w")).rejects.toThrow(CloudflareApiError);
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
