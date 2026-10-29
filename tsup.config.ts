import { rm } from "node:fs/promises";
import { defineConfig, type Options } from "tsup";

// tsup strips `node:` from every built-in import by default. `node:sqlite` has no other name, so
// `import("node:sqlite")` would become `import("sqlite")` and fail; the prefix stays.
const builds: Options[] = [
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    removeNodeProtocol: false,
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    removeNodeProtocol: false,
  },
  {
    // Build-time tool (`npm run schema`); not part of the CLI or the library API.
    entry: { "scripts/emit-schema": "src/scripts/emit-schema.ts" },
    format: ["esm"],
  },
];

// tsup builds array configs concurrently, so a per-config `clean` could delete the
// other config's output. Clean dist/ once, before either build starts.
export default defineConfig(async () => {
  await rm("dist", { recursive: true, force: true });
  return builds;
});
