/**
 * 从线上站点读取当前正在服务的 BUILD_ID。
 *
 * @opennextjs/cloudflare 不需要任何额外配置就会把 .next/BUILD_ID 作为静态资源
 * 暴露在 /BUILD_ID 上，所以这是最贴近事实的来源 —— 比读本地构建产物可靠，
 * 尤其是构建发生在 Cloudflare 云上、跑清理的机器上压根没有 .next 目录时。
 */

import { isTransientStatus, MAX_ATTEMPTS, type OnRetry, withRetry } from "./retry.ts";

/** Next.js 的 build id 用 nanoid 生成；16.2 起改为确定性 id，字符集仍是这一套 */
const BUILD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class BuildIdProbeError extends Error {
  /** 限流、服务端故障这类暂时性失败：地址本身没问题，稍后重跑即可，不该给出改配置的建议 */
  readonly transient: boolean;

  constructor(message: string, transient = false) {
    super(message);
    this.name = "BuildIdProbeError";
    this.transient = transient;
  }
}

export function buildIdUrlFor(siteUrl: string): string {
  try {
    return new URL("/BUILD_ID", siteUrl).toString();
  } catch {
    // 最常见的是漏了协议（SITE_URL=example.com）。不包一层，调用方拿到的是 URL
    // 构造器的原生 TypeError，会绕过 cli 的错误分类直接甩出堆栈。
    throw new BuildIdProbeError(
      `The site URL is not a valid URL: ${JSON.stringify(siteUrl)}. Include the protocol, e.g. https://example.com.`,
    );
  }
}

/**
 * 报错只说清楚哪里不对，不给补救办法：同一个失败，读站点时该改用 --keep，读 Worker 版本或
 * 预览时 --keep 却帮不上忙 —— 办法由调用方按自己的模式补上。
 */
export async function probeBuildId(
  url: string,
  fetchImpl: typeof fetch = fetch,
  onRetry?: OnRetry,
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    // 读 Worker 版本与预览时一趟要探几十上百个地址，任何一个读不到都会中止整趟，
    // 所以偶发的 5xx / 网络抖动必须重试，不能让它们决定成败
    response = await withRetry(
      (attemptSignal) =>
        fetchImpl(url, {
          redirect: "follow",
          // 必须拿到此刻真正在服务的 id：中间缓存（CDN、公司代理）若返回上一个版本的
          // BUILD_ID，本工具就会把线上正在用的那个 build 判成作废，把活着的缓存删光。
          cache: "no-store",
          headers: { "cache-control": "no-cache, no-store, max-age=0", pragma: "no-cache" },
          signal: attemptSignal,
        }),
      onRetry,
      signal,
    );
  } catch (error) {
    throw new BuildIdProbeError(`Request to ${url} failed: ${String(error)}`);
  }

  if (isTransientStatus(response.status)) {
    throw new BuildIdProbeError(
      `${url} returned HTTP ${response.status} ${MAX_ATTEMPTS} times in a row` +
        ` (${response.status === 429 ? "rate limited" : "server error"}); just run again later.`,
      true,
    );
  }
  if (!response.ok) {
    throw new BuildIdProbeError(
      `${url} returned HTTP ${response.status}; BUILD_ID may not be exposed.`,
    );
  }

  // 命中 404 页面或路由兜底时会拿到一整页 HTML，那不是 build id
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new BuildIdProbeError(
      `${url} returned HTML (content-type: ${contentType}), which means the request was handled by a page route instead of hitting the static BUILD_ID file.`,
    );
  }

  const buildId = (await response.text()).trim();
  if (!BUILD_ID_PATTERN.test(buildId)) {
    throw new BuildIdProbeError(
      `The response from ${url} doesn't look like a build id: ${JSON.stringify(buildId.slice(0, 80))}.`,
    );
  }

  return buildId;
}
