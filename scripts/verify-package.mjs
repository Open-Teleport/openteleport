// Exercise the distributable, not repository imports. Nothing is published or installed globally.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath;
assert(npm, "Run this check with npm run verify:package after npm run build.");
const temporary = await mkdtemp(join(tmpdir(), "openteleport-package-"));
let client;
let transport;
try {
  const packed = await execa(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
    cwd: repository, timeout: 120_000,
  });
  const [archive] = JSON.parse(packed.stdout);
  assert(archive?.filename && archive.files?.length, "npm pack did not produce an archive.");
  assert(!archive.files.some(({ path }) => /^(src|test|node_modules)\//.test(path)), "Package includes development source or dependencies.");
  const install = join(temporary, "installation");
  await mkdir(install);
  await writeFile(join(install, "package.json"), JSON.stringify({ name: "package-smoke", private: true, type: "module" }));
  await execa(process.execPath, [npm, "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", join(temporary, archive.filename)], {
    cwd: install, timeout: 180_000,
  });
  const cli = join(install, "node_modules", "openteleport", "dist", "cli.js");
  const original = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  const version = await execa(process.execPath, [cli, "--version"], { cwd: install, timeout: 10_000 });
  assert.equal(version.stdout.trim(), original.version);
  // Resolve the public library by package name from the fresh installation as a consumer would.
  await execa(process.execPath, ["--input-type=module", "-e",
    'import { VERSION, registerBuiltinAdapters, listAdapters } from "openteleport"; registerBuiltinAdapters(); if (!VERSION || listAdapters().length < 8) process.exit(1);'],
  { cwd: install, timeout: 10_000 });

  const home = join(temporary, "home");
  const source = join(home, "source");
  const destination = join(home, "destination");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "AGENTS.md"), "Synthetic package verification instructions.\n");
  const env = {
    PATH: "", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    OPENTELEPORT_HOME: home, CODEX_HOME: join(home, ".codex"), HERMES_HOME: join(home, ".hermes"),
    OPENCLAW_STATE_DIR: join(home, ".openclaw"), OPENCLAW_CONFIG_PATH: join(home, ".openclaw", "openclaw.json"),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], cwd: home, env, stderr: "pipe" });
  client = new Client({ name: "installed-package-check", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args) => {
    const response = await client.callTool({ name: "openteleport_" + name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent;
  };
  const tools = await client.listTools();
  assert(tools.tools.some(tool => tool.name === "openteleport_apply"));
  const preview = await call("move", { from: "folder", agent: ".", sourceDir: source, to: "folder", targetDir: destination });
  const result = await call("apply", { planId: preview.planId, confirmed: true });
  assert.equal(result.outcome, "done");
  assert.equal(await readFile(join(destination, "AGENTS.md"), "utf8"), await readFile(join(source, "AGENTS.md"), "utf8"));
  const status = await call("operation_status", { operationId: preview.operationId });
  assert.equal(status.state, "completed");
  console.log("Package verification passed: fresh production install, public API, CLI version, MCP transfer and receipt.");
} finally {
  try { await client?.close(); } finally {
    try { await transport?.close(); } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
