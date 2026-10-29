import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, expect, it } from "vitest";

const launcher = resolve("plugins/claude-code/scripts/mcp.mjs");
let home: string;
let env: Record<string, string>;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openteleport launcher "));
  env = { PATH: "", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    OPENTELEPORT_HOME: home, CODEX_HOME: join(home, ".codex"), HERMES_HOME: join(home, ".hermes"),
    OPENCLAW_STATE_DIR: join(home, ".openclaw"), OPENCLAW_CONFIG_PATH: join(home, ".openclaw/openclaw.json"),
    OPENTELEPORT_CLI: resolve("dist/cli.js"),
    OPENTELEPORT_EXTRA_ADAPTER: resolve("test/helpers/memory-adapter.ts"),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it.each(["missing", "relative", "nonexistent", "directory"])("reports %s CLI configuration on stderr without protocol noise", async kind => {
  env.OPENTELEPORT_CLI = kind === "missing" ? "" : kind === "relative" ? "dist/cli.js"
    : kind === "directory" ? home : join(home, "missing.js");
  const result = await execa(process.execPath, [launcher], { cwd: home, env, extendEnv: false, reject: false, timeout: 10_000 });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("OPENTELEPORT_CLI");
  expect(result.stderr).toContain("restart the MCP connection");
  expect(result.stderr).not.toMatch(/MODULE_NOT_FOUND|at file:|node:internal/);
  expect(await readdir(home)).toEqual([]);
});

it("preserves child output and failure status with spaces and shell metacharacters in the CLI path", async () => {
  const cli = join(home, "CLI & local.mjs");
  await writeFile(cli, 'console.log(JSON.stringify(process.argv.slice(2))); console.error("fixture failure"); process.exitCode = 7;');
  env.OPENTELEPORT_CLI = cli;
  const result = await execa(process.execPath, [launcher], { cwd: home, env, extendEnv: false, reject: false, timeout: 10_000 });
  expect(result.exitCode).toBe(7);
  expect(JSON.parse(result.stdout)).toEqual(["mcp"]);
  expect(result.stderr).toBe("fixture failure");
});

it("connects an SDK client through the plugin launcher and releases the connection cleanly", async () => {
  const client = new Client({ name: "plugin-launcher-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [launcher], cwd: home, env, stderr: "pipe" });
  let diagnostics = "";
  transport.stderr?.on("data", chunk => { diagnostics += String(chunk); });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some(tool => tool.name === "openteleport_apply")).toBe(true);
    const result = await client.callTool({ name: "openteleport_list", arguments: { from: "memory" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ agents: [{ id: "ada" }] });
    expect(await readdir(home)).toEqual([]);
    expect(diagnostics).toBe("");
  } finally {
    await client.close();
    await transport.close();
  }
}, 15_000);
