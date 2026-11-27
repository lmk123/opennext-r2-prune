# opennext-r2-prune

[English](README.md) | 简体中文

清理 `@opennextjs/cloudflare` 留在 Cloudflare R2 上、已经用不到的旧 build 增量缓存。

## 动机

OpenNext 启用 R2 增量缓存后，每次上线都会用新的 build id 另存一份缓存，旧的却不会自动删除。这些缓存会不断占用 R2 的存储空间，最终变成账单。

我一开始用 `rclone` 删除，但实在太慢，于是写了这个工具，改用 R2 的 [Object lifecycle 规则](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)来删除旧缓存。

## 特点

- **快，且不随缓存规模变慢**：工具不遍历缓存对象，只读取 bucket 里的 build 目录名（外加给每个要新挂规则的 build 读一个对象的写入时间），再给不再需要的目录写上 lifecycle 规则，真正的删除由 R2 在后台完成（通常在 24 小时内）。因此不管目录里有多少文件，耗时都一样。
- **按事实判断保留哪些 build**：直接读线上版本和预览在 workers.dev 上的 `/BUILD_ID`，默认保留最近 3 个线上 build 和所有预览的 build，不依赖本地构建产物。
- **宁可中止，绝不多删**：探测失败、找不到任何要保留的 build、前缀为空等异常都会直接退出，不会退化成「全部删除」；写入不满 24 小时的 build 也不删，因此正在部署的新版本不会被误删。
- **CLI 与库两用**：库入口只用 Web 标准 API，在 Cloudflare Worker 这类环境里也能运行。

## 用法

### 准备工作

