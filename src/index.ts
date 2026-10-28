import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const VERSION: string = pkg.version;

export { readBundle, writeBundle } from "./core/bundle.js";
export { SecretsFoundError, exportBundle, importBundle, move } from "./core/engine.js";
export { scanSecrets } from "./core/secrets.js";
export { parseManifest } from "./core/schema.js";
export {
  UnknownAdapterError,
  getAdapter,
  listAdapters,
  registerAdapter,
} from "./adapters/registry.js";
export { registerBuiltinAdapters } from "./adapters/index.js";

export type {
  Adapter,
  AdapterCapabilities,
  AgentRef,
  Ctx,
  WriteOpts,
  WriteResult,
} from "./adapters/types.js";
export type { Bundle, Manifest } from "./core/schema.js";
export type { Item, MoveReport } from "./core/report.js";
export type { SecretFinding } from "./core/secrets.js";
