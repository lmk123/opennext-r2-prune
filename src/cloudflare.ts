/**
 * Cloudflare REST API 的最小客户端，只实现找「线上历史版本」和「预览」的地址要用的三个读操作。
 * BUILD_ID 只存在于静态资源里，API 拿不到它 —— 这里只负责找出 URL，读 BUILD_ID 仍交给
 * build-id.ts。和 store.ts 一样不碰任何 Node 专属 API。
 */

import { isTransientStatus, MAX_ATTEMPTS, type OnRetry, withRetry } from "./retry.ts";

const API_BASE = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 100;
/** 预览最多 500 个，100 一页只要 5 页；翻到这么多页说明分页参数没被认，不能无限翻下去（deployment 同用） */
const MAX_PAGES = 50;
/** 多页列举结果不一致时最多列几遍 */
const MAX_LIST_ATTEMPTS = 3;

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
  id?: string;
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
  /** 字段可能缺失，也可能是 null：只有真是数字时才能拿来判断翻页终点 */
  result_info?: null | {
    page?: number | null;
    per_page?: number | null;
    total_pages?: number | null;
    total_count?: number | null;
  };
}

export class CloudflareApi {
  readonly #opts: CloudflareApiOptions;

  constructor(opts: CloudflareApiOptions) {
    this.#opts = opts;
  }

  /**
   * 最新的在前，一次交出一页，调用方要更多时才翻下一页 —— 凑够近期 build 通常一页就够。
   * 漏掉后面的页，近期 build 就会凑不够、回滚目标被判作废，所以终点和预览一样要有据可依。
   * 翻页期间有新部署时后面的页会重复出现翻过的 deployment，按 id 跳过；一整页都是翻过的，
   * 说明分页参数没被认，再翻也只会原地打转，中止。
   */
  async *listDeployments(worker: string, signal?: AbortSignal): AsyncGenerator<Deployment[]> {
    const seen = new Set<string>();
    let fetched = 0;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        throw paginationError(
          `Listing deployments went through ${MAX_PAGES} pages without reaching the end; the pagination parameters may not be honored`,
          "deployments",
        );
      }
      const { result, result_info: info } = await this.#get<{
        deployments?: { id?: string; versions?: { version_id: string }[] }[];
      } | null>(
        `/workers/scripts/${encodeURIComponent(worker)}/deployments`,
        // 默认页很小，只改 secret / vars 的部署一多就要多翻好几页；要最大的一页
        { page: String(page), per_page: String(PAGE_SIZE) },
        signal,
      );
      const items = result?.deployments ?? [];
      fetched += items.length;
      const fresh = items.filter((d) => d.id === undefined || !seen.has(d.id));
      if (items.length > 0 && fresh.length === 0) {
        throw paginationError(`every deployment on page ${page} was already seen; the pagination parameters may not be honored`, "deployments");
      }
      for (const d of fresh) if (d.id !== undefined) seen.add(d.id);
      if (fresh.length > 0) {
        yield fresh.map((d) => ({ id: d.id, versionIds: (d.versions ?? []).map((v) => v.version_id) }));
      }
      if (isLastPage(info, page, fetched, items.length)) return;
    }
  }

  /** 这个 version 可以直接访问的地址，即 `<版本前缀>-<worker>.<子域>.workers.dev` */
  async getVersionUrls(worker: string, versionId: string, signal?: AbortSignal): Promise<string[]> {
    const { result } = await this.#get<{ urls?: string[] } | null>(
      `/workers/workers/${encodeURIComponent(worker)}/versions/${encodeURIComponent(versionId)}`,
      undefined,
      signal,
    );
    return result?.urls ?? [];
  }

  /**
   * 按页码翻页时，两页之间有预览被删，后面的预览整体前移，会有一个恰好落进已经翻过的页里
   * 被漏掉；有预览新建或更新（排序靠前）时则整体后移，同一个预览在两页里各出现一次。
   * 所以要发多个请求才列完时，再完整列一遍，两次得到的预览集合一致才算数；出现重复的那一遍
   * 本身就不完整，不参与比对。分页参数压根没被认时每一遍都会重复，列满次数后中止。
   */
  async listPreviews(worker: string, signal?: AbortSignal): Promise<Preview[]> {
    let previous: Preview[] | undefined;
    let duplicate: string | undefined;
    for (let attempt = 1; attempt <= MAX_LIST_ATTEMPTS; attempt++) {
      const pass = await this.#listPreviewsOnce(worker, signal);
      if (pass.duplicate !== undefined) {
        duplicate = pass.duplicate;
        continue;
      }
      // 一个请求就列完的结果是同一时刻的快照，不存在翻页间漏项
      if (pass.requests === 1) return pass.previews;
      if (previous && sameNameSet(previous, pass.previews)) return pass.previews;
      previous = pass.previews;
    }
    throw paginationError(
      duplicate !== undefined && previous === undefined
        ? `In ${MAX_LIST_ATTEMPTS} consecutive listings of previews, preview ${duplicate} appeared on more than one page; the pagination parameters may not be honored`
        : `${MAX_LIST_ATTEMPTS} consecutive listings of previews all disagreed; previews may be being added or removed frequently`,
      "previews",
    );
  }

  /**
   * 翻页的终点必须有据可依：漏掉一页预览，它们的 build 就会被挂上删除规则，而且全程 0 退出。
   * 终点的判断见 isLastPage。
   * 同一个预览在后面的页里又出现时这一遍作废，交回 duplicate 由 listPreviews 决定重列还是中止。
   * 唯一的例外是接口压根不分页：两页都不带 result_info、内容一模一样、且第一页没装满。
   */
  async #listPreviewsOnce(
    worker: string,
    signal?: AbortSignal,
  ): Promise<{ previews: Preview[]; requests: number; duplicate?: string }> {
    const previews: Preview[] = [];
    const seen = new Set<string>();
    let firstPage: { names: string[]; paginated: boolean } | undefined;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) {
        throw paginationError(`Listing previews went through ${MAX_PAGES} pages without reaching the end; the pagination parameters may not be honored`, "previews");
      }
      const { result, result_info: info } = await this.#get<{ name: string; urls?: string[] }[] | null>(
        `/workers/workers/${encodeURIComponent(worker)}/previews`,
        { page: String(page), per_page: String(PAGE_SIZE) },
        signal,
      );
      const items = result ?? [];

      if (page === 1) {
        firstPage = { names: items.map((p) => p.name), paginated: info != null };
      } else if (
        page === 2 &&
        !firstPage!.paginated &&
        info == null &&
        firstPage!.names.length < PAGE_SIZE &&
        sameNames(firstPage!.names, items.map((p) => p.name))
      ) {
        // 第一页就是全部，整趟等同于只发了一个请求，不存在翻页间漏项的问题
        return { previews, requests: 1 };
      }

      for (const p of items) {
        if (seen.has(p.name)) return { previews, requests: page, duplicate: p.name };
        seen.add(p.name);
        previews.push({ name: p.name, urls: p.urls ?? [] });
      }

      if (isLastPage(info, page, previews.length, items.length)) return { previews, requests: page };
    }
  }

  async #get<T>(path: string, query?: Record<string, string>, signal?: AbortSignal): Promise<Envelope<T>> {
    const url = new URL(`${API_BASE}/accounts/${encodeURIComponent(this.#opts.accountId)}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    const doFetch = this.#opts.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await withRetry(
        (attemptSignal) =>
          doFetch(url.toString(), {
            headers: { authorization: `Bearer ${this.#opts.apiToken}` },
            signal: attemptSignal,
          }),
        this.#opts.onRetry,
        signal,
      );
    } catch (error) {
      // 重试耗尽的网络层失败也归成「预期内的失败」，否则 cli 会甩出一整段堆栈
      throw new CloudflareApiError(0, "network", `GET ${url.pathname} failed: ${String(error)}`);
    }
    // 重试耗尽仍是 429 / 5xx 时，别让人以为是 token 或参数填错了
    const transient = isTransientStatus(response.status)
      ? ` (${response.status === 429 ? "rate limited" : "server error"} ${MAX_ATTEMPTS} times in a row; just run again later)`
      : "";

    let body: Envelope<T>;
    try {
      body = (await response.json()) as Envelope<T>;
    } catch {
      throw new CloudflareApiError(
        response.status,
        String(response.status),
        `GET ${url.pathname} didn't return JSON (HTTP ${response.status})${transient}`,
      );
    }
    if (!response.ok || !body.success) {
      const first = body.errors?.[0];
      throw new CloudflareApiError(
        response.status,
        String(first?.code ?? response.status),
        `GET ${url.pathname} failed: ${first?.message ?? `HTTP ${response.status}`}${transient}`,
      );
    }
    return body;
  }
}

