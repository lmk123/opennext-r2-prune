import { describe, expect, it } from "vitest";
import {
  type OwnRule,
  parseLifecycle,
  parseListObjects,
  renderLifecycle,
  XmlAssumptionError,
} from "../src/xml.ts";

const listResponse = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>my-cache</Name>
  <Prefix>incremental-cache/</Prefix>
  <Delimiter>/</Delimiter>
  <IsTruncated>false</IsTruncated>
  <CommonPrefixes><Prefix>incremental-cache/AbC-123_xy/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>incremental-cache/zzz999/</Prefix></CommonPrefixes>
</ListBucketResult>`;

describe("parseListObjects", () => {
  it("取出 CommonPrefixes 而不把顶层 Prefix 混进来", () => {
    const result = parseListObjects(listResponse);
    expect(result.commonPrefixes).toEqual([
      "incremental-cache/AbC-123_xy/",
      "incremental-cache/zzz999/",
    ]);
    expect(result.isTruncated).toBe(false);
  });

  it("取出分页字段", () => {
    const xml = `<ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>tok123</NextContinuationToken>
      <CommonPrefixes><Prefix>incremental-cache/b1/</Prefix></CommonPrefixes>
    </ListBucketResult>`;
    const result = parseListObjects(xml);
    expect(result.isTruncated).toBe(true);
    expect(result.nextContinuationToken).toBe("tok123");
  });

  it("目录名含 XML 转义字符就报错，而不是猜一个反转义结果", () => {
    // 这些值会被拿去拼删除规则
    const xml = `<ListBucketResult><CommonPrefixes><Prefix>a&amp;b/</Prefix></CommonPrefixes></ListBucketResult>`;
    expect(() => parseListObjects(xml)).toThrow(XmlAssumptionError);
  });

  it("<Contents> 一概不解析：无关的对象名不该打断整次运行", () => {
    // --allow-root-prefix 下 bucket 根上的任意文件都会出现在这里，它们与 build 判定无关
    const xml = `<ListBucketResult>
      <IsTruncated>false</IsTruncated>
      <CommonPrefixes><Prefix>b1/</Prefix></CommonPrefixes>
      <Contents><Key>导出记录 2026.csv</Key></Contents>
    </ListBucketResult>`;
    expect(parseListObjects(xml).commonPrefixes).toEqual(["b1/"]);
  });
});

describe("parseLifecycle", () => {
  const doc = `<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration>
  <Rule>
    <ID>keep-user-logs</ID>
    <Status>Enabled</Status>
    <Filter><Prefix>logs/</Prefix></Filter>
    <Expiration><Days>30</Days></Expiration>
  </Rule>
  <Rule>
    <ID>opennext-r2-prune:oldbuild1</ID>
    <Status>Enabled</Status>
    <Filter><Prefix>incremental-cache/oldbuild1/</Prefix></Filter>
    <Expiration><Days>1</Days></Expiration>
  </Rule>
</LifecycleConfiguration>`;

  it("按 ID 前缀分拣自有规则与外部规则", () => {
    const parsed = parseLifecycle(doc);
    expect(parsed.own).toEqual([
      {
        buildId: "oldbuild1",
        prefix: "incremental-cache/oldbuild1/",
        expireDays: 1,
        enabled: true,
      },
    ]);
    expect(parsed.foreign).toHaveLength(1);
    expect(parsed.foreign[0]).toContain("keep-user-logs");
  });

  it("写回时原样保留外部规则", () => {
    const parsed = parseLifecycle(doc);
    const xml = renderLifecycle(parsed);
    expect(xml).toContain("<ID>keep-user-logs</ID>");
    expect(xml).toContain("<Prefix>logs/</Prefix>");
    expect(xml).toContain("<Days>30</Days>");
    expect(xml).toContain("<ID>opennext-r2-prune:oldbuild1</ID>");
  });

  it("外部规则含转义字符也不受影响 —— 它整块原样搬运，不被解析", () => {
    const withEntity = `<LifecycleConfiguration><Rule>
      <ID>tmp &amp; scratch</ID><Status>Enabled</Status>
      <Filter><Prefix>tmp/</Prefix></Filter><Expiration><Days>7</Days></Expiration>
    </Rule></LifecycleConfiguration>`;
    const parsed = parseLifecycle(withEntity);
    expect(parsed.own).toHaveLength(0);
    expect(renderLifecycle(parsed)).toContain("tmp &amp; scratch");
  });

  it("Prefix 直接挂在 Rule 下时记为空前缀 —— R2 不认这种写法，规则实际作用于整个 bucket", () => {
    const bare = `<LifecycleConfiguration><Rule>
      <ID>opennext-r2-prune:b2</ID><Status>Enabled</Status>
      <Prefix>incremental-cache/b2/</Prefix><Expiration><Days>1</Days></Expiration>
    </Rule></LifecycleConfiguration>`;
    expect(parseLifecycle(bare).own).toEqual([
      {
        buildId: "b2",
        prefix: "",
        expireDays: 1,
        enabled: true,
      },
    ]);
  });

  it("没有 Filter 也没有 Prefix 的自有规则，同样记为空前缀", () => {
    const none = `<LifecycleConfiguration><Rule>
      <ID>opennext-r2-prune:b4</ID><Status>Enabled</Status><Expiration><Days>2</Days></Expiration>
    </Rule></LifecycleConfiguration>`;
    expect(parseLifecycle(none).own[0]!.prefix).toBe("");
  });

  it("解析出过期天数与状态，好让判定层发现选项变了", () => {
    const doc7 = `<LifecycleConfiguration><Rule>
      <ID>opennext-r2-prune:b3</ID><Status>Disabled</Status>
      <Filter><Prefix>incremental-cache/b3/</Prefix></Filter><Expiration><Days>7</Days></Expiration>
    </Rule></LifecycleConfiguration>`;
    expect(parseLifecycle(doc7).own[0]).toEqual({
      buildId: "b3",
      prefix: "incremental-cache/b3/",
      expireDays: 7,
      enabled: false,
    });
  });
});

describe("renderLifecycle", () => {
  const rule = (overrides: Partial<OwnRule> = {}): OwnRule => ({
    buildId: "b1",
    prefix: "incremental-cache/b1/",
    expireDays: 1,
    enabled: true,
    ...overrides,
  });

  it("Prefix 一律包在 <Filter> 里，绝不生成裸 <Prefix>", () => {
    const xml = renderLifecycle({ own: [rule({ expireDays: 2 })], foreign: [] });
    expect(xml).toContain("<Filter><Prefix>incremental-cache/b1/</Prefix></Filter>");
    expect(xml.replace(/<Filter><Prefix>[^<]*<\/Prefix><\/Filter>/g, "")).not.toContain("<Prefix>");
    expect(xml).toContain("<Days>2</Days>");
  });

  it("拒绝把带可疑字符的 buildId 写进规则", () => {
    expect(() => renderLifecycle({ own: [rule({ buildId: "b<1" })], foreign: [] })).toThrow(
      XmlAssumptionError,
    );
  });

  it("过期天数不合法时拒绝写入", () => {
    expect(() => renderLifecycle({ own: [rule({ expireDays: 0 })], foreign: [] })).toThrow(
      XmlAssumptionError,
    );
  });
});
