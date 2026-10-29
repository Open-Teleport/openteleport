// Explicit release maintenance. Never chooses a release version or publishes a package.
import { readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.slice(2);
if (mode.length !== 1 || !["--check", "--write"].includes(mode[0])) {
  throw new Error("Use --check to verify or --write to synchronize with package.json.");
}
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) {
  throw new Error("package.json must contain an explicit release version.");
}
const changes = [];
async function jsonFile(path, update) {
  const value = JSON.parse(await readFile(join(root, path), "utf8"));
  const before = JSON.stringify(value);
  update(value);
  if (JSON.stringify(value) !== before) changes.push({ path, text: JSON.stringify(value, null, 2) + "\n" });
}
async function exists(path) {
  try { await stat(join(root, path)); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
await jsonFile("package-lock.json", lock => { lock.version = version; lock.packages[""].version = version; });
await jsonFile("plugins/claude-code/.claude-plugin/plugin.json", plugin => { plugin.version = version; });
await jsonFile(".claude-plugin/marketplace.json", marketplace => {
  const plugin = marketplace.plugins.find(item => item.name === pkg.name);
  if (!plugin) throw new Error("OpenTeleport marketplace entry is missing.");
  plugin.version = version;
});
// The v0.3 branch does not contain native plugins; v0.4 and later synchronize them as well.
if (await exists("plugins/openclaw/package.json")) {
  await jsonFile("plugins/openclaw/package.json", plugin => { plugin.version = version; });
  await jsonFile("plugins/openclaw/package-lock.json", lock => {
    lock.version = version;
    lock.packages[""].version = version;
    if (lock.packages["../.."]) lock.packages["../.."].version = version;
  });
}
if (await exists("plugins/hermes/plugin.yaml")) {
  const path = "plugins/hermes/plugin.yaml";
  const before = await readFile(join(root, path), "utf8");
  if ((before.match(/^version:[^\r\n]*/gm) ?? []).length !== 1) throw new Error("Hermes must have exactly one version field.");
  const text = before.replace(/^version:[^\r\n]*/m, "version: " + JSON.stringify(version));
  if (text !== before) changes.push({ path, text });
}
if (mode[0] === "--check" && changes.length) {
  console.error("Version metadata differs from package.json (" + version + "):\n" + changes.map(change => "- " + change.path).join("\n"));
  console.error("Run npm run sync:plugin-versions and review the diff before committing the release.");
  process.exitCode = 1;
} else {
  for (const { path, text } of changes) await writeFile(join(root, path), text);
  console.log("Version metadata aligned with " + version + "; " + changes.length + " file(s) changed.");
}
