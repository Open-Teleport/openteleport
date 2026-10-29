import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** The version of this package, from `package.json`. */
export const VERSION: string = pkg.version;
