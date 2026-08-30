/**
 * 从线上站点读取当前正在服务的 BUILD_ID。
 *
 * @opennextjs/cloudflare 不需要任何额外配置就会把 .next/BUILD_ID 作为静态资源
 * 暴露在 /BUILD_ID 上，所以这是最贴近事实的来源 —— 比读本地构建产物可靠，
 * 尤其是构建发生在 Cloudflare 云上、跑清理的机器上压根没有 .next 目录时。
 */

/** Next.js 的 build id 用 nanoid 生成；16.2 起改为确定性 id，字符集仍是这一套 */
const BUILD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class BuildIdProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildIdProbeError";
  }
}

export function buildIdUrlFor(siteUrl: string): string {
  try {
    return new URL("/BUILD_ID", siteUrl).toString();
  } catch {
    // 最常见的是漏了协议（SITE_URL=example.com）。不包一层，调用方拿到的是 URL
    // 构造器的原生 TypeError，会绕过 cli 的错误分类直接甩出堆栈。
    throw new BuildIdProbeError(
      `站点地址不是合法的 URL：${JSON.stringify(siteUrl)}。请带上协议，例如 https://example.com。`,
    );
  }
}

export async function probeBuildId(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "follow",
      // 必须拿到此刻真正在服务的 id：中间缓存（CDN、公司代理）若返回上一个版本的
      // BUILD_ID，本工具就会把线上正在用的那个 build 判成作废，把活着的缓存删光。
      cache: "no-store",
      headers: { "cache-control": "no-cache, no-store, max-age=0", pragma: "no-cache" },
    });
  } catch (error) {
    throw new BuildIdProbeError(`请求 ${url} 失败：${String(error)}`);
  }

  if (!response.ok) {
    throw new BuildIdProbeError(
      `${url} 返回 HTTP ${response.status}。该站点可能没有把 BUILD_ID 暴露出来，请改用 --keep 显式指定要保留的 build id。`,
    );
  }

  // 命中 404 页面或路由兜底时会拿到一整页 HTML，那不是 build id
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new BuildIdProbeError(
      `${url} 返回的是 HTML（content-type: ${contentType}），说明请求被页面路由接管了，而不是命中静态的 BUILD_ID 文件。请改用 --keep 显式指定。`,
    );
  }

  const buildId = (await response.text()).trim();
  if (!BUILD_ID_PATTERN.test(buildId)) {
    throw new BuildIdProbeError(
      `${url} 的响应不像一个 build id：${JSON.stringify(buildId.slice(0, 80))}。请改用 --keep 显式指定。`,
    );
  }

  return buildId;
}
