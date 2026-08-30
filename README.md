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
一样。而且请求数是**恒定的**：列一次目录、读一次现有规则、写一次新规则 —— bucket 里积了
3 个还是 300 个 build，发出去的请求一样多。

这不是「给缓存设个自动过期时间」—— 线上 `BUILD_ID` 能活多久无法预知，那种用法不成立。
这里 lifecycle 纯粹是执行手段：**该删哪些 build 由工具明确判定**，规则只负责替我们把
已经判死刑的目录清掉。

## 一次运行发生了什么

整个过程是一条直线，本地不留任何状态或缓存文件 —— 每次运行都把情况重新看一遍，重新算出
完整的答案。

1. **问线上现在用的是哪个 build。** 读 `https://<你的域名>/BUILD_ID`，并绕开一切中间缓存。
   读不到、或读回来的东西不像一个 build id（比如是一整页 HTML），就当场退出，不会硬着头皮
   往下跑。

2. **看 bucket 里现在有哪些 build 目录。** 只问 R2 要「一级目录都有哪些」，通常一个请求就
   返回了。目录里堆了多少缓存文件，这一步完全不关心 —— 这正是它快的原因。

3. **读一遍 bucket 上现有的 lifecycle 规则。** 分成两堆：本工具自己加的（规则 ID 有固定
   前缀），和你自己配的。后者原样收着，最后原样放回去。

4. **算出这次该干什么。** 保留集之外的现存 build 全部作废，每个配一条删除规则；已经删空的
   目录，把规则回收掉；又活过来的 build（比如回滚），把规则摘掉。这一步不发任何请求，所有
   安全校验都在这里做完 —— 有一条不过就直接退出，根本走不到写入。

5. **把计划打给你看，确认后写回去。** 写入是整份 lifecycle 配置的全量覆盖：你自己的规则
   原样搬回，本工具的规则按上一步的结论重新生成。剩下的交给 R2，它通常在 24 小时内删完。

数一下就知道整趟只有四个请求：读线上 `BUILD_ID`、列目录、读规则、写规则。第一个还是打给你
自己的站点，真正花在 R2 上的只有三个。

因为每次都是重算加全量覆盖，这个工具是幂等的：情况没变就什么都不写，连着跑两次，第二次会
直接告诉你「规则已经是最新的，无需改动」。

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
- 列出来的 build 目录名不符合 OpenNext 的布局假设（含 XML 转义字符）时中止，不猜、也不
  降级成警告 —— 那些值会被用来拼删除规则。

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
