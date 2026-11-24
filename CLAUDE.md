# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

给 `@opennextjs/cloudflare` 部署清理 R2 里过期 `BUILD_ID` 缓存目录的 CLI。它不删对象，而是给作废的
`<prefix>/<buildId>/` 挂 R2 lifecycle 规则，由 R2 服务端删除。用法、安全设计和 R2 实测行为见 README。

## 命令

```bash
pnpm install
pnpm test                                   # vitest run
pnpm vitest run test/plan.test.ts -t "关键字"  # 单个文件 / 单个用例
pnpm typecheck                              # tsc --noEmit（tsup 不做类型检查）
pnpm build                                  # tsup → dist/cli.js
pnpm start --help                           # 直接跑源码；不要写 `pnpm start -- …`，`--` 会被原样传入导致 parseArgs 报错
```

## 架构

一次运行是一条直线，本地不留任何状态，每次全量重算后整份覆盖 lifecycle 配置（因此幂等）：

1. `run.ts` `collectPlan`：先并发「列一级目录」+「读现有 lifecycle」，**之后**才探测保留集。这个先后
   顺序是有意的：探测期间新出现的 build 不会出现在已列出的目录里，就不会被误判作废。
2. 探测保留集：`--url` 读站点 `/BUILD_ID`；`--worker` 经 `cloudflare.ts` 找近期 deployment 的版本 URL 与全部
   预览 URL，逐个读 `/BUILD_ID`（`build-id.ts`）。三条线并发，任何一处失败就 abort 全部在途请求并整体退出。
3. `plan.ts` `makePlan`：纯函数，不发请求，**所有安全校验都在这里抛 `PlanError`**，校验不过就走不到写入。
4. `run.ts` `writeAndVerify`：PUT 后 GET 回读（不符时重读，最多 3 次），用 `verifyWritten` 逐条比对；本工具
   规则对不上或读不回来，就用**写入前**的外部规则重写一份配置撤掉本工具全部规则，再回读确认撤销，CLI 以
   退出码 2 结束。只有外部规则条数不符时只提示、不撤销。

分层约束：
- `cli.ts` 是**唯一**允许用 Node 专属 API 的文件（参数、环境变量、终端交互、`node:crypto` 的 MD5 注入）。
  其余模块只用 Web 标准 API（`fetch`、`AbortSignal`、`aws4fetch`），为将来搬进 Cloudflare Cron Worker 保留。
- 所有网络请求都走 `retry.ts` 的 `withRetry`（重试、单次超时管到 body 读完、外部 signal 中止）。
- `xml.ts` 是手写的极简 XML：只解析 buildId（来自 `CommonPrefixes`），遇到 XML 转义字符就抛
  `XmlAssumptionError` 而不是猜；外部（用户自己的）lifecycle 规则**不解析、整块原样搬运**。

## 不能破坏的不变量

- 规则归属只看 ID 前缀 `opennext-r2-prune:`（`RULE_ID_PREFIX`），绝不改动外部规则。
- 规则只生成 `<Filter><Prefix>` 式样，前缀必须带结尾斜杠（`rulePrefix`）。R2 会静默丢掉裸 `<Prefix>`，
  使规则作用于整个 bucket——不要重新引入 bare 式样。
- 探测失败、保留集为空、保留集与现存 build 无交集、前缀为空（未加 `--allow-root-prefix`）都必须中止，
  永远不能降级成「删除全部」。
- 列目录的前缀与规则前缀必须共用 `prefix.ts` 的 `normalizePrefix`。
- 测试的核心断言是「任何校验没过时都没有写请求发出」：`test/run.test.ts` 用按 URL 派发的假 `fetchImpl`
  模拟 R2 与 Cloudflare API，并记录调用。改动流程时保持这类断言。

## 约定

- `start` 脚本靠 Node 的类型擦除直接跑源码，所以只能用可擦除的 TS 语法：不要用构造函数参数属性、`enum`、
  `namespace`；import 带 `.ts` 后缀（tsconfig 的 `rewriteRelativeImportExtensions` 处理构建）。
- 代码注释、报错信息、README、commit message 都用中文；commit 用 `feat:` / `fix:` / `perf:` / `chore:` 前缀。
  报错信息要说明是哪一步失败、怎么补救（参见 `store.ts` 的 `PERMISSION_HINT`、`run.ts` 的 `explainProbe`）。
- 改动行为时同步更新 README（它记录了安全设计与 R2 实测结论）以及 `cli.ts` 里的 `USAGE`。
- `.secrets/` 存放本地真实环境实测用的凭证（已 gitignore），不要读出或提交其内容。
