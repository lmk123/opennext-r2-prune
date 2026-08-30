/**
 * 极简 XML 读写，只覆盖本工具用到的两种响应：ListObjectsV2 与 lifecycle 配置。
 *
 * 之所以敢手写而不引 XML 解析器：我们真正需要「解析成值」的字段只有 buildId 和缓存
 * 对象的 key，而它们的字符集被 OpenNext 的 computeCacheKey 约束死了
 * （`${prefix}/${buildId}/${sha256}.${cacheType}`），不含 XML 转义字符。
 * 一旦出现转义字符就说明假设不成立，此时报错而不是猜（见 assertLiteral）。
 *
 * 用户自己在 bucket 上配的 lifecycle 规则则完全不解析，整块 XML 原样搬运，
 * 这样它们内部含什么字符都与我们无关。
 */

/** 允许出现在「未经转义就能安全读写」的值里的字符 */
const LITERAL_SAFE = /^[A-Za-z0-9_\-./]*$/;

export class XmlAssumptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlAssumptionError";
  }
}

/**
 * 断言取出的值不含 XML 转义字符。
 * 与其猜一个可能错误的反转义结果，不如直接失败 —— 这些值会被用来拼删除规则。
 */
function assertLiteral(value: string, what: string): string {
  if (!LITERAL_SAFE.test(value)) {
    throw new XmlAssumptionError(
      `${what} 含有预期之外的字符：${JSON.stringify(value)}。` +
        `本工具假定该值只由字母、数字、_ - . / 组成，出现其它字符说明 bucket 内容不符合 OpenNext 的布局，已中止。`,
    );
  }
  return value;
}

/** 取出所有 <tag>…</tag> 的内部原文（不做反转义）。tag 内部不得再嵌套同名标签。 */
function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]!);
}

/** 取出第一个 <tag>…</tag> 的内部原文；自闭合或缺失都返回 undefined。 */
function text(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  return re.exec(xml)?.[1];
}

export interface ListObjectsResult {
  /** Delimiter 模式下的 CommonPrefixes，已剥掉请求前缀与结尾斜杠 */
  commonPrefixes: string[];
  objects: { key: string; lastModified: Date | undefined }[];
  isTruncated: boolean;
  nextContinuationToken: string | undefined;
}

export function parseListObjects(xml: string): ListObjectsResult {
  const commonPrefixes = blocks(xml, "CommonPrefixes")
    .map((block) => text(block, "Prefix"))
    .filter((p): p is string => p !== undefined)
    .map((p) => assertLiteral(p, "CommonPrefixes 中的 Prefix"));

  const objects = blocks(xml, "Contents").map((block) => {
    const key = assertLiteral(text(block, "Key") ?? "", "对象 Key");
    const raw = text(block, "LastModified");
    const parsed = raw ? new Date(raw) : undefined;
    return {
      key,
      lastModified: parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined,
    };
  });

  return {
    commonPrefixes,
    objects,
    isTruncated: text(xml, "IsTruncated")?.trim() === "true",
    nextContinuationToken: text(xml, "NextContinuationToken"),
  };
}

/** 一条由本工具管理的规则。用户自有规则不会被解析成这个形状。 */
export interface OwnRule {
  buildId: string;
  /** 规则实际作用的前缀，形如 `incremental-cache/<buildId>/` */
  prefix: string;
}

export interface LifecycleDoc {
  own: OwnRule[];
  /** 用户自己配的规则，保留原始 XML 片段，写回时原样放回去 */
  foreign: string[];
}

export const RULE_ID_PREFIX = "opennext-r2-prune:";

function ruleId(buildId: string): string {
  return `${RULE_ID_PREFIX}${buildId}`;
}

/**
 * 从 lifecycle 配置 XML 中分拣出「本工具的规则」与「别人的规则」。
 * 归属判定只看 <ID> 是否以 RULE_ID_PREFIX 开头，因此不会误伤任何外部规则。
 */
export function parseLifecycle(xml: string): LifecycleDoc {
  const own: OwnRule[] = [];
  const foreign: string[] = [];

  for (const block of blocks(xml, "Rule")) {
    const id = text(block, "ID")?.trim();
    if (id === undefined || !id.startsWith(RULE_ID_PREFIX)) {
      foreign.push(block);
      continue;
    }
    const buildId = assertLiteral(id.slice(RULE_ID_PREFIX.length), "规则 ID 中的 buildId");
    // Prefix 既可能直接挂在 Rule 下（老式），也可能包在 Filter 里（v2）
    const filter = text(block, "Filter");
    const prefix = text(filter ?? block, "Prefix") ?? text(block, "Prefix") ?? "";
    own.push({ buildId, prefix: assertLiteral(prefix, "规则中的 Prefix") });
  }

  return { own, foreign };
}

/**
 * 生成写回用的完整配置。别人的规则原样排在前面，本工具的规则重新渲染。
 * Prefix 的包装形式（Filter 与否）由 style 决定 —— 实测 R2 认哪种就传哪种。
 */
export function renderLifecycle(
  doc: LifecycleDoc,
  opts: { expireDays: number; style: "filter" | "bare" },
): string {
  const rules = doc.own.map((rule) => {
    assertLiteral(rule.buildId, "待写入规则的 buildId");
    assertLiteral(rule.prefix, "待写入规则的 Prefix");
    const prefixXml =
      opts.style === "filter"
        ? `<Filter><Prefix>${rule.prefix}</Prefix></Filter>`
        : `<Prefix>${rule.prefix}</Prefix>`;
    return (
      `<Rule>` +
      `<ID>${ruleId(rule.buildId)}</ID>` +
      `<Status>Enabled</Status>` +
      prefixXml +
      `<Expiration><Days>${opts.expireDays}</Days></Expiration>` +
      `</Rule>`
    );
  });

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<LifecycleConfiguration>` +
    doc.foreign.map((block) => `<Rule>${block}</Rule>`).join("") +
    rules.join("") +
    `</LifecycleConfiguration>`
  );
}

/** 从 S3 风格的错误响应里取出 <Message>，取不到就返回原文的前若干字符。 */
export function parseErrorMessage(xml: string): string {
  const message = text(xml, "Message") ?? text(xml, "Code");
  return message ?? xml.slice(0, 200);
}
