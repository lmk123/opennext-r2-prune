# opennext-r2-prune

清理 `@opennextjs/cloudflare` 部署在 Cloudflare R2 上的过期增量缓存。

每次发布，OpenNext 都会以新的 `BUILD_ID` 为名在 R2 里建一个缓存目录，且从不清理旧的。
本工具找出已经没人用的 build 目录 —— 不是最近几次上线的、也不属于任何预览 —— 把它们交给
R2 删掉。

## 它为什么快

S3/R2 是扁平的 key-value 存储，没有「删除目录」这种操作，所以常规做法（rclone、
aws-cli、各种 S3 清理工具）都得先把目录里的对象一个个列出来再删。缓存对象积累到几十万个
时，光是列举就成了主要开销 —— rclone 更慢，因为它连批量删除接口都不用，是逐个对象发
DELETE。

本工具换了条路：**给每个作废的 build 目录挂一条 R2 object lifecycle 规则**，把删除
下沉给 R2 服务端。整个过程一个缓存对象都不列举，目录里有 1 万还是 100 万个文件，代价完全
一样。而且发给 R2 的请求数是**恒定的**：列一次目录、读一次现有规则、写一次新规则、再读回来
核对一次 ——
bucket 里积了 3 个还是 300 个 build，发出去的请求一样多。

这不是「给缓存设个自动过期时间」—— 线上 `BUILD_ID` 能活多久无法预知，那种用法不成立。
这里 lifecycle 纯粹是执行手段：**该删哪些 build 由工具明确判定**，规则只负责替我们把
已经判死刑的目录清掉。

## 一次运行发生了什么

整个过程是一条直线，本地不留任何状态或缓存文件 —— 每次运行都把情况重新看一遍，重新算出
完整的答案。

1. **看 bucket 里现在有哪些 build 目录。** 只问 R2 要「一级目录都有哪些」，通常一个请求就
   返回了。目录里堆了多少缓存文件，这一步完全不关心 —— 这正是它快的原因。

2. **读一遍 bucket 上现有的 lifecycle 规则。** 分成两堆：本工具自己加的（规则 ID 有固定
   前缀），和你自己配的。后者原样收着，最后原样放回去。这一步与上一步同时进行。

3. **问哪些 build 还有人在用。** 通过 Cloudflare API 找出最近几次上线的版本和全部预览，
   逐个读它们的 `/BUILD_ID`（详见下文），并绕开一切中间缓存。任何一个读不到、或读回来的
   东西不像一个 build id（比如是一整页 HTML），就当场退出，不会硬着头皮往下跑。
   这一步放在列目录之后：探测要花些时间，期间新上传或上线的 build 不会出现在先前列出的
   目录里，也就不会被误判作废。

4. **算出这次该干什么。** 保留集之外的现存 build 全部作废，每个配一条删除规则；已经删空的
   目录，把规则回收掉；又活过来的 build（比如回滚），把规则摘掉。这一步不发任何请求，所有
   安全校验都在这里做完 —— 有一条不过就直接退出，根本走不到写入。

5. **把计划打给你看，确认后写回去。** 写入是整份 lifecycle 配置的全量覆盖：你自己的规则
   原样搬回，本工具的规则按上一步的结论重新生成。写完立刻把配置读回来逐条核对，确认每条规则
   的前缀、天数都如实生效（见「安全设计」）。剩下的交给 R2，它通常在 24 小时内删完。

花在 R2 上的通常只有四个请求：列目录、读规则、写规则、回读核对（无需写入时只有前两个）。回读一时对不上会隔几秒重读，最多 3 次；仍不符或读不回来时再多一次撤销写入和一次确认回读。第三步的请求数则随「近期版本数 +
预览数」增长：列 deployments（通常一页就够）、每个近期版本读一次 URL 再读一次 `BUILD_ID`、
列一次预览、每个预览读一次 `BUILD_ID`。读站点、近期版本与预览几条线同时进行，各自内部并发探测。

因为每次都是重算加全量覆盖，这个工具是幂等的：情况没变就什么都不写，连着跑两次，第二次会
直接告诉你「规则已经是最新的，无需改动」。

## 用法

