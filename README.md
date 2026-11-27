# opennext-r2-prune

English | [简体中文](README.zh-CN.md)

Prune stale incremental caches that `@opennextjs/cloudflare` leaves in Cloudflare R2.

On every deploy, OpenNext creates a new cache directory in R2 named after the new `BUILD_ID`, and never
cleans up the old ones. This tool finds the build directories nobody uses anymore — not one of the most
recent releases, and not owned by any preview — and hands them to R2 for deletion.

## Why it's fast

S3/R2 is a flat key-value store with no "delete directory" operation, so the usual approach (rclone,
aws-cli, assorted S3 cleanup tools) has to list every object under a directory and delete them one by
one. Once the cache grows to hundreds of thousands of objects, listing alone dominates the cost — and
rclone is slower still, because it doesn't even use the batch delete API and sends one DELETE per object.

This tool takes a different route: **it attaches an R2 object lifecycle rule to each obsolete build
directory**, pushing the deletion down to R2's servers. It never walks the cached objects, so a directory
with 10,000 files costs exactly the same as one with 1,000,000. The number of requests sent to R2 is
nearly constant too: list the directories once, read the existing rules once, write the new rules once,
read them back once to verify, plus one read of the write time (fetching a single object) for each build
that **newly** gets a rule this run — builds that already have a rule are not looked at again, so a
scheduled run sends about the same number of requests whether 3 or 300 builds are waiting to be deleted.
Only the first time it takes over a bucket that has piled up many builds without rules does it have to
read each of their write times.

This is not "give the cache an automatic expiry" — there's no way to predict how long a live `BUILD_ID`
will stay live, so that approach doesn't work. Lifecycle is purely the enforcement mechanism here:
**the tool decides explicitly which builds to delete**, and the rules just clear out the directories
that have already been sentenced.

## What happens in a run

The whole run is a straight line, and nothing is kept locally — no state, no cache files. Every run
looks at the situation afresh and recomputes the complete answer.

1. **See which build directories are in the bucket right now.** It only asks R2 for "the top-level
   directories", which usually comes back in a single request. How many cache files are inside each
   directory is irrelevant to this step — which is exactly why it's fast.

2. **Read the existing lifecycle rules on the bucket.** They're split into two piles: the ones this tool
   added (rule IDs share a fixed prefix), and the ones you configured yourself. The latter are kept as-is
   and put back unchanged at the end. This step runs concurrently with the previous one.

3. **Ask which builds are still in use.** Using the Cloudflare API it finds the most recent releases and
   all previews, reads each one's `/BUILD_ID` (see below), bypassing every intermediate cache. If any of
   them can't be read, or what comes back doesn't look like a build id (say, a whole HTML page), it exits
   right there instead of pushing on.
   This step comes after listing directories: probing takes a while, and any build uploaded or released
   in the meantime won't be in the directory list taken earlier, so it can't be mistaken for obsolete.

