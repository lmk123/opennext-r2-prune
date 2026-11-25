import { normalizePrefix, rulePrefix } from "./prefix.ts";

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
  /** 每个 <Contents> 的 <LastModified> 原文，顺序同响应；缺这个字段的对象记为 undefined */
  lastModified: (string | undefined)[];
  isTruncated: boolean;
  nextContinuationToken: string | undefined;
}

/**
 * 只取 CommonPrefixes、对象的写入时间与分页字段。<Contents> 里的对象 key 一概不碰：build 目录全靠
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
    lastModified: blocks(xml, "Contents").map((block) => text(block, "LastModified")?.trim()),
    isTruncated: text(xml, "IsTruncated")?.trim() === "true",
    nextContinuationToken: text(xml, "NextContinuationToken"),
  };
}

/**
 * 一条由本工具管理的规则。用户自有规则不会被解析成这个形状。
 *
 * 字段是完整的：判定层要拿它与「期望的样子」逐字段比对，才能发现选项变了
 * （比如换了 --expire-days）需要重写。换了 --prefix 的旧规则不归这一趟管，进的是 others。
 */
export interface OwnRule {
  buildId: string;
  /** 规则实际作用的前缀，形如 `incremental-cache/<buildId>/` */
  prefix: string;
  /** 过期天数。0 表示从现有配置里没解析出合法的 <Expiration><Days>，必然与期望值不等 */
  expireDays: number;
  /** <Status> 是否为 Enabled */
  enabled: boolean;
  /**
   * 没有 <Filter><Prefix>、却有直接挂在 <Rule> 下的裸 <Prefix> 时记下它的原值。R2 不认这种写法，
   * 规则仍按前缀为空（作用于整个 bucket）对待；留下原值只为报警告时如实说明读到了什么。
   */
  barePrefix?: string;
  /**
   * 从 bucket 读出的规则带着原始 <ID>，报给用户时照原样写出，好让人在 lifecycle list 里找得到；
   * 判定层新生成的规则没有，ID 由 renderLifecycle 拼出
   */
  id?: string;
}

/** 规则里与归属无关的部分 */
type RuleBody = Omit<OwnRule, "buildId" | "id">;

/** 从某个缓存前缀的视角分拣出的 lifecycle 配置 */
export interface LifecycleDoc {
  /** 分拣时用的缓存前缀（已归一化），own 里的规则都属于它 */
  prefix: string;
  own: OwnRule[];
  /** 用户自己配的规则、以及本工具为别的缓存前缀写的规则，保留原始 XML 片段，写回时原样放回去 */
  foreign: string[];
}

/** 本工具为别的缓存前缀写的规则。scope 是它所属的缓存前缀，取自 ID，原样保留不归一化 */
export interface OtherScopeRule extends OwnRule {
  id: string;
  scope: string;
}

/** 带本工具标记、却拆不出「前缀 + buildId」的规则 */
export interface MalformedRule extends RuleBody {
  id: string;
}

/** 从 bucket 读出的配置 */
export interface ParsedLifecycle extends LifecycleDoc {
  /**
   * 本工具为别的缓存前缀写的规则，原始片段已在 foreign 里照常搬运；这里另行解析出来，
   * 只供安全检查用（前缀互相嵌套、对整个 bucket 生效），这一趟从不改写它们
   */
  others: OtherScopeRule[];
  /**
   * 带本工具标记、格式却不对的规则，原始片段同样在 foreign 里。解析时不抛错：先让调用方报出其中
   * 对整个 bucket 生效的，再由 checkLayout 中止
   */
  malformed: MalformedRule[];
}

export const RULE_ID_PREFIX = "opennext-r2-prune:";

/** S3 规范里 lifecycle 规则 ID 的长度上限（R2 未实测，按规范来） */
export const MAX_RULE_ID_LENGTH = 255;

/**
 * 规则 ID 是标记加上规则作用的前缀，形如 `opennext-r2-prune:incremental-cache/<buildId>/`。
 * 必须带上缓存前缀：多个站点共用一个 bucket（各用各的前缀）时，每趟运行只能认领自己前缀下的规则，
 * 否则会把别家的规则当成目录已空的残留回收掉；两个站点的 buildId 也可能相同（确定性 build id），
 * 只用 buildId 当 ID 会撞。
 */
export function ruleId(prefix: string, buildId: string): string {
  return `${RULE_ID_PREFIX}${rulePrefix(prefix, buildId)}`;
}

/**
 * 从 lifecycle 配置 XML 中分拣出「本工具为 prefix 写的规则」与「其余规则」。
 * 归属只看 <ID>：以 RULE_ID_PREFIX 开头、且其后的前缀部分恰好等于 prefix。前缀取自 ID 而不是
 * <Filter><Prefix>，这样被 R2 丢掉前缀的规则仍能认回来、改写掉。别的前缀的规则与外部规则一样原样搬运，
 * 另外解析进 others 供安全检查用；拆不开的进 malformed，不在这里抛错。
 */
