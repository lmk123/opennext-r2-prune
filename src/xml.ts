/**
 * 极简 XML 读写，只覆盖本工具用到的两种响应：ListObjectsV2 与 lifecycle 配置。
 *
 * 之所以敢手写而不引 XML 解析器：我们真正需要「解析成值」的字段只有 buildId，
 * 它来自 CommonPrefixes，字符集被 OpenNext 的目录布局约束死了，不含 XML 转义字符。
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
  /** Delimiter 模式下的 CommonPrefixes，原样保留（含请求前缀与结尾斜杠） */
  commonPrefixes: string[];
  isTruncated: boolean;
  nextContinuationToken: string | undefined;
}

/**
 * 只取 CommonPrefixes 与分页字段。<Contents> 里的对象 key 一概不碰：build 目录全靠
 * CommonPrefixes 认，key 从不参与拼规则，对它做布局断言只会让一个毫不相干的对象名
 * （--allow-root-prefix 下 bucket 根上随便一个带空格的文件）把整次运行打断。
 */
export function parseListObjects(xml: string): ListObjectsResult {
  const commonPrefixes = blocks(xml, "CommonPrefixes")
    .map((block) => text(block, "Prefix"))
    .filter((p): p is string => p !== undefined)
    .map((p) => assertLiteral(p, "CommonPrefixes 中的 Prefix"));

  return {
    commonPrefixes,
    isTruncated: text(xml, "IsTruncated")?.trim() === "true",
    nextContinuationToken: text(xml, "NextContinuationToken"),
  };
}

/**
 * 一条由本工具管理的规则。用户自有规则不会被解析成这个形状。
 *
 * 字段是完整的：判定层要拿它与「期望的样子」逐字段比对，才能发现选项变了
 * （比如换了 --expire-days 或 --lifecycle-style）需要重写。
 */
export interface OwnRule {
  buildId: string;
  /** 规则实际作用的前缀，形如 `incremental-cache/<buildId>/` */
  prefix: string;
  /** 过期天数。0 表示从现有配置里没解析出合法的 <Expiration><Days>，必然与期望值不等 */
  expireDays: number;
  /** Prefix 的包装形式：包在 <Filter> 里还是直接挂在 <Rule> 下 */
  style: "filter" | "bare";
  /** <Status> 是否为 Enabled */
  enabled: boolean;
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
    const filterPrefix = filter === undefined ? undefined : text(filter, "Prefix");
    const prefix = filterPrefix ?? text(block, "Prefix") ?? "";
    const days = Number(text(text(block, "Expiration") ?? "", "Days")?.trim());
    own.push({
      buildId,
      prefix: assertLiteral(prefix, "规则中的 Prefix"),
      expireDays: Number.isInteger(days) && days > 0 ? days : 0,
      style: filterPrefix === undefined ? "bare" : "filter",
      enabled: text(block, "Status")?.trim() === "Enabled",
    });
  }

  return { own, foreign };
}

/**
 * 生成写回用的完整配置。别人的规则原样排在前面，本工具的规则按各自的字段重新渲染
 * —— 内容全部由判定层决定，这里只负责序列化。
 */
export function renderLifecycle(doc: LifecycleDoc): string {
  const rules = doc.own.map((rule) => {
    assertLiteral(rule.buildId, "待写入规则的 buildId");
    assertLiteral(rule.prefix, "待写入规则的 Prefix");
    if (!Number.isInteger(rule.expireDays) || rule.expireDays < 1) {
      throw new XmlAssumptionError(
        `待写入规则 ${rule.buildId} 的过期天数不合法：${rule.expireDays}，S3 要求至少 1 天。`,
      );
    }
    const prefixXml =
      rule.style === "filter"
        ? `<Filter><Prefix>${rule.prefix}</Prefix></Filter>`
        : `<Prefix>${rule.prefix}</Prefix>`;
    return (
      `<Rule>` +
      `<ID>${ruleId(rule.buildId)}</ID>` +
      `<Status>${rule.enabled ? "Enabled" : "Disabled"}</Status>` +
      prefixXml +
      `<Expiration><Days>${rule.expireDays}</Days></Expiration>` +
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
