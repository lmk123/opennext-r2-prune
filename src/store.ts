import { AwsClient } from "aws4fetch";
import { normalizePrefix } from "./prefix.ts";
import { type OnRetry, withRetry } from "./retry.ts";
import {
  type LifecycleDoc,
  parseErrorMessage,
  parseLifecycle,
  parseListObjects,
  renderLifecycle,
  XmlAssumptionError,
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
  onRetry?: OnRetry;
}

/** 本工具发给 R2 的三种请求。报错时据此说明是哪一步失败、缺的是什么权限。 */
export type S3Operation = "list" | "getLifecycle" | "putLifecycle";

const OPERATION_LABEL: Record<S3Operation, string> = {
  list: "列出 build 目录",
  getLifecycle: "读取 lifecycle 规则",
  putLifecycle: "写入 lifecycle 规则",
};

// R2 的 token 权限分 Object 级（可限定 bucket）与 Admin 级（整个账号）。lifecycle 是 bucket 级配置，
// 实测 Object 级 token 不论只读还是读写，GET / PUT ?lifecycle 都返回 403 AccessDenied，只有 Admin 级能用。
const PERMISSION_HINT: Record<S3Operation, string> = {
  list: "R2 token 需要能读取该 bucket 的对象，并确认 token 授权的 bucket 包含它。",
  getLifecycle:
    "lifecycle 是 bucket 级配置，R2 的 Object 级 token（无论只读还是读写）都读不到。" +
    "只跑 --dry-run 需要 Admin Read only，写入规则需要 Admin Read & Write。",
  putLifecycle: "写入 lifecycle 规则需要 Admin Read & Write 权限的 R2 token，Object 级 token 与 Admin Read only 都写不了。",
};

export class S3Error extends Error {
  // 显式声明字段而不用构造函数参数属性：那是 Node 的类型擦除模式跑不了的语法，
  // 而 package.json 的 start 脚本正是靠它直接跑源码
  readonly status: number;
  readonly code: string;
  readonly operation: S3Operation;
  /** R2 返回的原始错误信息，不含本工具补充的步骤与权限说明 */
  readonly detail: string;

  constructor(operation: S3Operation, status: number, code: string, detail: string) {
    const reason = detail && detail !== code ? `${code}：${detail}` : code;
    const hint = status === 403 ? `\n${PERMISSION_HINT[operation]}` : "";
    super(`${OPERATION_LABEL[operation]}失败（HTTP ${status}，${reason}）${hint}`);
    this.name = "S3Error";
    this.operation = operation;
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

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

  async #request(operation: S3Operation, url: string, init?: RequestInit): Promise<Response> {
    const doFetch = this.#opts.fetchImpl ?? fetch;
    const response = await withRetry(
      async (signal) => doFetch(await this.#client.sign(url, init), { signal }),
      this.#opts.onRetry,
    );
    if (response.status < 400) return response;

    const body = await response.text();
    throw new S3Error(
      operation,
      response.status,
      extractCode(body) ?? String(response.status),
      parseErrorMessage(body),
    );
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

      const result = parseListObjects(await (await this.#request("list", url.toString())).text());
      for (const commonPrefix of result.commonPrefixes) {
        const buildId = commonPrefix.slice(normalized.length).replace(/\/$/, "");
        if (buildId) found.push(buildId);
      }
      // 还有下一页却没给游标：拿着残缺的列表往下走，没列到的 build 会被当成「目录已空」
      // 把规则回收掉，那些目录就再没人清理了 —— 而且全程 0 退出，看不出漏了东西。
      if (result.isTruncated && !result.nextContinuationToken) {
        throw new XmlAssumptionError(
          "列举结果说还有下一页（IsTruncated=true）却没有 NextContinuationToken，" +
            "无法确认已经看到全部 build，已中止。",
        );
      }
      token = result.isTruncated ? result.nextContinuationToken : undefined;
    } while (token);

    return found;
  }

  async getLifecycle(): Promise<LifecycleDoc> {
    try {
      const response = await this.#request("getLifecycle", `${this.#base}?lifecycle`);
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

    await this.#request("putLifecycle", `${this.#base}?lifecycle`, { method: "PUT", body, headers });
  }
}

function extractCode(xml: string): string | undefined {
  return /<Code>([\s\S]*?)<\/Code>/.exec(xml)?.[1];
}
