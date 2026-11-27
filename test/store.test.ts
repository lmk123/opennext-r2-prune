import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { R2Store, S3Error } from "../src/store.ts";
import { XmlAssumptionError } from "../src/xml.ts";

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

describe("buildWrittenAt", () => {
  it("只取 build 目录里的一个对象，读它的写入时间", async () => {
    const { calls, fetchImpl } = stub([
      ok(
        `<ListBucketResult><IsTruncated>true</IsTruncated>
        <Contents><Key>incremental-cache/b1/a.cache</Key><LastModified>2026-11-25T11:31:02.000Z</LastModified></Contents>
      </ListBucketResult>`,
        { headers: { date: "Wed, 25 Nov 2026 12:00:00 GMT" } },
      ),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });

    expect(await store.buildWrittenAt("incremental-cache", "b1")).toEqual({
      writtenAt: new Date("2026-11-25T11:31:02.000Z"),
      serverTime: new Date("2026-11-25T12:00:00.000Z"),
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("prefix")).toBe("incremental-cache/b1/");
    expect(url.searchParams.get("max-keys")).toBe("1");
  });

  it("响应没带 Date 头时 serverTime 为 null，交给调用方用本机时间", async () => {
    const { fetchImpl } = stub([
      ok(`<ListBucketResult><Contents><Key>incremental-cache/b1/a</Key><LastModified>2026-11-25T11:31:02.000Z</LastModified></Contents></ListBucketResult>`),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    expect((await store.buildWrittenAt("incremental-cache", "b1"))?.serverTime).toBeNull();
  });

  it("目录已空时返回 null", async () => {
    const { fetchImpl } = stub([ok(`<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`)]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    expect(await store.buildWrittenAt("incremental-cache", "b1")).toBeNull();
  });

  it("解析不出时间时中止，不当成老 build", async () => {
    const { fetchImpl } = stub([
      ok(`<ListBucketResult><Contents><Key>incremental-cache/b1/a</Key><LastModified>yesterday</LastModified></Contents></ListBucketResult>`),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    await expect(store.buildWrittenAt("incremental-cache", "b1")).rejects.toThrow(XmlAssumptionError);
  });

  it("读取被拒时说明是哪一步", async () => {
    const { fetchImpl } = stub([ok("<Error><Code>AccessDenied</Code></Error>", { status: 403 })]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    await expect(store.buildWrittenAt("incremental-cache", "b1")).rejects.toThrow(/Reading the write time of a build directory failed/);
  });
});

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

  it("说还有下一页却没给游标时中止，不返回残缺的列表", async () => {
    // 残缺的列表会让没列到的 build 被当成「目录已空」，规则被误回收，目录再没人清理
    const { fetchImpl } = stub([
      ok(`<ListBucketResult><IsTruncated>true</IsTruncated>
        <CommonPrefixes><Prefix>incremental-cache/b1/</Prefix></CommonPrefixes>
      </ListBucketResult>`),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });

    await expect(store.listBuildIds("incremental-cache")).rejects.toThrow(XmlAssumptionError);
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
    expect(await store.getLifecycle("incremental-cache")).toEqual({ prefix: "incremental-cache/", own: [], foreign: [], others: [], malformed: [] });
  });

  it("其它错误照常抛出", async () => {
    const { fetchImpl } = stub([
      ok("<Error><Code>AccessDenied</Code><Message>no permission</Message></Error>", { status: 403 }),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    await expect(store.getLifecycle("incremental-cache")).rejects.toThrow(S3Error);
  });

  it("读 lifecycle 被拒时说明是哪一步、缺什么权限", async () => {
    const { fetchImpl } = stub([
      ok("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>", { status: 403 }),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    const error = await store.getLifecycle("incremental-cache").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3Error);
    expect(error).toMatchObject({ operation: "getLifecycle", status: 403, code: "AccessDenied" });
    expect((error as S3Error).message).toContain("Reading lifecycle rules failed (HTTP 403, AccessDenied: Access Denied)");
    expect((error as S3Error).message).toContain("Admin Read only");
  });

  it("写 lifecycle 被拒时提示需要 Admin Read & Write", async () => {
    const { fetchImpl } = stub([ok("<Error><Code>AccessDenied</Code></Error>", { status: 403 })]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    const error = (await store.putLifecycle({ prefix: "incremental-cache/", own: [], foreign: [] }).catch((e: unknown) => e)) as S3Error;
    expect(error.message).toContain("Writing lifecycle rules failed (HTTP 403, AccessDenied)");
    expect(error.message).toContain("Admin Read & Write");
  });

  it("非 403 的错误不附加权限提示", async () => {
    const { fetchImpl } = stub([
      ok("<Error><Code>NoSuchBucket</Code><Message>bucket does not exist</Message></Error>", { status: 404 }),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    const error = (await store.listBuildIds("incremental-cache").catch((e: unknown) => e)) as S3Error;
    expect(error.message).toBe("Listing build directories failed (HTTP 404, NoSuchBucket: bucket does not exist)");
  });

  it("清空配置时 PUT 空配置被当格式错误拒掉，就退回 DELETE", async () => {
    const { calls, fetchImpl } = stub([
      ok("<Error><Code>MalformedXML</Code></Error>", { status: 400 }),
      () => new Response(null, { status: 204 }),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    await store.putLifecycle({ prefix: "incremental-cache/", own: [], foreign: [] });
    expect(calls.map((c) => c.method)).toEqual(["PUT", "DELETE"]);
    expect(new URL(calls[1]!.url).searchParams.has("lifecycle")).toBe(true);
  });

  it("退回的 DELETE 也失败时，报错里同时说明 PUT 被拒的原因", async () => {
    const { fetchImpl } = stub([
      ok("<Error><Code>MalformedXML</Code></Error>", { status: 400 }),
      ok("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
    ]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    const error = (await store.putLifecycle({ prefix: "incremental-cache/", own: [], foreign: [] }).catch((e: unknown) => e)) as S3Error;
    expect(error).toMatchObject({ operation: "deleteLifecycle", status: 403, code: "AccessDenied" });
    expect(error.message).toContain("Clearing lifecycle rules failed (HTTP 403, AccessDenied)");
    expect(error.message).toContain("The earlier PUT of an empty configuration was rejected (HTTP 400, MalformedXML)");
    expect(error.message).toContain("Admin Read & Write");
  });

  it("配置不为空时 PUT 被拒就直接报错，不会退回 DELETE", async () => {
    const { calls, fetchImpl } = stub([ok("<Error><Code>MalformedXML</Code></Error>", { status: 400 })]);
    const store = new R2Store({ ...CREDS, fetchImpl });
    await expect(store.putLifecycle({ prefix: "incremental-cache/", own: [], foreign: ["<ID>mine</ID>"] })).rejects.toThrow(S3Error);
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
  });

  it("写入时带上 Content-MD5", async () => {
    const { calls, fetchImpl } = stub([ok("", { status: 200 })]);
    const store = new R2Store({
      ...CREDS,
      fetchImpl,
      md5Base64: (body) => createHash("md5").update(body, "utf8").digest("base64"),
    });

    await store.putLifecycle({
      prefix: "incremental-cache/",
      own: [
        {
          buildId: "b1",
          prefix: "incremental-cache/b1/",
          expireDays: 1,
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
    expect(body).toContain("<ID>opennext-r2-prune:incremental-cache/b1/</ID>");
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
      return new Response("<Error><Code>InvalidAccessKeyId</Code><Message>invalid key</Message></Error>", {
        status: 403,
      });
    }) as unknown as typeof fetch;

    const store = new R2Store({ ...CREDS, fetchImpl });
    await expect(store.listBuildIds("incremental-cache")).rejects.toThrow("invalid key");
    expect(call).toBe(1);
  });

  it("网络层失败重试耗尽后报成 S3Error（status 0），不甩原生 TypeError", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND acct123.example") });
    }) as unknown as typeof fetch;

    const store = new R2Store({ ...CREDS, fetchImpl });
    const error = await store.listBuildIds("incremental-cache").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3Error);
    expect(error).toMatchObject({ status: 0, code: "network", operation: "list" });
    // undici 的真正原因在 cause 里，报错要带上，原始错误也要挂在 cause 上
    expect((error as S3Error).message).toMatch(/Listing build directories failed \(no response[\s\S]*ENOTFOUND[\s\S]*endpoint are reachable/);
    expect((error as S3Error).cause).toBeInstanceOf(TypeError);
    expect(call).toBe(3);
  });

  it("退回的 DELETE 网络失败时，报错里既有 PUT 被拒的原因，也有网络失败的补救办法", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      if (call++ === 0) return new Response("<Error><Code>MalformedXML</Code></Error>", { status: 400 });
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const store = new R2Store({ ...CREDS, fetchImpl });
    const error = (await store.putLifecycle({ prefix: "incremental-cache/", own: [], foreign: [] }).catch((e: unknown) => e)) as S3Error;
    expect(error).toMatchObject({ operation: "deleteLifecycle", status: 0, code: "network" });
    expect(error.message).toContain("The earlier PUT of an empty configuration was rejected (HTTP 400, MalformedXML)");
    expect(error.message).toContain("Check that the network and endpoint are reachable");
    expect(error.cause).toBeInstanceOf(TypeError);
  });
});
