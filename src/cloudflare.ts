/**
 * Cloudflare REST API 的最小客户端，只实现找「线上历史版本」和「预览」的地址要用的三个读操作。
 * BUILD_ID 只存在于静态资源里，API 拿不到它 —— 这里只负责找出 URL，读 BUILD_ID 仍交给
 * build-id.ts。和 store.ts 一样不碰任何 Node 专属 API。
 */

const API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_ATTEMPTS = 3;
const PAGE_SIZE = 100;
/** 预览最多 500 个，100 一页只要 5 页；翻到这么多页说明分页参数没被认，不能无限翻下去 */
const MAX_PAGES = 50;

export interface CloudflareApiOptions {
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  onRetry?: (attempt: number, reason: string) => void;
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
  result_info?: { page?: number; per_page?: number; total_pages?: number };
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

  async listPreviews(worker: string): Promise<Preview[]> {
    const previews: Preview[] = [];
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        throw new CloudflareApiError(
          0,
          "pagination",
          `列举预览翻了 ${MAX_PAGES} 页还没结束，分页参数可能没被接受，无法确认已经看到全部预览。`,
        );
      }
      const { result, result_info: info } = await this.#get<{ name: string; urls?: string[] }[]>(
        `/workers/workers/${encodeURIComponent(worker)}/previews`,
        { page: String(page), per_page: String(PAGE_SIZE) },
      );
      for (const p of result) previews.push({ name: p.name, urls: p.urls ?? [] });

      const done =
        info?.total_pages !== undefined ? page >= info.total_pages : result.length < PAGE_SIZE;
      if (done) return previews;
    }
  }

  async #get<T>(path: string, query?: Record<string, string>): Promise<Envelope<T>> {
    const url = new URL(`${API_BASE}/accounts/${encodeURIComponent(this.#opts.accountId)}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    const doFetch = this.#opts.fetchImpl ?? fetch;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await doFetch(url.toString(), {
          headers: { authorization: `Bearer ${this.#opts.apiToken}` },
        });
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS) break;
        this.#opts.onRetry?.(attempt, String(error));
        await backoff(attempt);
        continue;
      }

      if ((response.status >= 500 || response.status === 429) && attempt < MAX_ATTEMPTS) {
        this.#opts.onRetry?.(attempt, `HTTP ${response.status}`);
        await backoff(attempt);
        continue;
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

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 500));
}
