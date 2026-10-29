import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import lettaDefault, { lettaAdapter } from "../../../src/adapters/letta/index.js";
import { lettaCacheIdentity, listLettaAgents, readLettaAgent } from "../../../src/adapters/letta/read.js";
import { writeLettaAgent } from "../../../src/adapters/letta/write.js";
import { registerBuiltinAdapters } from "../../../src/adapters/index.js";
import { getAdapter } from "../../../src/adapters/registry.js";
import type { Ctx } from "../../../src/adapters/types.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/letta/home/.letta", import.meta.url));

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-letta-index-"));
  home = join(root, "home");
  await mkdir(home);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ctxFor(sourceDir?: string, env: NodeJS.ProcessEnv = {}): Ctx {
  return {
    ...(sourceDir === undefined ? {} : { sourceDir }),
    home,
    cwd: root,
    env,
    exec: noExec,
    logger: () => {},
  };
}

describe("letta adapter", () => {
  it("is exported as a named and a default export, built from the three parts", () => {
    expect(lettaDefault).toBe(lettaAdapter);
    expect(lettaAdapter.name).toBe("letta");
    expect(lettaAdapter.displayName).toBe("Letta Code");
    expect(lettaAdapter.list).toBe(listLettaAgents);
    expect(lettaAdapter.read).toBe(readLettaAgent);
    expect(lettaAdapter.cacheIdentity).toBe(lettaCacheIdentity);
    expect(lettaAdapter.write).toBe(writeLettaAgent);
  });

  it("declares what Letta Code can hold, that writing it needs no install and that it hands off", () => {
    expect(lettaAdapter.createsOnWrite).toBe(true);
    expect(lettaAdapter.handoff).toBe(true);
    expect(lettaAdapter.capabilities).toEqual({
      persona: true,
      instructions: true,
      skills: true,
      routines: true,
      facts: true,
      notes: true,
      files: false,
      avatar: false,
      models: true,
      schedules: ["cron", "every", "at"],
    });
  });

  it("is one of the built-in adapters", () => {
    registerBuiltinAdapters();
    expect(getAdapter("letta")).toBe(lettaAdapter);
  });
});

describe("detect", () => {
  it("finds Letta's directory with agents, a local backend and tasks", async () => {
    expect(await lettaAdapter.detect(ctxFor(FIXTURE))).toEqual({ found: true, location: FIXTURE });
  });

  it("finds each of the three places on its own", async () => {
    for (const place of ["agents", "lc-local-backend", "crons.json"]) {
      const dir = join(root, `only-${place}`);
      await mkdir(dir);
      if (place === "crons.json") await writeFile(join(dir, place), "{}");
      else await mkdir(join(dir, place));
      expect((await lettaAdapter.detect(ctxFor(dir))).found).toBe(true);
    }
  });

  it("does not find an empty directory, and says what to do", async () => {
    expect(await lettaAdapter.detect(ctxFor(join(home, ".letta")))).toEqual({
      found: false,
      location: join(home, ".letta"),
      hint: "Install Letta Code (npm i -g @letta-ai/letta-code) or pass --source-dir <~/.letta>",
    });
  });

  it("finds a local backend that LETTA_LOCAL_BACKEND_DIR names", async () => {
    const backend = join(root, "backend");
    await mkdir(backend);
    const result = await lettaAdapter.detect(
      ctxFor(undefined, { LETTA_LOCAL_BACKEND_DIR: backend }),
    );
    expect(result.found).toBe(true);
  });

  it("runs nothing", async () => {
    // `exec` throws if it is called.
    await expect(lettaAdapter.detect(ctxFor(FIXTURE))).resolves.not.toHaveProperty("version");
  });
});
