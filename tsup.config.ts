import { defineConfig } from "tsup";

export default defineConfig({
  // cli.ts 的 shebang 写在源码首行，esbuild 只给入口保留它，库入口 index.js 不会带上
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: { entry: "src/index.ts" },
});
