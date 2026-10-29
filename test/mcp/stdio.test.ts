import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
let home: string;
let client: Client;
let transport: StdioClientTransport;
async function connect(adapterPath = "test/helpers/memory-adapter.ts") {
  client = new Client({ name: "isolated-test", version: "1.0.0" });
  transport = new StdioClientTransport({
    command: process.execPath, args: [resolve("dist/cli.js"), "mcp"], cwd: home,
    env: {
      PATH: "", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      OPENTELEPORT_HOME: home, CODEX_HOME: join(home, ".codex"), HERMES_HOME: join(home, ".hermes"),
      OPENCLAW_STATE_DIR: join(home, ".openclaw"), OPENCLAW_CONFIG_PATH: join(home, ".openclaw/openclaw.json"),
      OPENTELEPORT_EXTRA_ADAPTER: resolve(adapterPath),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    }, stderr: "pipe",
  });
  await client.connect(transport);
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openteleport-mcp-stdio-"));
  await connect();
});
afterEach(async () => {
  await client?.close(); await transport?.close();
  await rm(home, { recursive: true, force: true });
});
const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name: "openteleport_" + name, arguments: args });
it("advertises strict schemas and the write boundary", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "adapters", "apply", "cancel", "export", "import", "inspect", "list", "move", "validate", "operation_status",
  ].map((name) => "openteleport_" + name).sort());
  expect(tools.find((t) => t.name === "openteleport_apply")!.annotations)
    .toMatchObject({ readOnlyHint: false, destructiveHint: true });
  const moving = tools.find((tool) => tool.name === "openteleport_move")!;
  expect(moving.inputSchema.additionalProperties).toBe(false);
  for (const name of ["export", "import", "move"]) {
    expect(tools.find(tool => tool.name === "openteleport_" + name)!.inputSchema.properties)
      .toMatchObject({ includeMemory: { type: "boolean", default: true } });
  }
  expect(JSON.stringify(moving.inputSchema)).not.toContain('"replace"');
  expect(await readdir(home)).toEqual([]);
});
it("previews then transfers through stdio while preserving source and report", async () => {
  expect((await call("list", { from: "memory" })).structuredContent).toMatchObject({ agents: [{ id: "ada" }] });
  const target = join(home, "Imported");
  const preview = await call("move", { from: "memory", agent: "ada", to: "folder", targetDir: target });
  expect(preview.isError).not.toBe(true);
  expect(await readdir(home)).toEqual([]);
  const planId = (preview.structuredContent as { planId: string }).planId;
  const applied = await call("apply", { planId, confirmed: true });
  expect(applied.structuredContent).toMatchObject({ outcome: "done", source: { app: "memory", agent: "ada" } });
  expect(await readFile(join(target, "AGENTS.md"), "utf8")).toContain("five lines");
  expect((await call("list", { from: "memory" })).structuredContent).toMatchObject({ agents: [{ id: "ada" }] });
  expect((await call("apply", { planId, confirmed: true })).isError).toBe(true);
});
it("rejects replace, unknown fields, missing inputs and unconfirmed writes", async () => {
  for (const args of [
    { from: "memory", agent: "ada", to: "folder", onConflict: "replace" },
    { from: "memory", agent: "ada", to: "folder", yes: true }, { from: "memory" },
  ]) expect((await call("move", args)).isError).toBe(true);
  expect((await call("apply", { planId: "00000000-0000-4000-8000-000000000000", confirmed: false })).isError).toBe(true);
  expect(await readdir(home)).toEqual([]);
});
it("round trips an archive and reports secret locations without values", async () => {
  const out = join(home, "Ada.jetpack");
  const preview = await call("export", { from: "memory", agent: "ada", out });
  expect((await call("apply", {
    planId: (preview.structuredContent as { planId: string }).planId, confirmed: true,
  })).structuredContent).toMatchObject({ outcome: "exported", artifactPath: out });
  expect((await call("inspect", { path: out })).structuredContent).toMatchObject({ name: "Ada" });
  expect((await call("validate", { path: out })).structuredContent).toMatchObject({ ok: true });
  const importing = await call("import", { path: out, to: "folder", targetDir: join(home, "copy") });
  expect((await call("apply", {
    planId: (importing.structuredContent as { planId: string }).planId, confirmed: true,
  })).structuredContent).toMatchObject({ outcome: "done" });
  const unsafe = join(home, "unsafe");
  await mkdir(unsafe);
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";
  await writeFile(join(unsafe, "AGENTS.md"), secret);
  const validation = await call("validate", { path: unsafe });
  expect(validation.isError).toBe(true);
  expect(JSON.stringify(validation)).not.toContain(secret);
  const blocked = await call("export", { from: "folder", agent: ".", sourceDir: unsafe, out: join(home, "unsafe.jetpack") });
  expect(blocked.isError).toBe(true);
  expect(JSON.stringify(blocked)).not.toContain(secret);
});
it("keeps serving after an unreadable input", async () => {
  expect((await call("inspect", { path: join(home, "missing") })).isError).toBe(true);
  expect((await call("list", { from: "memory" })).isError).not.toBe(true);
});


it("retrieves completion after restarting the stdio server without replaying the write", async () => {
  const preview = await call("move", { from: "memory", agent: "ada", to: "folder", targetDir: join(home, "Imported") });
  const planId = (preview.structuredContent as { planId: string }).planId;
  const applied = await call("apply", { planId, confirmed: true });
  expect(applied.structuredContent).toMatchObject({ operationId: planId, receiptSaved: true });
  await client.close();
  await transport.close();
  await connect();
  expect((await call("operation_status", { operationId: planId })).structuredContent).toMatchObject({
    state: "completed", execution: "completed", result: { outcome: "done" },
  });
  expect((await call("apply", { planId, confirmed: true })).isError).toBe(true);
  expect((await call("operation_status", { operationId: "../outside" })).isError).toBe(true);
});

