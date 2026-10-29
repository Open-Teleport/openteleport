// A bounded, filesystem-gated destination for actual MCP request-cancellation tests.
import { appendFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Adapter } from "../../src/adapters/types.js";

const adapter: Adapter = {
  name: "slow", displayName: "Controlled test destination",
  capabilities: { persona: true, instructions: true, skills: true, routines: true, facts: true,
    notes: true, files: true, avatar: true, models: true, schedules: ["cron", "every", "at"] },
  detect: async () => ({ found: true }),
  list: async () => [],
  read: async () => { throw new Error("This fixture is destination-only"); },
  write: async (ctx) => {
  await writeFile(join(ctx.home, "apply-entered"), "started");
  const deadline = Date.now() + 45_000;
  while (true) {
    try { await stat(join(ctx.home, "release-apply")); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (Date.now() > deadline) throw new Error("Test release gate timed out");
    await setTimeout(25);
  }
  await appendFile(join(ctx.home, "writes.log"), "one write\n");
  return { outcome: "done", targetAgentId: "copied", items: { approximated: [], skipped: [], warnings: [] } };
  },
};
export default adapter;
