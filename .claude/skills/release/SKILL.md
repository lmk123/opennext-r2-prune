---
name: release
description: 发布 opennext-r2-prune 的新版本到 npm。用户说「发版」「发布新版本」「publish」时使用。
---

# 发版

1. 定版本号：0.x 阶段对库调用方的破坏性变更（导出类型新增联合成员、改选项名等）升 minor，其余升 patch。
2. 在分支上改 `package.json` 的 `version`，同时把 `README.md` 与 `README.zh-CN.md` 里 `npx opennext-r2-prune@x.y` 的示例改成新的 `x.y`（0.x 下 `@0.1` 拿不到 0.2）。
3. 跑 `pnpm typecheck`、`pnpm test`、`pnpm test:e2e`、`npm pack --dry-run`，开 PR，等用户合并。e2e 要本机 `.env` 里的真实凭证，CI 不跑，只能在这一步拦住。
4. 合并后在 main 上 `git pull`，打 `v<version>` tag 并推送：`.github/workflows/publish.yml` 用 npm Trusted Publishing 发布，workflow 只接受 `vX.Y.Z` 形式的正式版本 tag，并先核对 tag 与 `package.json` 版本一致、tag 指向的提交已在 main 上。
5. 用 `gh run watch` 看 publish 跑完，再 `npm view opennext-r2-prune version` 确认。

- 不要在本机 `npm publish`：`npm login` 只给约 2 小时的会话 token，发版靠 CI 的 OIDC。
- workflow 失败要重发时：先 `npm view opennext-r2-prune@<version> version` 看这个版本是否已经发出去。已发出去就不能重发同一版本号，改为升 patch 走新版本；没发出去才删远端和本地的 tag，修好后合并，再重新打同名 tag。
- 预发布版本（`x.y.z-rc.n` 之类）这个 workflow 不发：tag 过滤只认 `vX.Y.Z`，不带 `--tag` 的 `npm publish` 会把版本发到 latest。需要时另加一个用 `npm publish --tag next` 的 workflow。
