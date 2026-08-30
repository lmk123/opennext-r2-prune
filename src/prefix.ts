/**
 * 缓存前缀的归一化。列举对象与生成 lifecycle 规则必须用同一套规则拼前缀，
 * 否则规则会作用在一个根本不存在的 key 空间上，删不掉任何东西。
 */

/** 归一化成 `foo/bar/`；前缀为空（缓存直接放在 bucket 根下）时返回空串。 */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}
