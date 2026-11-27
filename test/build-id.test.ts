import { describe, expect, it, vi } from "vitest";
import { BuildIdProbeError, buildIdUrlFor, probeBuildId } from "../src/build-id.ts";

function reply(body: string, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body, init)) as unknown as typeof fetch;
}

describe("buildIdUrlFor", () => {
  it("拼在站点根上，忽略传入地址的路径", () => {
    expect(buildIdUrlFor("https://example.com")).toBe("https://example.com/BUILD_ID");
    expect(buildIdUrlFor("https://example.com/blog")).toBe("https://example.com/BUILD_ID");
  });

  it("地址不合法时报错，而不是甩出 URL 构造器的原生 TypeError", () => {
    // SITE_URL=example.com（漏了协议）是最常见的写法
    expect(() => buildIdUrlFor("example.com")).toThrow(BuildIdProbeError);
  });
});

describe("probeBuildId", () => {
  it("读取纯文本的 build id", async () => {
    const id = await probeBuildId(
      "https://example.com/BUILD_ID",
      reply("AbC-123_xy\n", { headers: { "content-type": "text/plain" } }),
    );
    expect(id).toBe("AbC-123_xy");
  });

  it("返回 HTML 说明被页面路由接管了，报错", async () => {
    await expect(
      probeBuildId(
        "https://example.com/BUILD_ID",
        reply("<!doctype html><html>404</html>", { headers: { "content-type": "text/html" } }),
      ),
    ).rejects.toThrow(/HTML/);
  });

  it("非 2xx 报错", async () => {
    await expect(
      probeBuildId("https://example.com/BUILD_ID", reply("nope", { status: 404 })),
    ).rejects.toThrow(BuildIdProbeError);
  });

  it("响应不像 build id 就报错，而不是拿去当保留项", async () => {
    await expect(
      probeBuildId("https://example.com/BUILD_ID", reply("hello world!")),
    ).rejects.toThrow(/doesn't look like a build id/);
  });

  it("带上防缓存头，避免中间缓存返回上一个版本的 id", async () => {
    // 拿到陈旧的 id，就等于把线上正在服务的 build 判成作废
    let init: RequestInit | undefined;
    const capture = (async (_url: string, options: RequestInit) => {
      init = options;
      return new Response("live", { headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;

    await probeBuildId("https://example.com/BUILD_ID", capture);
    expect(new Headers(init!.headers).get("cache-control")).toContain("no-cache");
  });

  it("网络失败重试耗尽后报错", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const failing = (async () => {
        call++;
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      const result = expect(probeBuildId("https://example.com/BUILD_ID", failing)).rejects.toThrow(
        BuildIdProbeError,
      );
      await vi.runAllTimersAsync();
      await result;
      expect(call).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("偶发的 5xx 会重试，不让一次抖动中止整趟", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const flaky = (async () => {
        call++;
        if (call === 1) return new Response("busy", { status: 503 });
        return new Response("live", { headers: { "content-type": "text/plain" } });
      }) as unknown as typeof fetch;
      const result = probeBuildId("https://example.com/BUILD_ID", flaky);
      await vi.runAllTimersAsync();
      expect(await result).toBe("live");
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("重试耗尽仍是 429 时报成暂时性失败，而不是「没有暴露 BUILD_ID」", async () => {
    vi.useFakeTimers();
    try {
      const limited = (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch;
      const result = probeBuildId("https://example.com/BUILD_ID", limited).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = (await result) as BuildIdProbeError;
      expect(error).toBeInstanceOf(BuildIdProbeError);
      expect(error.transient).toBe(true);
      expect(error.message).toMatch(/rate limited[\s\S]*run again later/);
      expect(error.message).not.toMatch(/not be exposed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("404 不重试", async () => {
    let call = 0;
    const missing = (async () => {
      call++;
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(probeBuildId("https://example.com/BUILD_ID", missing)).rejects.toThrow(
      BuildIdProbeError,
    );
    expect(call).toBe(1);
  });
});