export function parseLifecycle(xml: string, prefix: string): ParsedLifecycle {
  const scope = normalizePrefix(prefix);
  const own: OwnRule[] = [];
  const foreign: string[] = [];
  const others: OtherScopeRule[] = [];
  const malformed: MalformedRule[] = [];

  for (const block of blocks(xml, "Rule")) {
    const id = text(block, "ID")?.trim();
    if (id === undefined || !id.startsWith(RULE_ID_PREFIX)) {
      foreign.push(block);
      continue;
    }
    const target = id.slice(RULE_ID_PREFIX.length);
    // buildId 是一级目录名，不含斜杠，所以最后一段就是 buildId，之前的部分就是缓存前缀。
    // 结尾斜杠可有可无：实测 R2 原样保留带 / 的 ID，被别的实现去掉结尾斜杠时仍认得回来
    const path = target.endsWith("/") ? target.slice(0, -1) : target;
    const buildId = path.slice(path.lastIndexOf("/") + 1);
    if (buildId === "" || !LITERAL_SAFE.test(target)) {
      foreign.push(block);
      malformed.push({ ...parseRuleBody(block, false), id });
      continue;
    }
    const ruleScope = path.slice(0, path.length - buildId.length);
    if (ruleScope !== scope) {
      foreign.push(block);
      others.push({ buildId, ...parseRuleBody(block, false), id, scope: ruleScope });
      continue;
    }
    own.push({ buildId, ...parseRuleBody(block, true), id });
  }

  return { prefix: scope, own, foreign, others, malformed };
}

/**
 * strict 只给本前缀的规则：它们会被比对、改写，前缀里有转义字符就得中止。别的前缀的、格式不对的
 * 只用来判断是否对整个 bucket 生效，从不写回，前缀原样留着不断言 —— 在这里抛错会让 getLifecycle
 * 整个失败，调用方就来不及报出其余对整个 bucket 生效的规则。
 */
function parseRuleBody(block: string, strict: boolean): RuleBody {
  const literal = (value: string, what: string) => (strict ? assertLiteral(value, what) : value);
  // 只认 <Filter><Prefix>：实测 R2 会静默丢掉直接挂在 <Rule> 下的 <Prefix>，那样的规则实际
  // 作用于整个 bucket。读不到 Filter 里的前缀就记为空：本前缀的规则会因前缀不符被判定层改写掉，
  // 其余的只会被报出来。
  const filter = text(block, "Filter");
  const filterPrefix = filter === undefined ? undefined : text(filter, "Prefix");
  // Filter 里没有 Prefix 时，块里能找到的 <Prefix> 只可能直接挂在 <Rule> 下
  const barePrefix = filterPrefix === undefined ? text(block, "Prefix")?.trim() : undefined;
  const days = Number(text(text(block, "Expiration") ?? "", "Days")?.trim());
  return {
    prefix: literal(filterPrefix ?? "", "规则中的 Prefix"),
    expireDays: Number.isInteger(days) && days > 0 ? days : 0,
    enabled: text(block, "Status")?.trim() === "Enabled",
    ...(barePrefix ? { barePrefix: literal(barePrefix, "规则中的裸 Prefix") } : {}),
  };
}

/**
 * 生成写回用的完整配置。别人的规则原样排在前面，本工具的规则按各自的字段重新渲染
 * —— 内容全部由判定层决定，这里只负责序列化。
 */
export function renderLifecycle(doc: LifecycleDoc): string {
  const rules = doc.own.map((rule) => {
    assertLiteral(rule.buildId, "待写入规则的 buildId");
    assertLiteral(rule.prefix, "待写入规则的 Prefix");
    // ID 与实际作用的前缀不一致的规则写下去，下一趟会按 ID 认领它，删的却是别处
    if (rule.prefix !== rulePrefix(doc.prefix, rule.buildId)) {
      throw new XmlAssumptionError(
        `待写入规则 ${rule.buildId} 的 Prefix 是 ${rule.prefix}，与缓存前缀「${doc.prefix}」对不上，已中止写入，` +
          `没有发出写请求。直接调用 renderLifecycle / putLifecycle 时请让每条规则的 Prefix 等于 <缓存前缀><buildId>/；` +
          `否则这是本工具的缺陷，请带上这条报错提 issue。`,
      );
    }
    if (!Number.isInteger(rule.expireDays) || rule.expireDays < 1) {
      throw new XmlAssumptionError(
        `待写入规则 ${rule.buildId} 的过期天数不合法：${rule.expireDays}，S3 要求至少 1 天。`,
      );
    }
    return (
      `<Rule>` +
      `<ID>${ruleId(doc.prefix, rule.buildId)}</ID>` +
      `<Status>${rule.enabled ? "Enabled" : "Disabled"}</Status>` +
      // 必须包在 <Filter> 里：R2 不认裸 <Prefix>，会悄悄把它丢掉，规则就变成删除整个 bucket
      `<Filter><Prefix>${rule.prefix}</Prefix></Filter>` +
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
