import { rm } from "node:fs/promises";
import { defineConfig, type Options } from "tsup";

const builds: Options[] = [
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
  },
];

// tsup builds array configs concurrently, so a per-config `clean` could delete the
// other config's output. Clean dist/ once, before either build starts.
export default defineConfig(async () => {
  await rm("dist", { recursive: true, force: true });
  return builds;
});
