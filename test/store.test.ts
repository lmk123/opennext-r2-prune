import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { R2Store, S3Error } from "../src/store.ts";

const CREDS = {
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  bucket: "my-cache",
  accessKeyId: "ak",
  secretAccessKey: "sk",
};

/** 记录每个请求，并按调用顺序回放预设响应 */
function stub(responses: (() => Response)[]) {
  const calls: Request[] = [];
  const fetchImpl = (async (request: Request) => {
    calls.push(request);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ok = (body: string, init?: ResponseInit) => () => new Response(body, init);

describe("listBuildIds", () => {
  it("用 Delimiter 一次拿到全部 buildId，不遍历缓存对象", async () => {
    const { calls, fetchImpl } = stub([
      ok(`<ListBucketResult><IsTruncated>false</IsTruncated>
        <CommonPrefixes><Prefix>incremental-cache/b1/</Prefix></CommonPrefixes>
        <CommonPrefixes><Prefix>incremental-cache/b2/</Prefix></CommonPrefixes>
      </ListBucketResult>`),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });

    expect(await store.listBuildIds("incremental-cache")).toEqual(["b1", "b2"]);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("delimiter")).toBe("/");
    expect(url.searchParams.get("prefix")).toBe("incremental-cache/");
  });

  it("build 数量超过一页时继续翻页", async () => {
    const { calls, fetchImpl } = stub([
      ok(`<ListBucketResult><IsTruncated>true</IsTruncated>
        <NextContinuationToken>tok</NextContinuationToken>
        <CommonPrefixes><Prefix>incremental-cache/b1/</Prefix></CommonPrefixes>
      </ListBucketResult>`),
      ok(`<ListBucketResult><IsTruncated>false</IsTruncated>
        <CommonPrefixes><Prefix>incremental-cache/b2/</Prefix></CommonPrefixes>
      </ListBucketResult>`),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });

    expect(await store.listBuildIds("incremental-cache")).toEqual(["b1", "b2"]);
    expect(new URL(calls[1]!.url).searchParams.get("continuation-token")).toBe("tok");
  });

  it("前缀为空时列举 bucket 根下的一级目录", async () => {
    const { calls, fetchImpl } = stub([
      ok(`<ListBucketResult><IsTruncated>false</IsTruncated>
        <CommonPrefixes><Prefix>b1/</Prefix></CommonPrefixes>
      </ListBucketResult>`),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });

    expect(await store.listBuildIds("")).toEqual(["b1"]);
    expect(new URL(calls[0]!.url).searchParams.get("prefix")).toBe("");
  });

  it("前缀写成 /incremental-cache/ 也能正常工作", async () => {
    const { calls, fetchImpl } = stub([
      ok(`<ListBucketResult><IsTruncated>false</IsTruncated>
        <CommonPrefixes><Prefix>incremental-cache/b1/</Prefix></CommonPrefixes>
      </ListBucketResult>`),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });

    expect(await store.listBuildIds("/incremental-cache/")).toEqual(["b1"]);
    expect(new URL(calls[0]!.url).searchParams.get("prefix")).toBe("incremental-cache/");
  });
});

describe("lifecycle", () => {
  it("从未配过规则的 bucket 返回 404，当作空配置", async () => {
    const { fetchImpl } = stub([
      ok("<Error><Code>NoSuchLifecycleConfiguration</Code></Error>", { status: 404 }),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    expect(await store.getLifecycle()).toEqual({ own: [], foreign: [] });
  });

  it("其它错误照常抛出", async () => {
    const { fetchImpl } = stub([
      ok("<Error><Code>AccessDenied</Code><Message>没有权限</Message></Error>", { status: 403 }),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    await expect(store.getLifecycle()).rejects.toThrow(S3Error);
  });

  it("写入时带上 Content-MD5", async () => {
    const { calls, fetchImpl } = stub([ok("", { status: 200 })]);
    const store = new R2Store({
      ...CREDS,
      fetchImpl,
      md5Base64: (body) => createHash("md5").update(body, "utf8").digest("base64"),
    });

    await store.putLifecycle({
      own: [
        {
          buildId: "b1",
          prefix: "incremental-cache/b1/",
          expireDays: 1,
          style: "filter",
          enabled: true,
        },
      ],
      foreign: [],
    });

    const request = calls[0]!;
    expect(request.method).toBe("PUT");
    expect(request.url).toContain("?lifecycle");
    const body = await request.text();
    expect(request.headers.get("content-md5")).toBe(
      createHash("md5").update(body, "utf8").digest("base64"),
    );
    expect(body).toContain("<ID>opennext-r2-prune:b1</ID>");
  });
});

describe("重试", () => {
  it("5xx 会重试并最终成功", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) return new Response("<Error/>", { status: 503 });
      return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
    }) as unknown as typeof fetch;

    const store = new R2Store({ ...CREDS, fetchImpl });
    expect(await store.listBuildIds("incremental-cache")).toEqual([]);
    expect(call).toBe(2);
  });

  it("4xx 直接失败，不浪费重试", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      return new Response("<Error><Code>InvalidAccessKeyId</Code><Message>密钥无效</Message></Error>", {
        status: 403,
      });
    }) as unknown as typeof fetch;

    const store = new R2Store({ ...CREDS, fetchImpl });
    await expect(store.listBuildIds("incremental-cache")).rejects.toThrow("密钥无效");
    expect(call).toBe(1);
  });
});
