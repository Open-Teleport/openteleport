import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestJsonSchema } from "../core/schema.js";

// Runs as dist/scripts/emit-schema.js, so the package root is two levels up.
const target = fileURLToPath(new URL("../../schema/jetpack.schema.json", import.meta.url));

await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`);
console.log(`Wrote ${target}`);
