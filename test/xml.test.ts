import { describe, expect, it } from "vitest";
import {
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

  it("解析对象及其写入时间", () => {
    // key 的形状来自 OpenNext 的 computeCacheKey：<prefix>/<buildId>/<sha256>.<cacheType>
    const xml = `<ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>tok123</NextContinuationToken>
      <Contents>
        <Key>incremental-cache/build1/${"a".repeat(64)}.cache</Key>
        <LastModified>2026-08-20T09:03:11.000Z</LastModified>
      </Contents>
    </ListBucketResult>`;
    const result = parseListObjects(xml);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]!.lastModified?.toISOString()).toBe("2026-08-20T09:03:11.000Z");
    expect(result.nextContinuationToken).toBe("tok123");
  });

  it("遇到含 XML 转义字符的 key 就报错，而不是猜一个反转义结果", () => {
    const xml = `<ListBucketResult><Contents><Key>a&amp;b</Key></Contents></ListBucketResult>`;
    expect(() => parseListObjects(xml)).toThrow(XmlAssumptionError);
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
      { buildId: "oldbuild1", prefix: "incremental-cache/oldbuild1/" },
    ]);
    expect(parsed.foreign).toHaveLength(1);
    expect(parsed.foreign[0]).toContain("keep-user-logs");
  });

  it("写回时原样保留外部规则", () => {
    const parsed = parseLifecycle(doc);
    const xml = renderLifecycle(parsed, { expireDays: 1, style: "filter" });
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
    expect(renderLifecycle(parsed, { expireDays: 1, style: "filter" })).toContain(
      "tmp &amp; scratch",
    );
  });

  it("也认老式的、Prefix 直接挂在 Rule 下的写法", () => {
    const bare = `<LifecycleConfiguration><Rule>
      <ID>opennext-r2-prune:b2</ID><Status>Enabled</Status>
      <Prefix>incremental-cache/b2/</Prefix><Expiration><Days>1</Days></Expiration>
    </Rule></LifecycleConfiguration>`;
    expect(parseLifecycle(bare).own).toEqual([
      { buildId: "b2", prefix: "incremental-cache/b2/" },
    ]);
  });
});

describe("renderLifecycle", () => {
  it("两种 Prefix 包装式样都能生成", () => {
    const doc = { own: [{ buildId: "b1", prefix: "incremental-cache/b1/" }], foreign: [] };
    expect(renderLifecycle(doc, { expireDays: 1, style: "filter" })).toContain(
      "<Filter><Prefix>incremental-cache/b1/</Prefix></Filter>",
    );
    const bare = renderLifecycle(doc, { expireDays: 2, style: "bare" });
    expect(bare).toContain("<Prefix>incremental-cache/b1/</Prefix>");
    expect(bare).not.toContain("<Filter>");
    expect(bare).toContain("<Days>2</Days>");
  });

  it("拒绝把带可疑字符的 buildId 写进规则", () => {
    const doc = { own: [{ buildId: "b<1", prefix: "incremental-cache/b/" }], foreign: [] };
    expect(() => renderLifecycle(doc, { expireDays: 1, style: "filter" })).toThrow(
      XmlAssumptionError,
    );
  });
});
