# opennext-r2-prune

[English](README.md) | 简体中文

清理 `@opennextjs/cloudflare` 留在 Cloudflare R2 上、已经没人用的旧 build 增量缓存。

## 特点

- **快，且不随缓存规模变慢**：不逐个列举、删除缓存对象，而是给作废的 build 目录挂 R2 lifecycle 规则，由 R2 在后台删除。目录里有 1 万还是 100 万个文件，耗时一样。
- **按事实判断保留哪些 build**：直接读线上版本和预览的 `/BUILD_ID`，默认保留最近 3 个线上 build 和所有预览的 build，不依赖本地构建产物。
- **宁可中止，绝不多删**：任何探测失败、保留集为空、前缀为空等异常都会直接退出，不会降级成「删除全部」；刚写入不满 24 小时的 build 不删，正在部署的新版本不会被误删。
- **只动自己的规则**：你在 bucket 上配的其它 lifecycle 规则原样保留；写入后回读逐条核对，不符就撤销。
- **无状态、幂等**：每次运行重新算出完整结果，情况没变就什么都不写，适合放进定时任务。
- **CLI 与库两用**：库入口只用 Web 标准 API，Node 22.12+ 和 Cloudflare Worker 里都能跑。

## 用法

### 命令行

```bash
npx opennext-r2-prune \
  --worker <WORKER_NAME> \
  --api-token <CLOUDFLARE_API_TOKEN> \
  --account-id <CLOUDFLARE_ACCOUNT_ID> \
  --bucket <R2_BUCKET> \
  --access-key-id <R2_ACCESS_KEY_ID> \
  --secret-access-key <R2_SECRET_ACCESS_KEY> \
  --dry-run
```

确认打印出的计划无误后去掉 `--dry-run`。交互终端下会让你确认一次；非交互环境（定时任务）要显式传 `--yes`。所有参数都可以用环境变量代替，完整选项见 `--help`。命令行的输出和报错信息都是英文。

常用选项：

| 选项 | 说明 |
| --- | --- |
| `--prefix` | 缓存前缀，默认 `incremental-cache`，与 OpenNext 的 `NEXT_INC_CACHE_R2_PREFIX` 一致 |
| `--recent-builds` | 保留最近几个不同的线上 build，默认 3 |
| `--keep` | 额外保留的 build id，可重复传 |
| `--grace-hours` | 写入不满这么多小时的 build 不删，默认 24 |
| `--url` | 没有 API token 时，只读站点当前的 `/BUILD_ID`（只能保住此刻线上的一个 build） |

### 权限

- **R2 API token**：写入需要 **Admin Read & Write**，只跑 `--dry-run` 用 **Admin Read only** 即可。lifecycle 是 bucket 级配置，Object 级 token 读写不了。Admin token 作用于整个账号，请妥善保管。
- **Cloudflare API token**：需要 **Account › Workers Scripts › Read**。
- Worker 需开启 workers.dev 与 `preview_urls`，工具要从这些地址读 `/BUILD_ID`。**实现了 Durable Object 的 Worker 没有版本预览 URL**，请改用 `--url` 加 `--keep`。

### 定时任务

每周或每月跑一次即可：

```yaml
# .github/workflows/prune-r2-cache.yml
on:
  schedule:
    - cron: "0 3 * * 1" # 每周一 03:00 UTC
jobs:
  prune:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx opennext-r2-prune@0.2 --yes
        env:
          WORKER_NAME: your-worker
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

### 作为库调用

```bash
npm install opennext-r2-prune
```

```ts
import { prune } from "opennext-r2-prune";

const result = await prune({
  bucket: "my-cache",
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  worker: "my-worker",
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  // 不给 confirm 就直接写入
  confirm: (plan) => plan.expire.length < 50,
  // 务必报出来：探测失败而中止时，这是得知这些危险规则的唯一途径
  onWholeBucketRules: (ids) => console.warn("对整个 bucket 生效的规则：", ids),
});
```

选项与命令行开关一一对应，改成驼峰（`--recent-builds` → `recentBuilds`），`--url` 对应 `siteUrl`。想先看计划再决定写不写，用两段式的 `planPrune(options)`，确认后调用它返回的 `apply()`。失败一律抛出带类型的异常（`PlanError`、`S3Error`、`PruneWriteError` 等）；`PruneWriteError` 的 `written` 为 `true` 时，请按报错说明立即检查 bucket 的 lifecycle 规则。

### 多个站点共用一个 bucket

给每个站点配一个不同的缓存前缀，然后每个站点各跑一次，`--prefix` 与 `--worker` / `--url` 对应着传。前缀必须各不相同、不能互相嵌套、不能为空；几趟运行要依次进行，不要并发。

### 注意事项

- **删除不是即时的**，R2 通常在 24 小时内删完。
- **回滚到已判作废的 build 后，立即手动跑一次**，摘掉它身上的删除规则（Next.js 16.2+ 的 build id 是确定性的，用同一个 id 重新部署时同理，部署前先用 `--keep` 保住）。
- **已上传但迟迟没部署的版本只受 `--grace-hours` 保护**，打算隔很久再部署时请调大它，或用 `--keep` 保留。
- 只用 `--url` 时只保留此刻线上的一个 build，回滚目标、预览、灰度中的旧版本都会被判作废。
- R2 每个 bucket 最多 1000 条 lifecycle 规则，本工具一般最多用到 990 条，积压太多时会分批挂规则，多跑几轮才能清完。改了 `--prefix` 后，旧前缀下的规则不再归新前缀管，需要手动删除。
- 不要在 Dashboard 上手动改、删本工具的规则（ID 形如 `opennext-r2-prune:<前缀>/<buildId>/`），想清理就再跑一次工具。规则可以在 Dashboard 的 bucket 设置里，或用 `npx wrangler r2 bucket lifecycle list <bucket>` 查看。

## 工作原理

OpenNext 每次发布都会以新的 `BUILD_ID` 在 R2 里建一个缓存目录，却从不清理旧的。S3/R2 没有「删除目录」的操作，常规做法要把几十万个对象逐个列出再删，非常慢。

本工具每次运行：

1. **列出 bucket 里现有的 build 目录**（只列一级目录，通常一个请求）。
2. **找出还在用的 build**：通过 Cloudflare API 找到最近的线上版本和全部预览，读它们的 `/BUILD_ID`（绕开缓存）。保留集 = 最近 3 个不同的线上 build ∪ 所有预览的 build ∪ `--keep`。
3. **其余的 build 判为作废**，刚写入不满 `--grace-hours` 的除外。
4. **整份重写 bucket 的 lifecycle 配置**：给每个作废 build 的目录挂一条删除规则，回收目录已经删空的规则，摘掉又要保留的 build 上的规则，你自己的规则原样保留。写完立即读回核对，不符就撤掉本工具的规则。

之后由 R2 在后台删除。整个过程不遍历缓存对象，发给 R2 的请求数基本恒定。

## 许可

[MIT](LICENSE)
