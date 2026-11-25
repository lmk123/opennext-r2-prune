import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

// 读 .env（变量见 .env.example），shell 里已设的同名变量优先。git worktree 里没有 .env 时退回主仓库根下的
function findEnvFile(): string | undefined {
  const local = resolve(".env");
  if (existsSync(local)) return local;
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
    const main = resolve(dirname(commonDir.trim()), ".env");
    return existsSync(main) ? main : undefined;
  } catch {
    return undefined;
  }
}
const envFile = findEnvFile();
if (envFile) process.loadEnvFile(envFile);

// 真实 R2 实测：用例共用同一个 bucket 的 lifecycle 配置，必须串行；每步都要等网络，超时放宽
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
