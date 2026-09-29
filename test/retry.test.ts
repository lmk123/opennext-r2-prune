import { describe, expect, it } from "vitest";
import { withRetry } from "../src/retry.ts";

describe("withRetry", () => {
  it("重试前取消被丢弃响应的 body，免得连接要等 GC 才归还", async () => {
    let cancelled = 0;
    let call = 0;
    const response = await withRetry(async () => {
      call++;
      if (call === 1) {
        const body = new ReadableStream({ cancel: () => void cancelled++ });
        return new Response(body, { status: 503 });
      }
      return new Response("ok");
    });
    expect(await response.text()).toBe("ok");
    expect(cancelled).toBe(1);
  });

  it("signal 中止时退避立刻结束，不再发起下一次尝试", async () => {
    const controller = new AbortController();
    let call = 0;
    const pending = withRetry(
      async () => {
        call++;
        return new Response("busy", { status: 429, headers: { "retry-after": "60" } });
      },
      undefined,
      controller.signal,
    );
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    expect(call).toBe(1);
  });
});