function paginationError(reason: string, what: "previews" | "deployments"): CloudflareApiError {
  return new CloudflareApiError(0, "pagination", `${reason}. Can't confirm all ${what} were seen; aborted.`);
}

/**
 * 依次认 total_pages、total_count（与已取到的条数比）、服务端回报的 per_page；三者都没有时
 * 一直翻到空页为止。只认真正的数字：null 若混进比较，`page >= null` 恒为 true，第一页就会
 * 被当成最后一页。
 */
function isLastPage(
  info: Envelope<unknown>["result_info"],
  page: number,
  fetched: number,
  onPage: number,
): boolean {
  if (onPage === 0) return true;
  if (typeof info?.total_pages === "number") return page >= info.total_pages;
  if (typeof info?.total_count === "number") return fetched >= info.total_count;
  if (typeof info?.per_page === "number") return onPage < info.per_page;
  return false;
}

/** 按顺序比较两份预览名：判断接口是否压根不分页，要求两次响应一模一样 */
function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * 只比名字集合：两遍之间顺序变了（比如按更新时间排序）不代表漏了什么。
 * 每一遍内部名字已经去重，长度相同且一方全在另一方里即相等。
 */
function sameNameSet(a: Preview[], b: Preview[]): boolean {
  const names = new Set(a.map((p) => p.name));
  return a.length === b.length && b.every((p) => names.has(p.name));
}
