/**
 * R2 与 Cloudflare API 共用的重试：网络层失败和 5xx / 429 最多试 MAX_ATTEMPTS 次。
 * 最后一次拿到的响应无论成败都原样交回，由调用方按各自的协议解读错误；
 * 网络层失败到最后一次仍未成功，则抛出最后那个错误。和调用方一样不碰 Node 专属 API。
 */

export const MAX_ATTEMPTS = 3;

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
      await backoff(attempt);
      continue;
    }

    if ((response.status >= 500 || response.status === 429) && attempt < MAX_ATTEMPTS) {
      onRetry?.(attempt, `HTTP ${response.status}`);
      await backoff(attempt);
      continue;
    }
    return response;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 500));
}