4. **Work out what to do this time.** Every existing build outside the keep set is obsolete and gets a
   deletion rule (see step 6 when there aren't enough slots); for directories already emptied, the rule
   is reclaimed; for builds that came back to life (a rollback, for instance), the rule is removed. This
   step sends no requests, and apart from the write-time reads and slot checks of steps 5 and 6, all
   safety checks happen here — if any one fails, it exits immediately and never reaches the write.

5. **Check whether builds about to get a new rule were just written.** When OpenNext deploys, it first
   writes the new build's cache to R2, then uploads the version and shifts traffic; mid-deploy, the new
   build is already in the bucket but is neither live nor in any deployment. So for each build that's
   about to get a new rule, it fetches one object in the directory to read its write time, and builds
   younger than `--grace-hours` (24 hours by default) are left undecided until the next run. Age is
   computed from the server time in R2's response, so a wrong clock on the machine running the tool
   doesn't matter. If the read fails or the time can't be parsed, it exits; a directory that was emptied
   in the meantime still gets its rule as usual, and the next run will reclaim it.

6. **Count whether there are enough rule slots.** R2 allows at most 1000 lifecycle rules per bucket, a
   limit shared by your own rules and this tool's rules under every prefix. When attaching rules, this
   tool only fills up to 990 in total, leaving 10 spare for your own rules (when your own rules, plus rules
   this tool wrote for other prefixes whose directories are already empty but haven't been reclaimed,
   have already eaten into that margin and reached 990, the margin is given to this tool, which fills up
   to 1000, so that every run can attach at least a few). This step comes after the previous one, so
   freshly written, undecided builds don't take a slot. Builds that already have a rule keep it; when the
   remaining slots aren't enough to give every newly obsolete build its own rule, rules are attached in
   batches: in order of write time, oldest first (with `--grace-hours 0` write times aren't read, so it
   goes by build id), and the rest are listed separately in the plan as deferred (marked `defer`): no rule this time,
   but not kept either. Once R2 finishes deleting the directories that do have rules, later runs reclaim
   those rules, free up the slots, and attach the rest round by round. When there are no slots left at
   all, write times aren't read (and freshly written builds are listed as deferred too), except when the
   slots can never be freed and the run is about to exit.
   When the slots are held by rules this tool wrote for other prefixes whose directories haven't been
   fully deleted yet, it only defers and doesn't exit (once R2 finishes, that prefix's run will reclaim
   them); but it exits when the slots can never be freed: your own rules, plus rules this tool wrote for
   other prefixes whose directories are already empty but haven't been reclaimed (most likely an old
   prefix from before a `--prefix` change, which no run will ever reclaim), already fill all 1000 slots,
   there are newly obsolete builds needing rules, and this run has no other changes to write (when there
   are other changes, they're written as usual, and the plan and the post-write notice explain that the
   slots can never be freed).
   To tell this case apart, when there are no slots left and the other prefixes' rules are numerous enough
   to possibly fill them, it lists the directories under each of those prefixes to check whether the
   directory each rule targets still exists. It checks rule by rule rather than whether the whole prefix
   is empty: an old prefix usually still holds the builds that were kept at the switch, so the prefix
   itself is never empty. With zero slots, every run has to list them once more, but it lists
   directories, not one request per rule. A directory that's empty while its rule remains may also just
   mean the site that still uses it hasn't done its reclaiming run yet; this also exits, and running that
   site once first is enough.

7. **Show you the plan, and write it back after confirmation.** The write fully overwrites the whole
   lifecycle configuration: your own rules are carried back as-is, and this tool's rules are regenerated
   from the previous step's conclusions. Right after writing, it reads the configuration back and checks
   it rule by rule, confirming that each rule's prefix and day count took effect as written (see "Safety
   design"). The rest is up to R2, which usually finishes deleting within 24 hours.

