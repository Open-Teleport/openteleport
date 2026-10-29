import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readReceipt, writeReceipt, type Receipt } from "../../src/mcp/receipts.js";
let home: string;
const receipt = (): Receipt => ({
  schemaVersion: 1, operationId: randomUUID(), operation: "move", state: "started",
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  source: { app: "folder", agent: "reviewer" }, destination: { app: "folder", path: null, cwd: "/sandbox" },
});
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "openteleport-receipts-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
it("creates exclusively and replaces only its own existing receipt", async () => {
  const initial = receipt();
  const path = await writeReceipt(home, initial, true);
  await expect(writeReceipt(home, initial, true)).rejects.toThrow();
  const completed: Receipt = { ...initial, state: "completed", result: { outcome: "done" } };
  await writeReceipt(home, completed);
  expect(await readReceipt(home, initial.operationId)).toEqual(completed);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(completed);
});
it("rejects traversal, oversized files, and mismatched receipt IDs", async () => {
  await expect(readReceipt(home, "../other")).rejects.toThrow();
  const initial = receipt();
  const path = await writeReceipt(home, initial, true);
  await writeFile(path, "x".repeat(65537));
  await expect(readReceipt(home, initial.operationId)).rejects.toThrow("size");
  await writeFile(path, JSON.stringify({ ...initial, operationId: randomUUID() }));
  await expect(readReceipt(home, initial.operationId)).rejects.toThrow("identity");
});
it("rejects unrecognized data and leaves a non-file destination alone", async () => {
  const initial = receipt();
  await expect(writeReceipt(home, { ...initial, content: "private" } as Receipt, true)).rejects.toThrow();
  const path = await writeReceipt(home, initial, true);
  await rm(path);
  await mkdir(path);
  await expect(writeReceipt(home, { ...initial, state: "needs_review" })).rejects.toThrow("file");
  await expect(readReceipt(home, initial.operationId)).rejects.toThrow("file");
});
