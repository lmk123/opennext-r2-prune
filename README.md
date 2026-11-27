# opennext-r2-prune

English | [简体中文](README.zh-CN.md)

Prune the stale build incremental caches that `@opennextjs/cloudflare` leaves behind in Cloudflare R2.

## Motivation

With the R2 incremental cache enabled, OpenNext stores a fresh copy of the cache under a new build id on every deploy, but never deletes the old ones. Those caches keep piling up in R2 storage and eventually show up on your bill.

I started out deleting them with `rclone`, but it was painfully slow, so I wrote this tool to delete old caches with R2 [Object lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) instead.

## Features

- **Fast, and doesn't slow down as the cache grows**: the tool only reads the build directory names in the bucket and writes lifecycle rules for the directories that are no longer needed; R2 does the actual deletion in the background (usually within 24 hours). So it takes the same time no matter how many files a directory holds.
- **Decides what to keep from the facts**: it reads `/BUILD_ID` directly from the live versions and previews on workers.dev, keeping the 3 most recent live builds and every preview's build by default, without relying on local build output.
- **Aborts rather than over-deletes**: probe failures, finding no builds to keep, an empty prefix and other anomalies all make it exit right away instead of degrading to "delete everything"; builds written less than 24 hours ago aren't deleted either, so a new version in the middle of deploying is never deleted by mistake.
- **Works as a CLI and a library**: the library entry point only uses Web standard APIs, so it also runs in environments like Cloudflare Workers.

## Usage

### Prerequisites

1. **Create an R2 API token**, used to read and write the bucket's lifecycle rules:
   1. Go to the [R2 API Tokens page](https://dash.cloudflare.com/r2/api-tokens).
   2. Click **Create Account API token** (**Create User API token** works too, but it stops working once you're removed from the account).
   3. Under **Permissions**, choose **Admin Read & Write**; if you only want to look at the plan with `--dry-run` first, **Admin Read only** is enough. Don't choose the permissions starting with Object: lifecycle is bucket-level configuration, and Object-level tokens can't read or write it.
   4. After creating it, copy the **Access Key ID** and **Secret Access Key**, which go to `--access-key-id` and `--secret-access-key`. The Secret Access Key is only shown this once.

   An Admin token can't be scoped to a single bucket and applies to the whole account, so keep it safe.
2. **Create a Cloudflare API token**, used to look up the Worker's live versions and previews (not needed if you only use `--url`):
   1. Open [API Tokens](https://dash.cloudflare.com/profile/api-tokens) (avatar in the top right › **My Profile** › **API Tokens**) and click **Create Token**.
   2. Choose **Start from scratch** › **Start with an Account policy**.
   3. Under **Policies**, search for `Workers Scripts` and check its **Read** permission.
   4. Click **Continue to summary**, then **Create Token**, and copy the generated token, which goes to `--api-token`. The token is only shown this once.
3. **Note down your Account ID**: it's in **Account Details** on the [R2 Object Storage page](https://dash.cloudflare.com/r2/overview), and goes to `--account-id`.
4. **Make sure the Worker has the workers.dev domain and `preview_urls` enabled**; the tool reads `/BUILD_ID` from those URLs. **A Worker that implements Durable Objects doesn't get version preview URLs**; in that case use `--url` together with `--keep` instead.

### Command line

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

Once the printed plan looks right, drop `--dry-run` and run it again. In an interactive terminal you're asked to confirm once; in a non-interactive environment (such as a scheduled job) pass `--yes` explicitly. Every option can be supplied via an environment variable instead; see `--help` for the full list.

Common options:

| Option | Description |
| --- | --- |
| `--prefix` | Cache prefix, default `incremental-cache`; must match OpenNext's `NEXT_INC_CACHE_R2_PREFIX` |
| `--recent-builds` | How many distinct recent live builds to keep, default 3 |
| `--keep` | Extra build id to keep; can be repeated |
| `--grace-hours` | Builds written fewer than this many hours ago aren't deleted, default 24 |
| `--url` | Without a Cloudflare API token, read the site's current `/BUILD_ID` instead (only keeps the one build that's live right now) |

### Scheduled runs

Running it weekly or monthly is enough:

```yaml
# .github/workflows/prune-r2-cache.yml
on:
  schedule:
    - cron: "0 3 * * 1" # every Monday at 03:00 UTC
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

### Using as a library

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
  // without confirm, it writes straight away
  confirm: (plan) => plan.expire.length < 50,
  // be sure to report these: when the run aborts on a failed probe, this is the only way to learn about these dangerous rules
  onWholeBucketRules: (ids) => console.warn("Rules applying to the whole bucket:", ids),
});
```

Options map one-to-one to the command-line flags in camelCase (`--recent-builds` → `recentBuilds`), and `--url` maps to `siteUrl`. To look at the plan before deciding whether to write, use the two-phase `planPrune(options)` and call the `apply()` it returns once you've confirmed. Every failure is thrown as a typed exception (`PlanError`, `S3Error`, `PruneWriteError`, etc.); when a `PruneWriteError` has `written` set to `true`, follow its message and check the bucket's lifecycle rules right away.

### Several sites sharing one bucket

Give each site a different cache prefix, then run once per site, passing `--prefix` together with that site's `--worker` / `--url`. Prefixes must all differ, must not be nested in each other, and must not be empty; run them one after another, not concurrently.

### Caveats

- **Deletion isn't instant**; R2 usually finishes within 24 hours.
- **After rolling back to a build that was judged obsolete, run the tool manually right away** to remove the deletion rule on it. Build ids in Next.js 16.2+ are deterministic, so the same applies when redeploying with the same id: keep it with `--keep` before deploying.
- **A version that's uploaded but not deployed for a long time is only protected by `--grace-hours`**. If you plan to deploy much later, raise it, or keep the build with `--keep`.
- With `--url` alone, only the one build that's live right now is kept; rollback targets, previews and the older version in a gradual rollout are all judged obsolete.
- R2 allows at most 1000 lifecycle rules per bucket, and this tool normally uses at most 990 of them. With a large backlog it attaches rules in batches, so it takes a few runs to clear. After changing `--prefix`, rules under the old prefix are no longer managed by the tool and need to be deleted manually.
- Don't manually edit or delete this tool's Object lifecycle rules in the Dashboard (IDs look like `opennext-r2-prune:<prefix>/<buildId>/`); to clean up, just run the tool again. You can view the rules in the bucket's settings in the Dashboard, or with `npx wrangler r2 bucket lifecycle list <bucket>`.

## How it works

S3/R2 has no "delete directory" operation, so the usual approach lists the objects in a directory one by one and deletes them, which gets very slow once the cache grows to hundreds of thousands of objects. This tool hands deletion over to R2 lifecycle rules instead. Each run:

1. **Lists the existing build directories in the bucket**: only top-level directories, usually a single request.
2. **Finds the builds still in use**: using the Cloudflare API it finds the recent live versions and all previews, and reads their `/BUILD_ID` (bypassing caches). It keeps the 3 most recent distinct live builds, every preview's build, and the builds given with `--keep`.
3. **Judges the remaining builds obsolete**, except those written less than `--grace-hours` (default 24 hours) ago.
4. **Rewrites the bucket's whole lifecycle configuration**: attaches a deletion rule to each obsolete build's directory, reclaims rules whose directories are already empty, removes rules from builds that need to be kept again, and keeps your own rules as they are. Right after writing it reads the configuration back to verify, and removes this tool's rules if anything doesn't match.

R2 then deletes in the background. The whole process never walks the cached objects, and the number of requests sent to R2 stays nearly constant.

## License

[MIT](LICENSE)
