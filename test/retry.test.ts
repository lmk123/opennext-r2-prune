import { describe, expect, it, vi } from "vitest";
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

  it("单次尝试迟迟不回响应头时超时并重试，不让一个地址挂住整趟", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const pending = withRetry(
        (signal) => {
          call++;
          if (call === 3) return Promise.resolve(new Response("ok"));
          // 永不响应，直到被本次尝试的 signal 中止
          return new Promise<Response>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
        undefined,
        undefined,
        1_000,
      );
      await vi.runAllTimersAsync();
      expect(await (await pending).text()).toBe("ok");
      expect(call).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("响应头到了但 body 迟迟不来时同样超时并重试", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const pending = withRetry(
        async (signal) => {
          call++;
          if (call === 2) return new Response("ok");
          // 只发响应头，body 一直不来，直到被本次尝试的 signal 中止
          const body = new ReadableStream({
            start: (c) => signal.addEventListener("abort", () => c.error(signal.reason), { once: true }),
          });
          return new Response(body);
        },
        undefined,
        undefined,
        1_000,
      );
      await vi.runAllTimersAsync();
      expect(await (await pending).text()).toBe("ok");
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("每次都超时时抛出超时错误", async () => {
    vi.useFakeTimers();
    try {
      const pending = withRetry(
        (signal) =>
          new Promise<Response>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
        undefined,
        undefined,
        1_000,
      ).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(String(await pending)).toMatch(/not fully received within 1 seconds/);
    } finally {
      vi.useRealTimers();
    }
  });
});
