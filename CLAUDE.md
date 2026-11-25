# CLAUDE.md

## 命令

```bash
pnpm typecheck                              # tsc --noEmit（tsup 不做类型检查）
pnpm start --help                           # 直接跑源码；不要写 `pnpm start -- …`，`--` 会被原样传入导致 parseArgs 报错
pnpm test:e2e                               # 真实 R2 实测，自动读 .env（变量见 .env.example；worktree 里读主仓库根的）
```

- 改了写入、核对、安全校验或 XML 的行为后跑 `pnpm test:e2e`：假 R2 测不出 R2 的真实行为（会静默改写规则、读回时重排顺序）。

## 分层约束

- `cli.ts` 是**唯一**允许用 Node 专属 API 的文件，其余模块只用 Web 标准 API（`fetch`、`AbortSignal`、`aws4fetch`），为将来搬进 Cloudflare Cron Worker 保留。
- 所有网络请求都走 `retry.ts` 的 `withRetry`。

## 不能破坏的不变量

- 探测失败、保留集为空、保留集与现存 build 无交集、前缀为空（未加 `--allow-root-prefix`）都必须中止，永远不能降级成「删除全部」。

## 约定

- import 带 `.ts` 后缀：`start` 靠 Node 类型擦除直接跑源码，不会补后缀（不可擦除语法由 tsconfig 的 `erasableSyntaxOnly` 拦住）。
- 代码注释、报错信息、README、commit message 都用中文；commit 用 `feat:` / `fix:` / `perf:` / `chore:` 前缀。
- 报错信息要说明是哪一步失败、怎么补救。
- 改动行为时同步更新 README 以及 `cli.ts` 里的 `USAGE`。
- 参数校验有两份：`cli.ts` 按开关名报错，`index.ts` 的 `validate` 按库选项名报错，改一处要同步另一处。
- `.env` 存放本地实测用的真实凭证（已 gitignore），不要读出或提交其内容；新增开发、测试要用的环境变量时同步写进 `.env.example`。

## 更多上下文
- 记项目知识：只记 Claude 不知道就会做错、读代码推不出来、测试和 lint 拦不住、错了不报错或代价高的结论（被纠正过的做法、外部系统的实测特性、不可逆操作的约束），一条结论最多带一句理由。只涉及一个文件的写成紧贴代码的短注释，几个文件共用的写进 `.claude/rules/`，流程写成 skill（装了 context-keeper 插件就用 `record-context`）。经过、状态、实测流水留在 commit 和 PR 里，不写进仓库文件，也不留指针；不写成长注释，也不只记在自动记忆里。改动让已有的结论不再成立时，同一次改动里改掉或删掉。