Usually only four requests go to R2, plus one for each build that newly gets a rule this run (deferred
ones because of slots count too, and are read again on the next run; none when there are no slots left
at all, but they're read anyway when the slots can never be freed): list directories, read rules, read
write times, write rules, read back to verify (the last two are skipped when nothing needs writing).
Freshly written builds that are left undecided have no rule, so they're read again on every run during
the grace period; the first time it takes over a bucket that has piled up many builds, each one is read
once. When there are no slots left and the rules this tool wrote for other prefixes are numerous enough
to possibly fill them, each of those prefixes gets one more directory listing (same as listing the
current prefix, usually one request per prefix). If the read-back momentarily doesn't match, it re-reads
after a few seconds, up to 3 times; if it still doesn't match or can't be read, there's one more write to
undo it and one more read-back to confirm. The request count in step 3, on the other hand, grows with
"number of recent versions + number of previews": list deployments (one page is usually enough), for
each recent version read its URL once and then its `BUILD_ID` once, list previews once, and read each
preview's `BUILD_ID` once. Reading the site, recent versions and previews run as parallel lines, each
probing concurrently internally.

Because every run recomputes everything and overwrites the whole configuration, the tool is idempotent:
if nothing changed, nothing is written; run it twice in a row and the second run simply tells you
"Rules are already up to date, no changes needed."

## Usage

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

Once the plan looks right, drop `--dry-run`. In an interactive terminal you're asked to confirm once; in
a non-interactive environment (a scheduled job) you must pass `--yes` explicitly.

Every option can be supplied via an environment variable instead; see `--help`.

For R2 API token permissions, see the end of the "Scheduled runs" section: `--dry-run` needs Admin Read
only, writing needs Admin Read & Write (Object-level tokens can't read or write lifecycle).

### Viewing the written rules

What the tool writes are ordinary Object lifecycle rules on the bucket, visible directly in the Cloudflare
Dashboard, listed alongside the rules you configured yourself:

```
https://dash.cloudflare.com/<account ID>/r2/<jurisdiction>/buckets/<bucket name>/settings#object-lifecycle-rules
```

`<jurisdiction>` is usually `default`; if the bucket was created under a jurisdiction such as EU
(`--endpoint` looks like `https://<account ID>.eu.r2.cloudflarestorage.com`), use the corresponding
value, e.g. `eu`.

Or from the command line (add `--jurisdiction eu` or similar for a non-default jurisdiction):

```bash
npx wrangler r2 bucket lifecycle list <bucket name>
```

This tool's rule IDs (the rule names in the Dashboard) look like `opennext-r2-prune:<prefix>/<buildId>/`,
or `opennext-r2-prune:<buildId>/` when the prefix is empty. **Don't manually edit or delete these rules
under the current prefix in the Dashboard.** To clean up, just run the tool again — it reclaims the ones
that are done and removes the ones that shouldn't delete anything; if the configuration is changed while
a run is in progress, that run aborts before writing.

### How it knows which builds to keep

`@opennextjs/cloudflare` exposes `.next/BUILD_ID` as a static asset at `/BUILD_ID` with no configuration
needed, and every Worker version and every preview carries its own copy of the static assets. So the
source closest to the truth is "find its URL and read its `/BUILD_ID`" — more reliable than reading local
build output, especially when the build happens on Cloudflare's side and the machine running the cleanup
has no `.next` directory at all. The Cloudflare API itself can't give you the BUILD_ID; it only tells us
which URLs to read.

**Keep set = the 3 most recent distinct live BUILD_IDs ∪ every preview's current BUILD_ID ∪ whatever is
passed explicitly with `--keep`.** Of the remaining existing builds, every one whose directory was
written at least `--grace-hours` (default 24) hours ago is obsolete; younger ones are left undecided this
time.

- **Recent live**: walking back from the latest deployment, it reads `/BUILD_ID` on each version's URL
  (`<version prefix>-<worker>.<subdomain>.workers.dev`) one by one, stopping once it has 3 **distinct**
  BUILD_IDs. Changing only secrets / vars also creates a new version and deployment, but the BUILD_ID
  stays the same, so those don't take a slot. Adjust the count with `--recent-builds`. If the latest
  deployment is a gradual rollout, both versions in it count as live. Deployments are paged back through
  as needed; if it still can't collect enough after exhausting them all, it says so clearly, and older
  builds need to be kept with `--keep`.
- **Previews**: it lists all of the Worker's [Previews](https://developers.cloudflare.com/workers/previews/)
  (what `npx wrangler preview` creates when Workers Builds runs it for a non-production branch) and reads
  `/BUILD_ID` on each preview URL. A preview URL always points to that preview's latest deployment.

It's normal for a recent live or preview build not to be in the bucket (the old build was deleted long
ago, or the preview is bound to a different bucket); the plan lists those separately without erroring.
But the latest live version or a `--keep` build missing from the bucket is still an error — even if the
same build is also a recent version or a preview.

Reading a version's `/BUILD_ID` relies on version preview URLs, so the Worker needs workers.dev and
`preview_urls` enabled. **A Worker that implements Durable Objects (e.g. one using OpenNext's DO queue or
DO tag cache) doesn't get version preview URLs**, so `--worker` doesn't work for it; use `--url` with
`--keep` below instead.

The API token needs the **Account › Workers Scripts › Read** permission.

Without an API token, you can also use just `--url https://your-site.com` to read the site's current
`/BUILD_ID`. That keeps only the one build that's live at that moment; caches for rollback targets and
previews will all be judged obsolete.

If any probe fails it exits immediately; it never degrades to "delete everything".

### Scheduled runs

It's designed for scheduled jobs; running it weekly or monthly is enough:

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

The R2 API token needs **Admin Read & Write**; the Cloudflare API token needs **Workers Scripts › Read**.

Lifecycle is bucket-level configuration, and R2's Object-level tokens — **whether read-only or
read-write** — are refused when reading or writing lifecycle (403 AccessDenied, verified on real R2);
only Admin-level tokens work. An Admin-level token can't be scoped to a single bucket and applies to the
whole account, so keep it safe and set a TTL as appropriate. For `--dry-run` only, **Admin Read only** is
enough: it can't write anything, which makes it a good fit for checking the plan the first time.

### Using as a library

The same flow can be called as a function from other JS code. The library entry point only uses Web
standard APIs (`fetch`, `AbortSignal`), so it runs on Node 22.12+ and in Cloudflare Workers; it reads no
environment variables and never touches the terminal — every parameter is passed explicitly.

```bash
npm install opennext-r2-prune
```

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
  // without confirm, it writes straight away
  confirm: (plan) => plan.expire.length < 50,
  // optional: send Content-MD5 (R2 doesn't verify it in practice; skip it in a Worker without MD5)
  md5Base64: (body) => createHash("md5").update(body, "utf8").digest("base64"),
  // be sure to report these: when the run aborts on a failed probe, this is the only way to learn about these dangerous rules
  onWholeBucketRules: (ids) => console.warn("Rules applying to the whole bucket:", ids),
});
console.log(result.expire, result.written, result.verified);
```

Options map one-to-one to the command-line flags, in camelCase: `--build-id-url` → `buildIdUrl`,
`--recent-builds` → `recentBuilds`, `--grace-hours` → `graceHours`, `--allow-root-prefix` →
`allowRootPrefix`, `--dry-run` → `dryRun`; `--url` maps to `siteUrl`, and `--keep` is a string array.
There are also `fetch` (replaces all network requests) and `onRetry`. Parameter validation errors use the
option names above; errors from the probing and safety-check stages keep the command-line flag names
(e.g. "Use --keep … instead") — translate them with this mapping.

To look at the plan before deciding whether to write, use the two-phase `planPrune`:

```ts
import { planPrune } from "opennext-r2-prune";