```bash
node dist/cli.js \
  --worker <WORKER_NAME> \
  --api-token <CLOUDFLARE_API_TOKEN> \
  --account-id <CLOUDFLARE_ACCOUNT_ID> \
  --bucket <R2_BUCKET> \
  --access-key-id <R2_ACCESS_KEY_ID> \
  --secret-access-key <R2_SECRET_ACCESS_KEY> \
  --dry-run
```

确认计划无误后去掉 `--dry-run`。交互终端下会让你确认一次；非交互环境（定时任务）必须显式
传 `--yes`。

所有参数都可以用环境变量代替，见 `--help`。

R2 API token 的权限见下文「定时任务」一节末尾：`--dry-run` 需要 Admin Read only，写入需要
Admin Read & Write（Object 级 token 读写不了 lifecycle）。

### 它怎么知道该保留哪些 build

`@opennextjs/cloudflare` 不需要任何配置就把 `.next/BUILD_ID` 作为静态资源暴露在
`/BUILD_ID` 上，而且每个 Worker 版本、每个预览都带着自己那份静态资源。所以最贴近事实的来源
是「找到它的地址，读它的 `/BUILD_ID`」—— 比读本地构建产物可靠，尤其是构建发生在
Cloudflare 云上、跑清理的机器上压根没有 `.next` 目录时。Cloudflare API 本身拿不到
BUILD_ID，它只负责告诉我们该去读哪些地址。

**保留集 = 最近 3 个不同的线上 BUILD_ID ∪ 所有预览当前的 BUILD_ID ∪ `--keep` 显式传入的**，
其余现存 build 全部作废。

- **近期线上**：从最新的 deployment 往回翻，逐个读其中版本的 URL
  （`<版本前缀>-<worker>.<子域>.workers.dev`）上的 `/BUILD_ID`，凑够 3 个**互不相同**的
  BUILD_ID 就停。只改 secret / vars 也会产生新的版本和 deployment，但 BUILD_ID 不变，这类
  不占名额。个数用 `--recent-builds` 调。最新那次 deployment 若处于灰度，里面的两个版本都算
  线上。deployment 按需逐页往回翻，全部翻完仍凑不够时会明确提示，
  更早的 build 需要用 `--keep` 保留。
