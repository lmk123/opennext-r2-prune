import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { withRetry } from "../src/retry.ts";

/**
 * 真实 R2 实测用的工具函数。这里刻意不复用 src 里的解析与请求代码：
 * 核对结果的一方和被测的一方用同一套代码，被测代码错了核对也跟着错，测不出来。
 * 只借用 withRetry 扛网络抖动，它不碰请求内容与解析。
 */

/** 实测用到的全部对象都放在这个目录下，开跑前、跑完后整个清掉 */
export const E2E_ROOT = "e2e";

/**
 * 开跑时把原配置存进这个对象，原配置写回之后才删。它还在，说明另一趟实测正在跑，或上次没写回就被打断了。
 * 放在 E2E_ROOT 之外，每个用例前清 e2e/ 时才不会把它一起删掉
 */
export const SNAPSHOT_KEY = "e2e-lifecycle-snapshot.json";

/** 实测写进 bucket 的规则：外部规则一律以 e2e- 开头，本工具的规则都落在 E2E_ROOT 之下 */
export const isE2eRuleId = (id: string) => id.startsWith("e2e-") || id.startsWith(`opennext-r2-prune:${E2E_ROOT}/`);

export interface E2eEnv {
  bucket: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 给了 WORKER_NAME 与 CLOUDFLARE_API_TOKEN 才跑探测线上 build 的那组用例 */
  worker?: { name: string; apiToken: string };
}

/**
 * 读实测用的凭证。实测会整份改写 bucket 的 lifecycle 配置，所以 bucket 名里必须有一段是 test，
 * 防止 .env 或 shell 里留着线上凭证时误跑到线上 bucket 上。按连字符分段比：只看子串的话，
 * latest、contest 这类线上 bucket 名也会被放过。
 */
export function loadEnv(): E2eEnv {
  const env = process.env;
  const bucket = env.R2_BUCKET;
  const missing = [
    ["R2_BUCKET", bucket],
    ["CLOUDFLARE_ACCOUNT_ID", env.CLOUDFLARE_ACCOUNT_ID],
    ["R2_ACCESS_KEY_ID", env.R2_ACCESS_KEY_ID],
    ["R2_SECRET_ACCESS_KEY", env.R2_SECRET_ACCESS_KEY],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `真实 R2 实测缺少环境变量：${missing.join("、")}。` +
        `请照 .env.example 填好 .env（或在 shell 里设好这些变量）再跑 pnpm test:e2e。`,
    );
  }
  if (!/(^|-)test(-|$)/i.test(bucket!)) {
    throw new Error(
      `实测会整份改写 bucket「${bucket}」的 lifecycle 配置，只允许在名字里有一段是 test 的专用测试 bucket` +
        `（以连字符分隔，如 opennext-r2-prune-test）上跑，已中止。` +
        `请检查 .env 与 shell 里的 R2_BUCKET（shell 里的优先），确认它指向专用的测试 bucket。`,
    );
  }
  const worker =
    env.WORKER_NAME && env.CLOUDFLARE_API_TOKEN ? { name: env.WORKER_NAME, apiToken: env.CLOUDFLARE_API_TOKEN } : undefined;
  return {
    bucket: bucket!,
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    worker,
  };
}

export const md5Base64 = (body: string) => createHash("md5").update(body, "utf8").digest("base64");

/** 从 lifecycle XML 里独立解析出的一条规则 */
export interface RawRule {
  id: string;
  enabled: boolean;
  /** <Filter><Prefix> 的值 */
  filterPrefix?: string;
  /** 直接挂在 <Rule> 下的 <Prefix> 的值 */
  barePrefix?: string;
  /** <Expiration><Days> */
  days?: number;
  abortMultipartDays?: number;
}

const inner = (xml: string, tag: string) => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];

export function parseRules(xml: string): RawRule[] {
  return [...xml.matchAll(/<Rule>([\s\S]*?)<\/Rule>/g)].map(([, block]) => {
    const filter = inner(block!, "Filter");
    const filterPrefix = filter === undefined ? undefined : inner(filter, "Prefix");
    const withoutFilter = block!.replace(/<Filter(?:\s[^>]*)?>[\s\S]*?<\/Filter>/, "");
    const days = inner(inner(block!, "Expiration") ?? "", "Days");
    const abort = inner(inner(block!, "AbortIncompleteMultipartUpload") ?? "", "DaysAfterInitiation");
    return {
      id: inner(block!, "ID")?.trim() ?? "",
      enabled: inner(block!, "Status")?.trim() === "Enabled",
      ...(filterPrefix !== undefined ? { filterPrefix } : {}),
      ...(inner(withoutFilter, "Prefix") !== undefined ? { barePrefix: inner(withoutFilter, "Prefix") } : {}),
      ...(days !== undefined ? { days: Number(days) } : {}),
      ...(abort !== undefined ? { abortMultipartDays: Number(abort) } : {}),
    };
  });
}

/** 直接对 R2 发 S3 请求，用来布置现场和独立核对结果 */
export class RawR2 {
  readonly #client: AwsClient;
  readonly #base: string;
  readonly #bucket: string;

  constructor(env: E2eEnv) {
    this.#bucket = env.bucket;
    this.#client = new AwsClient({
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.#base = `https://${env.accountId}.r2.cloudflarestorage.com/${env.bucket}`;
  }