const planned = await planPrune(options); // only sends reads; probing and safety checks are done here
if (planned.changed && (await askSomeone(planned.expire))) {
  const outcome = await planned.apply(); // writes and verifies by reading back; can only be called once
}
```

A plan only holds at the moment it was computed, so don't leave too long between `planPrune` and
`apply()`. Before writing, `apply()` re-reads the lifecycle configuration and throws `PlanError` without
writing anything if it was changed after the plan was computed (someone edited the rules, another run
wrote). It does **not** re-probe the live builds: if there was a deploy or rollback in the meantime, a
build judged obsolete may be live again, so call `planPrune` again.

Every failure is thrown as an exception; it never stops halfway and quietly returns:

- Invalid options throw `PruneOptionsError`, and not a single request is sent.
- Failures in probing, listing or safety checks (including `apply()` finding the configuration changed
  before writing) throw one of `BuildIdProbeError`, `CloudflareApiError`, `S3Error`, `PlanError`,
  `XmlAssumptionError`, and no write request has been made. Still being unable to reach R2 after retries
  are exhausted is also an `S3Error` (with `status` 0).
- Failures during the write phase throw `PruneWriteError`: `message` is a full explanation including how
  to remedy it, and `written` / `verified` / `rolledBack` / `warnings` mean the same as the fields of the
  same name in `--json`. **When `written` is `true` (the undo failed, or the write phase hit an
  unexpected error and couldn't confirm), follow `message` and check the bucket's lifecycle rules
  manually right away.**
- Calling the same `apply()` twice is a usage error and throws a plain `Error` without sending any
  request; to write again, call `planPrune` again.

The `keep` in the return value only contains builds that are in the bucket; the missing ones are in
`absent` (`keep` in `--json` merges the two). Each entry's `reason` is one of `online` (live), `recent`
(recent live), `preview` (preview), `explicit` (passed via `keep`) or `fresh` (written less than
`graceHours` hours ago and left undecided for now; `source` is the write time; added in 0.2.0, so code
that exhaustively matches `KeepReason` needs to handle it when upgrading); when a build has several
sources, the earliest in that list wins.
`deferred` holds builds outside the keep set that didn't get a rule this time because there weren't
enough rule slots (see step 6 of "What happens in a run"; when there are no slots left at all, freshly
written ones are included too). They are neither in `expire` nor kept.
`quotaExhausted` being `true` means the slots can never be freed, so `deferred` will never get rules no
matter how many runs you wait, and you need to clean up rules manually (it only appears when this run
has other changes to write; with nothing else to write, `PlanError` is thrown directly).
`cloudflare.recentBuilds` being smaller than the expected count means the deployments were exhausted,
and older builds will be judged obsolete.

### Several sites sharing one bucket

Give each site a different cache prefix (OpenNext's `NEXT_INC_CACHE_R2_PREFIX`), then run once per site,
passing `--prefix` together with the matching `--worker` / `--url`; as a library, call `prune` /
`planPrune` once per site.
A rule ID is the marker plus the entire prefix the rule targets (e.g.
`opennext-r2-prune:incremental-cache/<buildId>/`). Each run only claims, rewrites and reclaims rules
under its own prefix; rules for other prefixes are left untouched just like your own rules, and two
sites having the same build id won't collide.

- **Prefixes must all be different.** If two sites share the same prefix, each run's keep set contains
  only its own site's builds, so the other site's live builds are judged obsolete and get deletion rules
  — the tool can't detect this configuration.
- **Prefixes must not be nested in each other, and no site may use an empty prefix.** The top-level
  directories of an outer prefix (e.g. `site-a`) include the segment of an inner prefix
  (`site-a/nested`), so the outer run would treat it as an obsolete build and delete the other site's
  cache along with it; the empty prefix is the outer prefix of every prefix. As soon as the bucket has
  rules this tool wrote for nested prefixes, runs on both sides abort; but if the inner site hasn't
  written a single rule yet, the outer run can't detect it.
- **Run them one after another, not concurrently.** The runs write the same lifecycle configuration; the
  re-read before writing catches most conflicts, but can't stop two runs writing at almost the same time.
- **Rule slots are shared.** When one site has a large backlog of obsolete builds and attaches rules in
  batches, the slots it reclaims each round are given back to its own backlog in the same run, so builds
  that other sites newly judge obsolete in the meantime can only be deferred (no error) until that
  site's backlog is cleared.

## Safety design

Deletion is irreversible, so these rules are hard requirements:

- Scope is locked to `<prefix>/<buildId>/`, and rule prefixes carry a trailing slash (otherwise, when
  one buildId happens to be a prefix of another, the wrong one would be deleted).
- It exits if the BUILD_ID of any recent live version or any preview can't be probed.
- It refuses to continue if the keep set is empty, or if the keep set has no overlap with the builds
  currently in the bucket. Builds left undecided because they were just written don't count toward the
  keep set, so a new build in the middle of deploying can't fake an "overlap" for a wrong prefix or site.
- Builds written less than `--grace-hours` hours ago don't get rules (see step 5 of "What happens in a
  run"). If their write time can't be read, it exits rather than treating them as old builds to delete.
- If a build to keep isn't in the bucket, it errors out — this usually means the bucket, `--prefix` or
  domain is wrong. Once you've confirmed it's correct, `--force` skips this check.
- **It only touches rules it added itself.** Rule IDs are always `opennext-r2-prune:` plus the prefix the
  rule targets, e.g. `opennext-r2-prune:incremental-cache/<buildId>/` (`opennext-r2-prune:<buildId>/`
  when the prefix is empty; still recognized if the server strips the trailing slash). Each run only
  claims rules under the current `--prefix`; other lifecycle rules you configured on the bucket, as well
  as this tool's rules under other prefixes, are left untouched. An ID that carries this tool's marker
  but can't be split into a prefix and buildId aborts the run rather than guessing who it belongs to
  (any of them that apply to the whole bucket are still reported first as usual).
- Every `/BUILD_ID` probe is sent with `Cache-Control: no-cache`. If an intermediate cache returned the
  previous version's id, the tool would judge the build currently serving production as obsolete — the
  worst thing it could do — so caches must be bypassed.
- **An empty prefix is refused by default.** It would mean treating every top-level directory in the
  bucket as a build cache, so non-cache directories like `assets/` or `backups/` would get deletion
  rules too — the only path by which this tool could delete non-cache data. If the bucket really only
  stores one site's OpenNext cache, add `--allow-root-prefix` to acknowledge that layout.
- If a listed build directory name doesn't fit OpenNext's layout assumptions (contains XML escape
  characters), it aborts — no guessing, and no downgrading to a warning — because those values are used
  to build the deletion rules.
- **It re-reads the configuration before writing.** Confirmation may take a long time, so it reads the
  lifecycle once more before writing; if that differs from what was read when computing the plan
  (someone edited the rules, another run wrote), it aborts without writing, so the full overwrite can't
  wipe out someone else's changes.
- **It reads back and verifies after writing.** A successful PUT doesn't mean the rules took effect as
  written: in practice R2 silently drops a bare `<Prefix>`, turning a deletion rule meant for a single
  build directory into one that applies to the whole bucket. So after every write it reads the
  configuration back and compares this tool's rules one by one — prefix, expiration days, status (several
  rules read back for the same buildId also counts as a mismatch) — as well as the count of external
  rules. Right after a write it may briefly read the old configuration, so when this tool's rules don't
  match it re-reads after 2 seconds, up to 3 reads in total (no re-read when only the external rules
  mismatch: if this tool's rules match, what was read is already the new configuration). When the PUT
  itself errors (timeout, etc.) the request may still have taken effect, so it reads back as well: if it
  matches the expectation, it's treated as written with a notice; if it reads back as the pre-write
  configuration, the write didn't land, and it reports a write failure as usual (unless the old
  configuration already had this tool's rules applying to the whole bucket, in which case it still
  undoes); if it reads back as neither the new nor the old configuration (it took effect but was
  rewritten by the server), or can't be read back at all so there's no way to tell, it undoes following
  the procedure below. When the PUT is explicitly rejected (4xx, except 429 rate limiting) it can't have
  taken effect, so it reads back only once without waiting to re-read; if even that read fails, it
  reports a write failure directly.
  - If this tool's rules still don't match, or can't be read back at all to verify, it **immediately
    removes all of this tool's rules** and exits with code 2 — removing rules only postpones deletion and
    can never delete data. The undo writes back the external rules read before the write, not the
    read-back result: a rule of this tool whose ID was changed by the server would be recognized as an
    external rule, and copying the read-back result would keep it. The undo is likewise read back to
    confirm none of this tool's rules remain before it counts as successful; otherwise you're told to
    check manually right away. If the external rule count doesn't match after the undo, you're told as
    well (your rules may have been lost, or a rule of this tool with a changed ID may still be there).
  - If only the external rule count doesn't match, this tool's rules are safe, so it doesn't undo and
    just tells you to check your own rules.
  - The `verified` / `rolledBack` / `warnings` fields in the `--json` output record the results of
    verification, undo and notices; `written` says whether this run's new rules remain on the bucket —
    `false` after a confirmed undo, `true` when the undo failed (they may still be there), unless it can
    be confirmed that the write itself never took effect (the PUT errored and the read-back is still the
    pre-write configuration).
  Rules are only ever generated in the `<Filter><Prefix>` style.
- **Whole-bucket rules already in effect are reported prominently.** When it reads a rule of this tool
  with no `<Filter><Prefix>` (e.g. R2 dropped the prefix; a rule read back with a bare `<Prefix>` isn't
  honored by R2 either, so it's also treated as whole-bucket, and the error shows its original value),
  it prints a warning to stderr before probing, so you see it even if this run aborts on a failed
  directory listing or probe, or is just a `--dry-run`; `wholeBucketRules` in `--json` lists the IDs of
  these rules exactly as they appear on the bucket. Those under other prefixes, or with a malformed ID,
  are reported too (that prefix may be abandoned, and no run would ever report it again), but only those
  under the current prefix get rewritten with the correct prefix when the write succeeds; the others
  have to be deleted manually.
- Rule IDs carry the entire cache prefix, and if an ID computed from the existing directories in the
  bucket exceeds 255 characters (the S3 spec limit), it aborts before probing. The error states how many
  characters the prefix and the directory name each take: if the prefix is too long, switch to a shorter
  one; if the directory name itself is too long, it's most likely not a build cache directory.
- When no rules are left, the configuration has to be cleared. The S3 spec doesn't allow a configuration
  with no `<Rule>`, and R2's documentation doesn't list DeleteBucketLifecycle as supported, so it first
  PUTs an empty configuration, and if that's rejected as malformed (400) falls back to
  `DELETE ?lifecycle` (if DELETE fails too, the error also states why the PUT was rejected); whether it
  took effect is confirmed by the read-back. In practice R2 accepts the empty PUT and reads back a
  configuration with no `<Rule>`; the DELETE fallback path is never reached on R2 and hasn't been tested.

## Known limitations

- **Deletion isn't instant**; R2 usually finishes within 24 hours. It's normal for the bucket to still
  look full right after a run.
- Lifecycle rules are capped at 1000, shared by your own rules and this tool's rules under every prefix.
  Each run automatically reclaims its own prefix's rules whose directories have been fully deleted, so
  normal use won't hit the cap. When the backlog of obsolete builds is too large for the available slots,
  **only some can get rules at a time**: up to 990 in total (up to 1000 when your own rules plus other
  prefixes' rules whose directories are empty but haven't been reclaimed reach 990), oldest writes first,
  with the rest listed as "deferred" for later runs (see step 6 of "What happens in a run"). So clearing
  a backlog takes several runs, and between runs you have to wait for R2 to finish deleting the previous
  batch.
  The 10 spare slots are for you to add your own rules; once they're used up, R2 rejects writes with
  `MalformedXML` without saying the count was exceeded.
  When your own rules, plus rules this tool wrote for old prefixes whose directories are already empty,
  fill the total by themselves and there are newly obsolete builds needing rules, the slots can never be
  freed and the run aborts (exit code 1); you need to clean up rules manually first. If a prefix listed
  in the error is in fact still used by a site, running that site once to reclaim is enough.
- **After changing `--prefix`, rules under the old prefix are no longer managed by the run**, and they
  stay on the bucket taking up slots forever. Once the old directories are deleted, find rules with IDs
  like `opennext-r2-prune:<old prefix>/<buildId>/` (`opennext-r2-prune:<buildId>/` when the old prefix
  was empty) in the Dashboard or with `npx wrangler r2 bucket lifecycle list` (see "Viewing the written
  rules") and delete them manually.
  When the old and new prefixes are nested (e.g. switching to the empty prefix, or from
  `incremental-cache` to `incremental-cache/v2`), runs keep aborting until those rules are deleted.
- Build IDs in Next.js 16.2+ are deterministic, so **after rolling back to a build that was judged
  obsolete, run this tool manually right away** — it removes the rule that's still in effect. Before the
  removal, R2 may already have deleted part of the cache; those pages will be re-rendered from the origin
  on their next visit.
  The removal is a full rewrite: S3/R2 has no "delete a single rule" API, so every time the tool writes
  back the entire lifecycle configuration, and that rule simply no longer appears in the new configuration
  (the rules you configured yourself are carried back as-is, unaffected). "Automatically reclaiming rules
  that are done" above works the same way. So the removal also requires an actual write — it doesn't
  take effect with `--dry-run`, and remember `--yes` in non-interactive environments.
- Reading BUILD_ID depends on version URLs and preview URLs on workers.dev. If the Worker has workers.dev
  / preview URLs turned off, or those URLs are protected by Cloudflare Access, probing fails and the tool
  aborts.
- **A version that's been uploaded but not deployed for a long time is only protected by
  `--grace-hours`** (after `opennextjs-cloudflare upload` / `wrangler versions upload`, before
  `wrangler versions deploy`). Its cache is already written to R2, but it isn't in any deployment or
  preview, so if it still hasn't gone live more than `--grace-hours` hours after being written, it's
  judged obsolete. If you plan to deploy much later, raise `--grace-hours` or keep it explicitly with
  `--keep`.
- The write time is taken from the first object by key in the build directory, and builds that already
  have a rule don't have their write time checked again. So if that object of an old build was just
  rewritten by ISR, the build is merely judged obsolete a little later. But when Next.js 16.2+
  **redeploys an already-obsolete build with the same build ID**, the grace period can't tell it's a new
  deploy: if old objects remain in the directory, the old time is read, and if a rule is already
  attached, it's kept as is — so the new deploy's cache may be deleted before it goes live. When
  redeploying such a build, keep it with `--keep` before deploying, and run this tool manually right
  after it goes live (same as the rollback item above).
- In `--url`-only mode only the current live BUILD_ID is kept, so **if it happens to run during a gradual
  rollout, the cache directory of the older version in the rollout is judged obsolete**. Use `--worker`
  mode to avoid this.
- The official documentation for the preview listing API doesn't yet specify its pagination shape, so
  it's handled with the `result_info` common to the Cloudflare API. When multiple pages are needed, it
  lists everything a second time and only accepts the result if both passes return the same set of
  previews, to avoid missing or duplicated entries when previews are added or removed mid-paging; if 3
  consecutive passes don't agree, it aborts.
  On first use, run with `--dry-run` and check that the previews in the keep list match the Dashboard.

## Development

```bash
pnpm install
pnpm test
pnpm build
```

### Testing against real R2

`pnpm test` only runs against a fake R2; `pnpm test:e2e` (the `e2e/` directory) runs the whole flow on a
real bucket: it sets up build directories and lifecycle configurations, calls the library and the CLI,
then reads the lifecycle back directly, bypassing the code under test, and checks it rule by rule. It
covers attaching rules, idempotency, reclaiming, removal, changing expiration days, multiple prefixes
coexisting, clearing the configuration, safety-check aborts (empty prefix, kept build missing, keep set
not overlapping existing builds, nested prefixes, rules whose owner can't be determined, configuration
changed after planning — all without any write request), reporting and rewriting whole-bucket rules, the
CLI's `--dry-run` / `--yes`, and the R2 behaviors listed below. Run it after changing behavior.

```bash
cp .env.example .env   # fill in the credentials following the comments
pnpm test:e2e
```

- The environment variables it uses are documented in `.env.example`. `pnpm test:e2e` reads `.env`
  automatically, with variables of the same name already set in the shell taking precedence; inside a
  git worktree without a `.env`, it reads the one at the main repository root.
- **Use a dedicated test bucket**: the tests rewrite its entire lifecycle configuration (recorded before
  starting and written back as-is afterwards; if there was no configuration at all, an empty one is
  written back), and clear the objects under `e2e/`. It refuses to run if no hyphen-separated segment of
  the bucket name is `test` (e.g. `opennext-r2-prune-test`; names like `latest` that merely contain
  "test" don't count), to avoid running against production credentials left in `.env` or the shell.
- If `WORKER_NAME` and `CLOUDFLARE_API_TOKEN` are also set, an extra group runs: it probes that Worker's
  current live, recent and preview builds, sets them up in the test bucket, and checks that they're kept
  and the rest are judged obsolete. Only read requests are sent to Cloudflare. It probes once before and
  once after setup; if the two don't match (the Worker released in between), it starts over, up to 3
  times.
- At start it prints the original configuration to stderr and also saves it to `e2e-lifecycle-snapshot.json`
  at the bucket root, deleting that object only after the original configuration has been written back:
  if a run is interrupted before it can write back, restore from either copy manually, then delete the
  object. If that object still exists (another test run is in progress, or the last one was interrupted),
  or the bucket still has rules left over from a previous test run (IDs starting with `e2e-` or
  `opennext-r2-prune:e2e/`), it refuses to run, so leftovers aren't recorded as the original
  configuration and written back afterwards.
- R2 can take up to 24 hours to actually delete objects, so the tests only check rules and don't wait
  for deletion.

The following R2 behaviors have been verified on a real bucket (2026-11), and apart from the
built-in rule on new buckets and the permissions item, they're all re-checked by `pnpm test:e2e`:

- **`<Filter><Prefix>` style**: R2 accepts it as-is, and it reads back exactly as `<Filter><Prefix>`.
- **⚠️ R2 doesn't honor a bare `<Prefix>`** (the legacy form placed directly under `<Rule>` without a
  `<Filter>` wrapper). It doesn't error, but **silently drops the prefix**: the rule reads back with no
  Prefix at all, and `wrangler r2 bucket lifecycle list` shows it as `prefix: (all prefixes)`, meaning
  the deletion rule applies to the **entire bucket** and would delete live caches and even data outside
  the prefix. That's why the former `--lifecycle-style bare` option was removed; the tool only generates
  `<Filter><Prefix>` and verifies by reading back after writing as a safety net.
- **`Content-MD5` isn't verified**: R2 accepts writes with a correct digest, a wrong digest, or none at
  all. The tool still sends it (it's per the S3 spec and works with implementations that do verify), but
  don't count on it for integrity on R2.
- **Newly created buckets come with a `Default Multipart Abort Rule`**, which the tool keeps as-is as an
  external rule (verified). So the path "GET returns 404 / `NoSuchLifecycleConfiguration` when the bucket
  has no rules" is hard to reach on R2 and hasn't been tested; the tool treats it as an empty
  configuration.
- **Rule IDs with a trailing slash** (`opennext-r2-prune:<prefix>/<buildId>/`) are preserved as-is by
  R2; rules read back are sorted by ID and don't keep the write order.
- **Empty configuration**: R2 accepts a lifecycle PUT with no `<Rule>`, after which GET returns 200 and
  an empty configuration rather than 404.
- **Permissions**: lifecycle can only be read and written by Admin-level R2 tokens; Object-level tokens
  (read-only or read-write) always get 403, see above.

After writing, you can check with `npx wrangler r2 bucket lifecycle list <BUCKET>` that the rules were
written faithfully; the key thing is whether each `opennext-r2-prune:incremental-cache/<buildId>/`
rule's `prefix` matches the path in its ID, rather than `(all prefixes)`.
