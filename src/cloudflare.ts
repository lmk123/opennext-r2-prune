/**
 * Cloudflare REST API 的最小客户端，只实现找「线上历史版本」和「预览」的地址要用的三个读操作。
 * BUILD_ID 只存在于静态资源里，API 拿不到它 —— 这里只负责找出 URL，读 BUILD_ID 仍交给
 * build-id.ts。和 store.ts 一样不碰任何 Node 专属 API。
 */

import { type OnRetry, withRetry } from "./retry.ts";

const API_BASE = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 100;
/** 预览最多 500 个，100 一页只要 5 页；翻到这么多页说明分页参数没被认，不能无限翻下去 */
const MAX_PAGES = 50;

export interface CloudflareApiOptions {
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  onRetry?: OnRetry;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.code = code;
  }
}

export interface Deployment {
  /** 这次部署承载流量的全部 version；灰度期间是两个 */
  versionIds: string[];
}

export interface Preview {
  name: string;
  urls: string[];
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
  result_info?: { page?: number; per_page?: number; total_pages?: number; total_count?: number };
}

export class CloudflareApi {
  readonly #opts: CloudflareApiOptions;

  constructor(opts: CloudflareApiOptions) {
    this.#opts = opts;
  }

  /** 最新的在前 */
  async listDeployments(worker: string): Promise<Deployment[]> {
    const { result } = await this.#get<{
      deployments?: { versions?: { version_id: string }[] }[];
    }>(`/workers/scripts/${encodeURIComponent(worker)}/deployments`);
    return (result.deployments ?? []).map((d) => ({
      versionIds: (d.versions ?? []).map((v) => v.version_id),
    }));
  }

  /** 这个 version 可以直接访问的地址，即 `<版本前缀>-<worker>.<子域>.workers.dev` */
  async getVersionUrls(worker: string, versionId: string): Promise<string[]> {
    const { result } = await this.#get<{ urls?: string[] }>(
      `/workers/workers/${encodeURIComponent(worker)}/versions/${encodeURIComponent(versionId)}`,
    );
    return result.urls ?? [];
  }

  /**
   * 翻页的终点必须有据可依：漏掉一页预览，它们的 build 就会被挂上删除规则，而且全程 0 退出。
   * 依次认 total_pages、total_count、服务端回报的 per_page；三者都没有时一直翻到空页为止，
   * 同一个预览在后面的页里又出现，说明分页参数没被认（比如接口其实是游标分页），当场中止。
   */
  async listPreviews(worker: string): Promise<Preview[]> {
    const previews: Preview[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        throw paginationError(`列举预览翻了 ${MAX_PAGES} 页还没结束，分页参数可能没被接受`);
      }
      const { result, result_info: info } = await this.#get<{ name: string; urls?: string[] }[]>(
        `/workers/workers/${encodeURIComponent(worker)}/previews`,
        { page: String(page), per_page: String(PAGE_SIZE) },
      );
      for (const p of result) {
        if (seen.has(p.name)) {
          throw paginationError(`第 ${page} 页又出现了预览 ${p.name}，分页参数可能没被接受`);
        }
        seen.add(p.name);
        previews.push({ name: p.name, urls: p.urls ?? [] });
      }

      if (result.length === 0) return previews;
      if (info?.total_pages !== undefined) {
        if (page >= info.total_pages) return previews;
      } else if (info?.total_count !== undefined) {
        if (previews.length >= info.total_count) return previews;
      } else if (info?.per_page !== undefined) {
        if (result.length < info.per_page) return previews;
      }
    }
  }

  async #get<T>(path: string, query?: Record<string, string>): Promise<Envelope<T>> {
    const url = new URL(`${API_BASE}/accounts/${encodeURIComponent(this.#opts.accountId)}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    const doFetch = this.#opts.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await withRetry(
        () => doFetch(url.toString(), { headers: { authorization: `Bearer ${this.#opts.apiToken}` } }),
        this.#opts.onRetry,
      );
    } catch (error) {
      // 重试耗尽的网络层失败也归成「预期内的失败」，否则 cli 会甩出一整段堆栈
      throw new CloudflareApiError(0, "network", `GET ${url.pathname} 请求失败：${String(error)}`);
    }

    let body: Envelope<T>;
    try {
      body = (await response.json()) as Envelope<T>;
    } catch {
      throw new CloudflareApiError(
        response.status,
        String(response.status),
        `GET ${url.pathname} 返回的不是 JSON（HTTP ${response.status}）`,
      );
    }
    if (!response.ok || !body.success) {
      const first = body.errors?.[0];
      throw new CloudflareApiError(
        response.status,
        String(first?.code ?? response.status),
        `GET ${url.pathname} 失败：${first?.message ?? `HTTP ${response.status}`}`,
      );
    }
    return body;
  }
}

function paginationError(reason: string): CloudflareApiError {
  return new CloudflareApiError(0, "pagination", `${reason}，无法确认已经看到全部预览，已中止。`);
}
