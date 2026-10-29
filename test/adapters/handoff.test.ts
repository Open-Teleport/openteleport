import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBuiltinAdapters } from "../../src/adapters/index.js";
import { listAdapters } from "../../src/adapters/registry.js";
import type { Adapter, Ctx, WriteOpts } from "../../src/adapters/types.js";
import type { Bundle } from "../../src/core/schema.js";

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

const OPTS: WriteOpts = { enableRoutines: false, includeFiles: false, onConflict: "update" };
const encoder = new TextEncoder();

/** A small agent that every built-in adapter can hold in some form. */
function sampleBundle(): Bundle {
  return {
    manifest: {
      schemaVersion: "0.1",
      id: "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T",
      name: "Sample",
      title: "A sample agent",
      models: [],
      capabilities: [],
    },
    persona: "Curious and brief.",
    instructions: "Read first, then answer.",
    skills: [
      {
        name: "web-brief",
        files: [
          {
            path: "SKILL.md",
            bytes: encoder.encode("---\nname: web-brief\ndescription: Brief a page.\n---\n\n# Web brief\n"),
          },
        ],
      },
    ],
    routines: [
      {
        name: "Morning digest",
        instruction: "Summarise the news.",
        enabled: false,
        timezone: "UTC",
        schedule: { kind: "cron", expression: "0 8 * * 1-5" },
      },
    ],
    facts: ["Prefers short answers"],
    notes: [],
    files: [],
    unknownPaths: [],
  };
}

let root: string;
let ctx: Ctx;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-handoff-"));
  const targetDir = join(root, "target");
  await mkdir(join(root, "home"));
  await mkdir(join(root, "cwd"));
  await mkdir(targetDir);
  ctx = {
    home: join(root, "home"),
    cwd: join(root, "cwd"),
    targetDir,
    env: {},
    exec: noExec,
    logger: () => {},
  };
  registerBuiltinAdapters();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const handoffAdapters = (): Adapter[] => listAdapters().filter((adapter) => adapter.handoff === true);

describe("adapters that hand off", () => {
  it("are OpenBot, Grok Bot and Letta Code", () => {
    expect(handoffAdapters().map((adapter) => adapter.name)).toEqual([
      "openbot",
      "grok-bot",
      "letta",
    ]);
  });

  it("each end a write in a handoff with the one step left and the file or folder to use", async () => {
    for (const adapter of handoffAdapters()) {
      const result = await adapter.write(ctx, sampleBundle(), OPTS);

      expect(result.outcome, adapter.name).toBe("handoff");
      expect(result.nextStep ?? "", adapter.name).not.toBe("");
      expect(result.artifactPath ?? "", adapter.name).not.toBe("");
      // The artifact is real, and it is below the target folder, not in the working folder.
      const artifact = result.artifactPath as string;
      await stat(artifact);
      expect(artifact.startsWith(ctx.targetDir as string), adapter.name).toBe(true);
    }
  });
});

describe("adapters that create their target", () => {
  it("all hand off, except the folder adapter, which writes the whole agent", () => {
    const creating = listAdapters().filter((adapter) => adapter.createsOnWrite === true);

    expect(creating.map((adapter) => adapter.name).sort()).toEqual(
      ["folder", "grok-bot", "letta", "openbot"].sort(),
    );
    for (const adapter of creating) {
      if (adapter.name === "folder") expect(adapter.handoff, "folder").not.toBe(true);
      else expect(adapter.handoff, adapter.name).toBe(true);
    }
  });
});
