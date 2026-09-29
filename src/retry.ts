/**
 * R2、Cloudflare API 与读 BUILD_ID 共用的重试：网络层失败和 5xx / 429 最多试 MAX_ATTEMPTS 次。
 * 最后一次拿到的响应无论成败都原样交回，由调用方按各自的协议解读错误；
 * 网络层失败到最后一次仍未成功，则抛出最后那个错误。和调用方一样不碰 Node 专属 API。
 */

export const MAX_ATTEMPTS = 3;
/** 服务端给的 Retry-After 再长也只等这么久，免得定时任务被一个响应头挂住 */
const MAX_RETRY_AFTER_MS = 60_000;

export type OnRetry = (attempt: number, reason: string) => void;

export async function withRetry(send: () => Promise<Response>, onRetry?: OnRetry): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      // 网络层失败同样值得重试
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      onRetry?.(attempt, String(error));
      await sleep(backoffMs(attempt));
      continue;
    }

    if ((response.status >= 500 || response.status === 429) && attempt < MAX_ATTEMPTS) {
      // 限流时照固定退避重试多半还是 429，服务端说了要等多久就至少等那么久
      const wait = Math.max(backoffMs(attempt), retryAfterMs(response) ?? 0);
      onRetry?.(attempt, `HTTP ${response.status}`);
      await sleep(wait);
      continue;
    }
    return response;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function backoffMs(attempt: number): number {
  return 2 ** (attempt - 1) * 500;
}

/** Retry-After 可以是秒数，也可以是 HTTP 日期 */
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  if (Number.isNaN(ms)) return undefined;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
