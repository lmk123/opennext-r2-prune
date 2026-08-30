import { describe, expect, it } from "vitest";
import { BuildIdProbeError, buildIdUrlFor, probeBuildId } from "../src/build-id.ts";

function reply(body: string, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body, init)) as unknown as typeof fetch;
}

describe("buildIdUrlFor", () => {
  it("拼在站点根上，忽略传入地址的路径", () => {
    expect(buildIdUrlFor("https://example.com")).toBe("https://example.com/BUILD_ID");
    expect(buildIdUrlFor("https://example.com/blog")).toBe("https://example.com/BUILD_ID");
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
    ).rejects.toThrow(/不像一个 build id/);
  });

  it("网络失败报错", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(probeBuildId("https://example.com/BUILD_ID", failing)).rejects.toThrow(
      BuildIdProbeError,
    );
  });
});