  async #send(url: string, init: RequestInit = {}, ok: (status: number) => boolean = (s) => s < 300) {
    // 请求都是幂等的 GET / PUT / DELETE，可以放心重试；还原 lifecycle 也靠它扛住一次网络抖动
    const response = await withRetry(async (signal) => fetch(await this.#client.sign(url, init), { signal }));
    const body = await response.text();
    if (!ok(response.status)) {
      throw new Error(`${init.method ?? "GET"} ${url} 失败：HTTP ${response.status} ${body.slice(0, 500)}`);
    }
    return { status: response.status, body };
  }

  /**
   * GET 一个可能不存在的资源：只有 404 且错误码是 missingCode 时返回 null。别的 404 多半是 bucket 不存在
   * （NoSuchBucket），当成「没有」会让后面的写入报出看不出原因的 404，这里直接报明
   */
  async #getOptional(url: string, missingCode: string): Promise<{ status: number; body: string | null }> {
    const { status, body } = await this.#send(url, {}, (s) => s < 300 || s === 404);
    if (status !== 404) return { status, body };
    if (inner(body, "Code") === missingCode) return { status, body: null };
    throw new Error(
      `GET ${url} 失败：HTTP 404 ${body.slice(0, 500)}。多半是 bucket「${this.#bucket}」不存在，` +
        `请核对 .env 与 shell 里的 R2_BUCKET、CLOUDFLARE_ACCOUNT_ID。`,
    );
  }

  #key(key: string) {
    return `${this.#base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  putObject(key: string, body = "{}") {
    return this.#send(this.#key(key), { method: "PUT", body, headers: { "Content-Type": "application/json" } });
  }

  /** 读对象内容；对象不存在时返回 null */
  async getObject(key: string): Promise<string | null> {
    return (await this.#getOptional(this.#key(key), "NoSuchKey")).body;
  }

  async deleteObject(key: string): Promise<void> {
    await this.#send(this.#key(key), { method: "DELETE" });
  }

  /** 列出 prefix 下的全部对象 key（不折叠目录） */
  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const url = new URL(this.#base);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      if (token) url.searchParams.set("continuation-token", token);
      const { body } = await this.#send(url.toString());
      for (const [, key] of body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(key!);
      token = inner(body, "IsTruncated") === "true" ? inner(body, "NextContinuationToken") : undefined;
    } while (token);
    return keys;
  }

  /** 删掉 prefix 下的全部对象 */
  async deleteUnder(prefix: string): Promise<void> {
    for (const key of await this.listKeys(prefix)) await this.deleteObject(key);
  }

  /** 每个 build 目录放一个对象，build 目录才会出现在列举结果里 */
  async seedBuilds(prefix: string, buildIds: string[]): Promise<void> {
    await Promise.all(buildIds.map((id) => this.putObject(`${prefix}/${id}/cache.json`)));
  }

  /** 读 lifecycle 原文；没有任何配置（404 NoSuchLifecycleConfiguration）时 xml 为 null */
  async getLifecycle(): Promise<{ status: number; xml: string | null }> {
    const { status, body } = await this.#getOptional(`${this.#base}?lifecycle`, "NoSuchLifecycleConfiguration");
    return { status, xml: body };
  }

  async rules(): Promise<RawRule[]> {
    const { xml } = await this.getLifecycle();
    return xml === null ? [] : parseRules(xml);
  }

  /** 原样写入一份 lifecycle 配置。contentMd5 给了就带上这个头（可以故意给错的） */
  putLifecycle(xml: string, contentMd5: string | null = md5Base64(xml)) {
    const headers: Record<string, string> = { "Content-Type": "application/xml" };
    if (contentMd5 !== null) headers["Content-MD5"] = contentMd5;
    return this.#send(`${this.#base}?lifecycle`, { method: "PUT", body: xml, headers });
  }

  /** 写入配置并等到读回来的规则 ID 与之一致（刚写完可能短暂读到旧配置；R2 读回时按 ID 排序，不比顺序） */
  async setLifecycle(xml: string): Promise<void> {
    await this.putLifecycle(xml);
    const want = parseRules(xml).map((r) => r.id).sort();
    await eventually(async () => {
      const got = (await this.rules()).map((r) => r.id).sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(`写入 lifecycle 后读回的规则 ${JSON.stringify(got)} 与写入的 ${JSON.stringify(want)} 不一致`);
      }
    });
  }
}

/** lifecycle 读写不是即时一致的：断言失败时隔一会儿重试，最后一次仍失败就抛出 */
export async function eventually<T>(fn: () => Promise<T>, tries = 6, delayMs = 2000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function lifecycleXml(rules: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration>${rules.join("")}</LifecycleConfiguration>`;
}

/** 每个用例开始前的外部规则：一条不带 Filter 的、一条带 Filter 的，模拟用户自己配的规则 */
export const BASELINE_RULES = [
  "<Rule><ID>e2e-abort-multipart</ID><Status>Enabled</Status>" +
    "<AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>",
  `<Rule><ID>e2e-user-rule</ID><Status>Enabled</Status><Filter><Prefix>${E2E_ROOT}/user-uploads/</Prefix></Filter>` +
    "<Expiration><Days>30</Days></Expiration></Rule>",
];

export const BASELINE_EXPECTED: RawRule[] = [
  { id: "e2e-abort-multipart", enabled: true, abortMultipartDays: 7 },
  { id: "e2e-user-rule", enabled: true, filterPrefix: `${E2E_ROOT}/user-uploads/`, days: 30 },
];

/** 记下发出的每个请求，用来断言有没有写请求、清空配置走的是哪条路 */
export function spyFetch() {
  const calls: { method: string; url: string }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push({ method: request.method, url: request.url });
    return fetch(input, init);
  }) as typeof fetch;
  const writes = () => calls.filter((c) => c.method !== "GET" && c.method !== "HEAD");
  return { calls, writes, impl };
}
