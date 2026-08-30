# opennext-r2-prune

清理 `@opennextjs/cloudflare` 部署在 Cloudflare R2 上的过期增量缓存。

每次发布，OpenNext 都会以新的 `BUILD_ID` 为名在 R2 里建一个缓存目录，且从不清理旧的。
本工具找出线上已经不再使用的 build 目录，把它们交给 R2 删掉。

## 它为什么快

S3/R2 是扁平的 key-value 存储，没有「删除目录」这种操作，所以常规做法（rclone、
aws-cli、各种 S3 清理工具）都得先把目录里的对象一个个列出来再删。缓存对象积累到几十万个
时，光是列举就成了主要开销 —— rclone 更慢，因为它连批量删除接口都不用，是逐个对象发
DELETE。

本工具换了条路：**给每个作废的 build 目录挂一条 R2 object lifecycle 规则**，把删除
下沉给 R2 服务端。整个过程一个缓存对象都不列举，目录里有 1 万还是 100 万个文件，代价完全
一样。请求数只跟 build 目录的**数量**有关（列举一次，外加每个目录一次时间探测，那次探测
纯粹是为了在计划里显示部署时间，失败也不影响清理），与目录里堆了多少文件无关。

这不是「给缓存设个自动过期时间」—— 线上 `BUILD_ID` 能活多久无法预知，那种用法不成立。
这里 lifecycle 纯粹是执行手段：**该删哪些 build 由工具明确判定**，规则只负责替我们把
已经判死刑的目录清掉。

## 用法

```bash
node dist/cli.js \
  --url https://your-site.com \
  --account-id <CLOUDFLARE_ACCOUNT_ID> \
  --bucket <R2_BUCKET> \
  --access-key-id <R2_ACCESS_KEY_ID> \
  --secret-access-key <R2_SECRET_ACCESS_KEY> \
  --dry-run
```

确认计划无误后去掉 `--dry-run`。交互终端下会让你确认一次；非交互环境（定时任务）必须显式
传 `--yes`。

所有参数都可以用环境变量代替，见 `--help`。

### 它怎么知道该保留哪个 build

读 `https://<你的域名>/BUILD_ID`。`@opennextjs/cloudflare` 不需要任何配置就把
`.next/BUILD_ID` 作为静态资源暴露在这个路径上，所以这是最贴近事实的来源 —— 比读本地构建
产物可靠，尤其是构建发生在 Cloudflare 云上、跑清理的机器上压根没有 `.next` 目录时。

**保留集 = 线上探测到的 BUILD_ID ∪ `--keep` 显式传入的**，其余现存 build 全部作废。

探测失败会直接退出，绝不会降级成「删除全部」。

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
          SITE_URL: https://your-site.com
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

R2 API token 需要 **Object Read & Write** 权限（lifecycle 是 bucket 级配置）。

## 安全设计

删除不可逆，所以这几条是硬性的：

- 作用域限死在 `<prefix>/<buildId>/` 之下，规则前缀带结尾斜杠（否则某个 buildId 恰是
  另一个的前缀时会误删）。
- 探测不到线上 BUILD_ID 就退出。
- 保留集为空、或保留集与 bucket 里现存的 build 没有交集，都拒绝继续。
- 要保留的 build 不在 bucket 里时报错退出 —— 通常意味着 bucket、`--prefix` 或域名填错了。
  确认无误可用 `--force` 跳过。
- **只碰自己加的规则**。规则 ID 统一为 `opennext-r2-prune:<buildId>`，你在 bucket 上配的
  其它 lifecycle 规则会原样保留。
- 探测 `/BUILD_ID` 时带 `Cache-Control: no-cache`。中间缓存若返回上一个版本的 id，工具就会
  把线上正在服务的 build 判成作废 —— 这是它能造成的最坏后果，所以必须绕开缓存。
- **前缀为空默认拒绝运行**。那意味着把 bucket 根下的每个一级目录都当成 build 缓存，`assets/`、
  `backups/` 这类非缓存目录会一并被挂上删除规则 —— 这是本工具唯一能删到非缓存数据的路径。
  bucket 确实只用来存 OpenNext 缓存时，加 `--allow-root-prefix` 承认这个布局。
- bucket 里某个目录的对象名不符合 OpenNext 的布局假设（含 XML 转义字符）时中止，不猜、也不
  降级成警告 —— 那些值会被用来拼删除规则。

## 已知限制

- **删除不是即时的**，R2 通常在 24 小时内完成。跑完当场去看 bucket 还是满的，属正常。
- lifecycle 规则上限 1000 条。工具每次运行会自动回收已经删完的规则，正常使用不会触顶。
- Next.js 16.2+ 的 build ID 是确定性的，**回滚到一个已被判定作废的 build 后，应立即手动
  跑一次本工具** —— 它会摘掉那条仍在生效的规则。摘除前 R2 可能已删掉部分缓存，那些页面会
  在下次访问时回源重新渲染。
- 只保留线上当前 BUILD_ID，所以**若恰好在 Rolling Releases 灰度窗口内运行，灰度中旧版本的
  缓存目录会被判定作废**。后果是那部分页面回源重新渲染并重新填充缓存，不影响正确性。要避开
  就用 `--keep <旧ID>` 显式保留，或等灰度完成再跑。

## 开发

```bash
pnpm install
pnpm test
pnpm build
```

首次对真实 bucket 使用时，有两处依赖 R2 的具体行为，如果报错就调整对应开关：

- 规则里 `Prefix` 的包装形式默认用 S3 v2 的 `<Filter><Prefix>`。R2 若不认，改用
  `--lifecycle-style bare`。注意 S3 的 GET 会把裸 `<Prefix>` 规范化成 `<Filter><Prefix>` 再
  返回，所以「已有规则读回来是 filter」不作为改写理由（否则 `bare` 会每次运行都重写一遍规则，
  永远收敛不了）；切到 `bare` 后，规则会在下一次真正需要写入时一并换成新式样。
- 写入时默认带 `Content-MD5`。可用 `npx wrangler r2 bucket lifecycle list <BUCKET>`
  核对规则是否如实写进去了。
