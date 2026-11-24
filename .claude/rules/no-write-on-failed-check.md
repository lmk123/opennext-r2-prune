---
paths:
  - "src/run.ts"
  - "src/index.ts"
  - "src/plan.ts"
  - "src/xml.ts"
  - "src/cli.ts"
  - "src/store.ts"
  - "test/run.test.ts"
  - "test/index.test.ts"
---

# 校验没过时不能有写请求

- 改动 `collectPlan` / `makePlan` / `writeAndVerify` / `planPrune` 的流程，或新增一步安全校验时，在 `test/run.test.ts`（库入口的校验在 `test/index.test.ts`）里
  断言该校验失败时假 `fetchImpl` 没收到任何写请求（PUT），不能只断言抛错——只断言抛错，挪动写入顺序后测试照样能过。