- **预览**：列出 Worker 的全部 [Previews](https://developers.cloudflare.com/workers/previews/)
  （Workers Builds 给非生产分支跑的 `npx wrangler preview` 创建的就是它），读每个预览 URL
  上的 `/BUILD_ID`。预览 URL 永远指向该预览最新的一次部署。

近期线上或预览的 build 不在 bucket 里是正常的（旧 build 早已删完，或预览绑了别的 bucket），
计划里会单独列出、不报错；最新线上版本或 `--keep` 的不在 bucket 里则照常报错 —— 哪怕同一个
build 同时也是近期版本或预览。

读版本的 `/BUILD_ID` 依赖版本预览 URL，Worker 需开启 workers.dev 与 `preview_urls`。
**实现了 Durable Object 的 Worker（例如用了 OpenNext 的 DO 队列或 DO tag cache）不会生成版本
预览 URL**，`--worker` 对它不可用，请改用下面的 `--url` 加 `--keep`。

API token 需要 **Account › Workers Scripts › Read** 权限。

没有 API token 时，也可以只用 `--url https://your-site.com` 读站点当前的 `/BUILD_ID`，
那样只能保留此刻线上的一个 build，回滚目标和预览的缓存都会被判作废。

任何一个探测失败都会直接退出，绝不会降级成「删除全部」。

### 定时任务

设计上就是给定时任务用的，每周或每月跑一次即可：

```yaml
# .github/workflows/prune-r2-cache.yml
on:
  schedule:
    - cron: "0 3 * * 1" # 每周一 03:00 UTC
jobs:
  prune:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build
      - run: node dist/cli.js --yes
        env:
          WORKER_NAME: your-worker
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

R2 API token 需要 **Admin Read & Write** 权限；Cloudflare API token 需要 **Workers Scripts › Read**。

lifecycle 是 bucket 级配置，R2 的 Object 级 token **不论只读还是读写**，读、写 lifecycle 都会被拒
（403 AccessDenied，已在真实 R2 上实测），只有 Admin 级 token 能用。Admin 级 token 无法限定到单个
bucket，作用于整个账号，请妥善保管、按需设置 TTL。只跑 `--dry-run` 时 **Admin Read only** 就够了，
它不能写入任何东西，适合首次核对计划。

### 作为库调用

同样的流程也可以在其它 JS 代码里以函数形式调用。库入口只用 Web 标准 API（`fetch`、
`AbortSignal`），Node 20+ 与 Cloudflare Worker 里都能跑；它不读环境变量、不碰终端，参数全部显式传入。

本包没有发布到 npm，请从 GitHub 安装，安装时 `prepare` 脚本会构建出 `dist`：

```bash
npm install github:lmk123/opennext-r2-prune
```

pnpm 默认不跑 git 依赖的构建脚本，会报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。这时要按报错里给出的完整写法
（含 commit），把本包加进 `pnpm-workspace.yaml` 的 `allowBuilds`，只写包名不管用。

```ts
import { createHash } from "node:crypto";
import { prune } from "opennext-r2-prune";

const result = await prune({
  bucket: "my-cache",
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  worker: "my-worker",
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  // dryRun: true,
  // 不给 confirm 就直接写入
  confirm: (plan) => plan.expire.length < 50,
  // 可选：带上 Content-MD5（实测 R2 不校验它，Worker 里没有 MD5 可以不传）
  md5Base64: (body) => createHash("md5").update(body, "utf8").digest("base64"),
  // 务必报出来：探测失败而中止时，这是得知这些危险规则的唯一途径
  onWholeBucketRules: (ids) => console.warn("对整个 bucket 生效的规则：", ids),
});
console.log(result.expire, result.written, result.verified);
```

选项与命令行开关一一对应，改成驼峰：`--build-id-url` → `buildIdUrl`、`--recent-builds` →
`recentBuilds`、`--allow-root-prefix` → `allowRootPrefix`、`--dry-run` → `dryRun`，`--url` 对应
`siteUrl`，`--keep` 是字符串数组；另有 `fetch`（替换全部网络请求）与 `onRetry`。参数校验的报错用
上面的选项名；探测与安全校验阶段的报错沿用命令行的开关名（比如「请改用 --keep」），按这张对应表换算。

需要先看计划、再决定写不写时，用两段式的 `planPrune`：

```ts
import { planPrune } from "opennext-r2-prune";

const planned = await planPrune(options); // 只发读请求，全部安全校验在这一步做完
if (planned.changed && (await askSomeone(planned.expire))) {
  const outcome = await planned.apply(); // 写入并回读核对；只能调用一次
}
```

失败一律以异常抛出，不会写到一半悄悄返回：

- 参数不对抛 `PruneOptionsError`，一个请求都不发。
- 探测、列举或安全校验失败抛 `BuildIdProbeError`、`CloudflareApiError`、`S3Error`、`PlanError`、
  `XmlAssumptionError` 之一，此时没有任何写请求。重试耗尽仍连不上 R2 也是 `S3Error`（`status` 为 0）。
- 写入阶段失败抛 `PruneWriteError`：`message` 是带补救办法的完整说明，`written` / `verified` /
  `rolledBack` / `warnings` 与 `--json` 里的同名字段含义相同。**`written` 为 `true` 时（撤销失败，
  或写入阶段意外出错、无从确认）务必按 `message` 立即手动检查 bucket 的 lifecycle 规则。**
- 重复调用同一个 `apply()` 是用法错误，抛普通 `Error`，不发任何请求；要再写入请重新调用 `planPrune`。

返回值里的 `keep` 只含在 bucket 里的 build，不在的另见 `absent`（`--json` 的 `keep` 是两者合并）；
`cloudflare.recentBuilds` 小于期望个数说明 deployment 已经翻完，更早的 build 会被判作废。

## 安全设计

删除不可逆，所以这几条是硬性的：

- 作用域限死在 `<prefix>/<buildId>/` 之下，规则前缀带结尾斜杠（否则某个 buildId 恰是
  另一个的前缀时会误删）。
- 近期线上版本或任何一个预览的 BUILD_ID 探测不到就退出。
- 保留集为空、或保留集与 bucket 里现存的 build 没有交集，都拒绝继续。
- 要保留的 build 不在 bucket 里时报错退出 —— 通常意味着 bucket、`--prefix` 或域名填错了。
  确认无误可用 `--force` 跳过。
- **只碰自己加的规则**。规则 ID 统一为 `opennext-r2-prune:<buildId>`，你在 bucket 上配的
  其它 lifecycle 规则会原样保留。
- 探测每个 `/BUILD_ID` 时都带 `Cache-Control: no-cache`。中间缓存若返回上一个版本的 id，工具就会
  把线上正在服务的 build 判成作废 —— 这是它能造成的最坏后果，所以必须绕开缓存。
- **前缀为空默认拒绝运行**。那意味着把 bucket 根下的每个一级目录都当成 build 缓存，`assets/`、
  `backups/` 这类非缓存目录会一并被挂上删除规则 —— 这是本工具唯一能删到非缓存数据的路径。
  bucket 确实只用来存 OpenNext 缓存时，加 `--allow-root-prefix` 承认这个布局。
- 列出来的 build 目录名不符合 OpenNext 的布局假设（含 XML 转义字符）时中止，不猜、也不
  降级成警告 —— 那些值会被用来拼删除规则。
- **写入后回读核对**。PUT 返回成功不代表规则按原样生效：实测 R2 会静默丢掉裸 `<Prefix>`，把只针对
  一个 build 目录的删除规则变成作用于整个 bucket 的。所以每次写完都把配置读回来，逐条比对本工具
  规则的前缀、过期天数、状态（同一个 buildId 读回多条也算不符），以及外部规则的条数。刚写完可能
  短暂读到旧配置，所以本工具的规则不符时隔 2 秒重读，最多读 3 次（只有外部规则不符时不重读：本工具的
  规则对上了就说明读到的已是新配置）。PUT 本身报错（超时等）时请求也可能已经生效，所以同样回读：
  与期望一致就当作已写入并提示；读回来仍是写入前的配置，说明没写进去，照常报写入失败（旧配置里本就有
  对整个 bucket 生效的本工具规则时则照样撤销）；读回来既不是新配置也不是旧配置（生效了但被服务端改写），
  或者根本读不回来、无从判断，都按下面的流程撤销。PUT 被明确拒绝（4xx，限流的 429 除外）时不会生效，
  只回读一次、不等重读；此时连读都读不回来就直接报写入失败。
  - 本工具的规则仍对不上，或者根本读不回来、无从核对，就**立即撤掉本工具的全部规则**并以退出码 2
    报错 —— 撤规则只会让删除推迟，绝不会删到数据。撤销时写回的是写入前读到的外部规则，而不是回读
    结果：被服务端改掉 ID 的自有规则会被认成外部规则，照搬回读结果就等于把它留下。撤销写完同样要
    读回来确认没有本工具的规则了，才算撤销成功；否则提示你立即手动检查。撤销后读回来外部规则条数
    不符也会提示（可能是你的规则丢了，或被改掉 ID 的自有规则还在）。
  - 只有外部规则条数不符时，本工具的规则是安全的，不撤销，只提示你检查自己的规则。
  - `--json` 输出里的 `verified` / `rolledBack` / `warnings` 字段记录了核对、撤销与提示的结果；
    `written` 表示本次的新规则是否留在了 bucket 上，撤销并确认后为 `false`；撤销失败时为 `true`
    （可能还在），除非能确认写入本身就没生效（PUT 报错、读回来仍是写入前的配置）。
  规则只用 `<Filter><Prefix>` 式样生成。
- **已在生效的整 bucket 规则会被醒目报出**。读到本工具的规则没有 `<Filter><Prefix>`（比如旧版
  `--lifecycle-style bare` 写下的；读回来若带着裸 `<Prefix>`，R2 也不认，同样按整个 bucket 对待，报错里
  会写出它的原值）时，在探测之前就向 stderr 打出警告，所以即便本次因列目录或探测失败中止、或只是 `--dry-run`，你也
  能看到它；`--json` 里的 `wholeBucketRules` 列出这些规则。写入成功时它们会被改写成正确的前缀。
- 一条规则都不剩时要清空配置。S3 规范不允许不含 `<Rule>` 的配置，R2 文档也没把
  DeleteBucketLifecycle 列为已支持，所以先 PUT 空配置，被当作格式错误（400）拒掉再退回
  `DELETE ?lifecycle`（DELETE 也失败时，报错里会一并写明 PUT 被拒的原因），生效与否由回读核对确认。**这两条路径在 R2 上的实际表现尚未实测。**

## 已知限制

- **删除不是即时的**，R2 通常在 24 小时内完成。跑完当场去看 bucket 还是满的，属正常。
- lifecycle 规则上限 1000 条。工具每次运行会自动回收已经删完的规则，正常使用不会触顶。
- Next.js 16.2+ 的 build ID 是确定性的，**回滚到一个已被判定作废的 build 后，应立即手动
  跑一次本工具** —— 它会摘掉那条仍在生效的规则。摘除前 R2 可能已删掉部分缓存，那些页面会
  在下次访问时回源重新渲染。
  摘除的方式是全量重写：S3/R2 没有「删除单条规则」的接口，工具每次都把整份 lifecycle 配置
  重新写回去，那条规则只是不再出现在新配置里（你自己配的规则原样搬回，不受影响）。上面
  「自动回收已经删完的规则」也是同一个机制。所以摘除同样要真正写入 —— 带 `--dry-run` 不会
  生效，非交互环境记得给 `--yes`。
- 读 BUILD_ID 依赖 workers.dev 上的版本 URL 与预览 URL。Worker 关掉了 workers.dev /
  preview URL，或者这些 URL 被 Cloudflare Access 保护着时，探测会失败、工具会中止。
- **已上传但还没部署的版本不受保护**（`opennextjs-cloudflare upload` / `wrangler versions upload`
  之后、`wrangler versions deploy` 之前）。它的缓存已经写进 R2，但不在任何 deployment 或预览里，
  这期间运行会把它判作作废。请避开这个窗口，或用 `--keep` 显式保留。
- 只用 `--url` 模式时只保留线上当前 BUILD_ID，**若恰好在灰度窗口内运行，灰度中旧版本的缓存
  目录会被判定作废**。用 `--worker` 模式即可避免。
- 预览的列举接口官方文档尚未写明分页形态，按 Cloudflare API 通用的 `result_info` 处理；
  要翻多页时会再完整列一遍，两次得到的预览集合一致才采用，防止翻页期间有预览增删导致漏项或
  重复；连续 3 遍都对不上则中止。
  首次使用建议先 `--dry-run`，核对保留列表里的预览与 Dashboard 一致。

## 开发

```bash
pnpm install
pnpm test
pnpm build
```

以下 R2 的具体行为已在真实 bucket 上实测确认（2026-11）：

- **`<Filter><Prefix>` 式样**：R2 照单全收，读回来也原样是 `<Filter><Prefix>`。
- **⚠️ R2 不认裸 `<Prefix>`**（直接挂在 `<Rule>` 下、不包 `<Filter>` 的老式写法）。它不报错，却会
  **静默丢掉前缀**：读回来的规则没有任何 Prefix，`wrangler r2 bucket lifecycle list` 显示为
  `prefix: (all prefixes)`，即这条删除规则对**整个 bucket** 生效，会把线上缓存乃至前缀之外的数据
  一并删掉。因此原先的 `--lifecycle-style bare` 选项已删除，工具只生成 `<Filter><Prefix>`，并在
  写入后回读核对兜底。
- **`Content-MD5` 不被校验**：R2 接受带正确摘要、错误摘要或不带摘要的写入。工具照常发送它（符合
  S3 规范，也兼容会校验的实现），但不要指望它在 R2 上提供完整性保证。
- **新建的 bucket 自带一条 `Default Multipart Abort Rule`**，工具会把它当作外部规则原样保留（已实测）。
  所以「bucket 没有任何规则时 GET 返回 404 / `NoSuchLifecycleConfiguration`」这条路径在 R2 上很难
  走到，未实测；工具对它的处理是当作空配置。
- **权限**：lifecycle 只有 Admin 级 R2 token 能读写，Object 级 token（只读或读写）一律 403，见上文。

写入后可用 `npx wrangler r2 bucket lifecycle list <BUCKET>` 核对规则是否如实写进去了，重点看每条
`opennext-r2-prune:*` 规则的 `prefix` 是否是 `incremental-cache/<buildId>/`，而不是 `(all prefixes)`。
