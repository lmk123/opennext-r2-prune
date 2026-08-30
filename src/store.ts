import { AwsClient } from "aws4fetch";
import { normalizePrefix } from "./prefix.ts";
import {
  type LifecycleDoc,
  parseErrorMessage,
  parseLifecycle,
  parseListObjects,
  renderLifecycle,
} from "./xml.ts";

/**
 * R2 的 S3 兼容接口，只实现本工具用到的三个操作。
 * 刻意不碰任何 Node 专属 API，这样将来整块搬进 Cloudflare Worker 也不用改。
 */

export interface StoreOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * 计算请求体的 base64 MD5。S3 规范要求 PutBucketLifecycleConfiguration 带
   * Content-MD5，而 Web Crypto 不提供 MD5，所以由调用方注入实现。
   */
  md5Base64?: (body: string) => string;
  fetchImpl?: typeof fetch;
  onRetry?: (attempt: number, reason: string) => void;
}

export class S3Error extends Error {
  // 显式声明字段而不用构造函数参数属性：那是 Node 的类型擦除模式跑不了的语法，
  // 而 package.json 的 start 脚本正是靠它直接跑源码
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "S3Error";
    this.status = status;
    this.code = code;
  }
}

const MAX_ATTEMPTS = 3;

export class R2Store {
  readonly #client: AwsClient;
  readonly #base: string;
  readonly #opts: StoreOptions;

  constructor(opts: StoreOptions) {
    this.#opts = opts;
    this.#client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.#base = `${opts.endpoint.replace(/\/+$/, "")}/${opts.bucket}`;
  }

  async #request(url: string, init?: RequestInit): Promise<Response> {
    const doFetch = this.#opts.fetchImpl ?? fetch;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        const signed = await this.#client.sign(url, init);
        response = await doFetch(signed);
      } catch (error) {
        // 网络层失败同样值得重试
        lastError = error;
        if (attempt === MAX_ATTEMPTS) break;
        this.#opts.onRetry?.(attempt, String(error));
        await backoff(attempt);
        continue;
      }

      if (response.status < 400) return response;
      if ((response.status >= 500 || response.status === 429) && attempt < MAX_ATTEMPTS) {
        this.#opts.onRetry?.(attempt, `HTTP ${response.status}`);
        await backoff(attempt);
        continue;
      }

      const body = await response.text();
      throw new S3Error(
        response.status,
        extractCode(body) ?? String(response.status),
        parseErrorMessage(body),
      );
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * 列出 `<prefix>/` 下的一级“目录”，也就是全部 buildId。
   * Delimiter 让 R2 在服务端折叠，通常一个请求就够 —— 不需要遍历任何缓存对象。
   */
  async listBuildIds(prefix: string): Promise<string[]> {
    const normalized = normalizePrefix(prefix);
    const found: string[] = [];
    let token: string | undefined;

    do {
      const url = new URL(this.#base);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", normalized);
      url.searchParams.set("delimiter", "/");
      if (token) url.searchParams.set("continuation-token", token);

      const result = parseListObjects(await (await this.#request(url.toString())).text());
      for (const commonPrefix of result.commonPrefixes) {
        const buildId = commonPrefix.slice(normalized.length).replace(/\/$/, "");
        if (buildId) found.push(buildId);
      }
      token = result.isTruncated ? result.nextContinuationToken : undefined;
    } while (token);

    return found;
  }

  async getLifecycle(): Promise<LifecycleDoc> {
    try {
      const response = await this.#request(`${this.#base}?lifecycle`);
      return parseLifecycle(await response.text());
    } catch (error) {
      // 从未配过规则的 bucket 会返回 404 NoSuchLifecycleConfiguration，那是空配置不是错误
      if (error instanceof S3Error && (error.status === 404 || error.code === "NoSuchLifecycleConfiguration")) {
        return { own: [], foreign: [] };
      }
      throw error;
    }
  }

  async putLifecycle(doc: LifecycleDoc): Promise<void> {
    const body = renderLifecycle(doc);
    const headers: Record<string, string> = { "Content-Type": "application/xml" };
    const md5 = this.#opts.md5Base64?.(body);
    if (md5) headers["Content-MD5"] = md5;

    await this.#request(`${this.#base}?lifecycle`, { method: "PUT", body, headers });
  }
}

function extractCode(xml: string): string | undefined {
  return /<Code>([\s\S]*?)<\/Code>/.exec(xml)?.[1];
}

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 500));
}