1. **创建 R2 API token**，用来读写 bucket 的 lifecycle 规则：
   1. 进入 [R2 的 API Tokens 页面](https://dash.cloudflare.com/r2/api-tokens)。
   2. 点击 **Create Account API token**（也可以选 **Create User API token**，但你被移出该账号后它会失效）。
   3. **Permissions** 选 **Admin Read & Write**；如果只想先用 `--dry-run` 看看计划，选 **Admin Read only** 即可。不要选 Object 开头的权限：lifecycle 是 bucket 级配置，Object 权限的 token 读写不了。
   4. 创建后复制 **Access Key ID** 和 **Secret Access Key**，分别对应 `--access-key-id` 和 `--secret-access-key`。Secret Access Key 只显示这一次。

   Admin 权限的 token 无法限定到单个 bucket，对整个账号生效，请妥善保管。
2. **创建 Cloudflare API token**，用来查询 Worker 的线上版本和预览（只用 `--url` 时不需要）：
   1. 打开 [API Tokens](https://dash.cloudflare.com/profile/api-tokens)（右上角头像 › **My Profile** › **API Tokens**），点击 **Create Token**。
   2. 依次选择 **Start from scratch** › **Start with an Account policy**。
   3. 在 **Policies** 里搜索 `Workers Scripts`，勾选它的 **Read** 权限。
   4. 点击 **Continue to summary**，再点 **Create Token**，复制生成的 token，对应 `--api-token`。token 只显示这一次。
3. **记下 Account ID**：[R2 Object Storage 页面](https://dash.cloudflare.com/r2/overview)的 **Account Details** 里就有，对应 `--account-id`。
4. **确认 Worker 开启了 workers.dev 域名与 `preview_urls`**，工具要从这些地址读 `/BUILD_ID`。**实现了 Durable Object 的 Worker 不会生成版本预览 URL**，这种情况请改用 `--url` 加 `--keep`。

### 命令行

```bash
npx opennext-r2-prune \
  --worker <WORKER_NAME> \
  --bucket <R2_BUCKET> \
  --api-token <CLOUDFLARE_API_TOKEN> \
  --account-id <CLOUDFLARE_ACCOUNT_ID> \
  --access-key-id <R2_ACCESS_KEY_ID> \
  --secret-access-key <R2_SECRET_ACCESS_KEY> \
  --dry-run
```

确认打印出的计划无误后，去掉 `--dry-run` 再跑一次。交互终端下会请你确认一次；非交互环境（如定时任务）需要显式传 `--yes`。凭证、bucket、`--worker`、`--api-token`、`--url` 与 `--prefix` 可以用环境变量代替，变量名与完整选项见 `--help`。

常用选项：

| 选项 | 说明 |
| --- | --- |
| `--prefix` | 缓存前缀，默认 `incremental-cache`，需与 OpenNext 的 `NEXT_INC_CACHE_R2_PREFIX` 一致 |
| `--recent-builds` | 保留最近几个不同的线上 build，默认 3 |
| `--keep` | 额外保留的 build id，可重复传 |
| `--grace-hours` | 写入不满多少小时的 build 不删，默认 24 |
| `--url` | 没有 Cloudflare API token 时，改为读取站点当前的 `/BUILD_ID`（只能保住此刻线上的那一个 build） |

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
  // 不传 confirm 就直接写入
  confirm: (plan) => plan.expire.length < 50,
  // 务必报出来：探测失败而中止时，这是得知这些危险规则的唯一途径
  onWholeBucketRules: (ids) => console.warn("对整个 bucket 生效的规则：", ids),
});
```

带值的开关以及 `--force`、`--allow-root-prefix` 都有对应的选项，改成驼峰写法（`--recent-builds` → `recentBuilds`），`--url` 对应 `siteUrl`。其余开关没有同名选项：代替 `--dry-run` 的是两段式的 `planPrune(options)`，先看计划，确认后再调用它返回的 `apply()`；代替 `--yes` 的是不传 `confirm`；代替 `--verbose` 的是传 `onRetry`。失败一律以带类型的异常抛出（`PlanError`、`S3Error`、`PruneWriteError` 等）；`PruneWriteError` 的 `written` 为 `true` 时，请按报错说明立即检查 bucket 的 lifecycle 规则。

### 多个站点共用一个 bucket

给每个站点配一个不同的缓存前缀，然后每个站点各跑一次，`--prefix` 与对应站点的 `--worker` / `--url` 一起传。前缀必须各不相同、不能互相嵌套，也不能为空；多次运行要依次进行，不要并发。

### 注意事项

- **删除不是即时的**，R2 通常在 24 小时内删完。
- **回滚到已被判作废的 build 后，请立即手动跑一次**，摘掉它身上的删除规则。Next.js 16.2+ 的 build id 是确定性的，用同一个 id 重新部署时也一样，部署前先用 `--keep` 保住它。
- **已上传但迟迟没有部署的版本只受 `--grace-hours` 保护**。打算隔很久再部署时，请调大它，或用 `--keep` 保留。
- 只用 `--url` 时只会保留此刻线上的那一个 build，回滚目标、预览以及灰度中的旧版本都会被判作废。
- R2 每个 bucket 最多 1000 条 lifecycle 规则，本工具一般最多用到 990 条。积压太多时会分批挂规则，需要多跑几轮才能清完。改了 `--prefix` 后，旧前缀下的规则不再由工具管理，需要手动删除。
- 不要在 Dashboard 上手动修改或删除本工具在当前前缀下的 Object lifecycle 规则（ID 形如 `opennext-r2-prune:<前缀>/<buildId>/`），想清理就再跑一次工具。旧前缀下的规则，以及工具报错里明确要求手动删除的规则不在此列。规则可以在 Dashboard 的 bucket 设置里查看，也可以用 `npx wrangler r2 bucket lifecycle list <bucket>`。

## 工作原理

S3/R2 没有「删除目录」的操作，常规做法要把目录里的对象逐个列出再删除，缓存积累到几十万个对象时会非常慢。本工具把删除交给 R2 的 lifecycle 规则，每次运行：

1. **列出 bucket 里现有的 build 目录**：只列一级目录，通常一个请求就够。
2. **找出还在用的 build**：通过 Cloudflare API 找到最近的线上版本和全部预览，读它们的 `/BUILD_ID`（绕开缓存）。保留最近 3 个不同的线上 build、所有预览的 build，以及 `--keep` 指定的 build。
3. **其余 build 判为作废**，写入不满 `--grace-hours`（默认 24 小时）的除外。
4. **整份重写 bucket 的 lifecycle 配置**：给每个作废 build 的目录挂一条删除规则，回收目录已经删空的规则，摘掉重新需要保留的 build 上的规则，你自己的规则原样保留。写完立即读回核对，不符就撤掉本工具的规则。

之后由 R2 在后台删除。整个过程不遍历缓存对象，发给 R2 的请求数与对象数量无关：除了固定的几个请求，每个这次要新挂规则的 build 还要读一次写入时间，所以第一次接手积压了很多 build 的 bucket 时，每个 build 都要读一次。

## 许可

[MIT](LICENSE)