it("returns structured recovery information when the destination writer fails", async () => {
  const target = join(home, "existing-file");
  await writeFile(target, "sentinel");
  const preview = await call("move", { from: "memory", agent: "ada", to: "folder", targetDir: target });
  const planId = (preview.structuredContent as { planId: string }).planId;
  const failed = await call("apply", { planId, confirmed: true });
  expect(failed.isError).toBe(true);
  expect(failed.structuredContent).toMatchObject({
    operationId: planId, state: "needs_review", retrySafe: false, receiptSaved: true,
  });
  expect(await readFile(target, "utf8")).toBe("sentinel");
  expect((await call("operation_status", { operationId: planId })).structuredContent)
    .toMatchObject({ state: "needs_review" });
});

it("omits scanner previews and redacts credential-bearing paths in validation and preview failures", async () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz";
  const unsafe = join(home, "credential-path");
  const skill = join(unsafe, "skills", token);
  await mkdir(skill, { recursive: true });
  await writeFile(join(unsafe, "AGENTS.md"), "Synthetic test agent");
  await writeFile(join(skill, "SKILL.md"), "Credential: " + token);
  for (const result of [
    await call("validate", { path: unsafe }),
    await call("export", { from: "folder", agent: ".", sourceDir: unsafe, out: join(home, "blocked.jetpack") }),
  ]) {
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ findings: [
      { path: "skills/[redacted]/SKILL.md", line: 1, kind: "github-token" },
    ] });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("ghp_ab");
    expect(serialized).not.toContain('"preview"');
  }
  expect(await readdir(home)).not.toContain("blocked.jetpack");
});

it("discloses binary exclusions before approving a selected attachment", async () => {
  const source = join(home, "binary-source");
  await mkdir(join(source, "files"), { recursive: true });
  await writeFile(join(source, "AGENTS.md"), "Synthetic instructions");
  await writeFile(join(source, "files", "example.bin"), new Uint8Array([0, 65, 66]));
  const validation = await call("validate", { path: source });
  expect(validation.structuredContent).toMatchObject({ ok: true, scan: { unscanned: { binaryFiles: 1 } } });
  const omitted = await call("export", { from: "folder", agent: ".", sourceDir: source, out: join(home, "excluded.jetpack") });
  expect(omitted.structuredContent).toMatchObject({ secretScan: { unscanned: { binaryFiles: 0 } } });
  const selected = await call("export", { from: "folder", agent: ".", sourceDir: source, out: join(home, "included.jetpack"), includeFiles: true });
  expect(selected.structuredContent).toMatchObject({ secretScan: { unscanned: { binaryFiles: 1 } } });
  expect((selected.structuredContent as { warnings: string[] }).warnings.some(warning => warning.includes("not scanned"))).toBe(true);
  expect(await readdir(home)).not.toContain("included.jetpack");
});

it("retains completion after client cancellation without replaying or claiming a rollback", async () => {
  await client.close(); await transport.close();
  await connect("test/helpers/slow-adapter.ts");
  const source = join(home, "source");
  await mkdir(source);
  await writeFile(join(source, "AGENTS.md"), "Synthetic instructions");
  const plan = await call("move", { from: "folder", agent: ".", sourceDir: source, to: "slow" });
  const { planId, operationId } = plan.structuredContent as { planId: string; operationId: string };
  const controller = new AbortController();
  const applying = client.callTool({ name: "openteleport_apply", arguments: { planId, confirmed: true } },
    { signal: controller.signal }).then(result => ({ result }), error => ({ error }));
  try {
    await vi.waitFor(async () => expect(await readFile(join(home, "apply-entered"), "utf8")).toBe("started"), { timeout: 5000 });
    controller.abort();
    expect(await applying).toHaveProperty("error");
    expect((await call("cancel", { planId })).structuredContent).toMatchObject({ cancelled: false, state: "in_progress" });
    expect((await call("operation_status", { operationId })).structuredContent)
      .toMatchObject({ state: "started", execution: "in_progress" });
    await writeFile(join(home, "release-apply"), "release");
    await vi.waitFor(async () => {
      expect((await call("operation_status", { operationId })).structuredContent)
        .toMatchObject({ state: "completed", result: { outcome: "done" } });
    }, { timeout: 5000 });
    expect((await call("apply", { planId, confirmed: true })).isError).toBe(true);
    expect(await readFile(join(home, "writes.log"), "utf8")).toBe("one write\n");
    expect((await call("cancel", { planId })).structuredContent).toMatchObject({ cancelled: false, state: "not_pending" });
  } finally {
    controller.abort();
    await writeFile(join(home, "release-apply"), "release");
    await applying;
  }
}, 15_000);

it("selects memory through the public export schema without changing the source", async () => {
  const out = join(home, "configuration.jetpack");
  const preview = await call("export", { from: "memory", agent: "ada", out, includeMemory: false });
  expect(preview.isError).not.toBe(true);
  expect(preview.structuredContent).toMatchObject({
    options: { includeMemory: false }, contents: { counts: { facts: 0, notes: 0 } },
    excluded: [{ field: "memory.facts" }],
  });
  const applied = await call("apply", { planId: (preview.structuredContent as { planId: string }).planId, confirmed: true });
  expect(applied.isError).not.toBe(true);
  expect((await call("inspect", { path: out })).structuredContent).toMatchObject({ counts: { facts: 0, notes: 0 } });
  const original = await call("export", { from: "memory", agent: "ada", out: join(home, "with-memory.jetpack") });
  expect(original.structuredContent).toMatchObject({ options: { includeMemory: true }, contents: { counts: { facts: 1 } } });
});
