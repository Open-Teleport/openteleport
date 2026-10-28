// The parts of the commands a spawned CLI cannot reach: prompts need a terminal.
import type { execa } from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { folderAdapter } from "../../src/adapters/folder/index.js";
import type { Adapter, AgentRef, Ctx } from "../../src/adapters/types.js";
import {
  NotDetectedError,
  UsageError,
  confirmReplace,
  conflictMode,
  ensureDetected,
  exitCodeOf,
  fileSlug,
  exitOnBrokenPipe,
  matchAgents,
  resolveAgent,
  sideOf,
} from "../../src/commands/shared.js";
import { createMemoryAdapter } from "../helpers/memory-adapter.js";

const CANCEL = Symbol("clack:cancel");

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL,
}));
const prompts = await import("@clack/prompts");

const exec = (() => {
  throw new Error("no commands here");
}) as unknown as typeof execa;
const ctx: Ctx = { home: "/home", cwd: "/cwd", env: {}, exec, logger: () => {} };

const refs: AgentRef[] = [
  { id: "ada", name: "Ada" },
  { id: "ada-2", name: "Ada" },
  { id: "bob", name: "Robert" },
];

beforeEach(() => {
  vi.mocked(prompts.select).mockReset();
  vi.mocked(prompts.confirm).mockReset();
});

describe("matchAgents", () => {
  it("takes the id first, then the name in any case", () => {
    expect(matchAgents(refs, "ada")).toEqual([refs[0]]);
    expect(matchAgents(refs, "ROBERT")).toEqual([refs[2]]);
    expect(matchAgents(refs, "Bob")).toEqual([]);
  });
});

describe("resolveAgent", () => {
  const adapter = createMemoryAdapter();
  adapter.list = async () => refs;

  it("asks for the agent in a terminal and uses the pick", async () => {
    vi.mocked(prompts.select).mockResolvedValue("bob");
    await expect(resolveAgent(adapter, ctx, undefined, true)).resolves.toEqual(refs[2]);
    expect(vi.mocked(prompts.select).mock.calls[0]?.[0]).toMatchObject({
      options: [
        { value: "ada", label: "Ada", hint: "ada" },
        { value: "ada-2", label: "Ada", hint: "ada-2" },
        { value: "bob", label: "Robert", hint: "bob" },
      ],
    });
  });

  it("stops with exit code 1 when the pick is cancelled", async () => {
    vi.mocked(prompts.select).mockResolvedValue(CANCEL);
    const error = await resolveAgent(adapter, ctx, undefined, true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Cancelled; nothing was written.");
    expect(exitCodeOf(error)).toBe(1);
  });

  it("never asks outside a terminal", async () => {
    await expect(resolveAgent(adapter, ctx, undefined, false)).rejects.toThrow(
      "Missing --agent. Available: ada (Ada), ada-2 (Ada), bob (Robert)",
    );
    expect(prompts.select).not.toHaveBeenCalled();
  });

  it("asks for the id when a name fits several agents", async () => {
    await expect(resolveAgent(adapter, ctx, "ada", false)).resolves.toEqual(refs[0]);
    await expect(resolveAgent(adapter, ctx, "ADA", false)).rejects.toThrow(
      'Several agents in In-memory memory are called "ADA": ada (Ada), ada-2 (Ada). ' +
        "Pass --agent <id>.",
    );
  });
});

describe("--replace", () => {
  const target = createMemoryAdapter();

  it("needs --yes or a terminal, and never goes with --copy", () => {
    expect(conflictMode({})).toBe("update");
    expect(conflictMode({ copy: true })).toBe("copy");
    expect(conflictMode({ replace: true, yes: true })).toBe("replace");
    expect(() => conflictMode({ replace: true })).toThrow(UsageError);
    expect(() => conflictMode({ copy: true, replace: true, yes: true })).toThrow(UsageError);
  });

  it("asks before replacing and stops on a no", async () => {
    vi.mocked(prompts.confirm).mockResolvedValue(true);
    await expect(confirmReplace({}, "Ada", target)).resolves.toBeUndefined();
    expect(vi.mocked(prompts.confirm).mock.calls[0]?.[0]).toMatchObject({
      message: 'Replace existing agent "Ada" in In-memory memory?',
      initialValue: false,
    });

    vi.mocked(prompts.confirm).mockResolvedValue(false);
    await expect(confirmReplace({}, "Ada", target)).rejects.toThrow("Cancelled");
    vi.mocked(prompts.confirm).mockResolvedValue(CANCEL);
    await expect(confirmReplace({}, "Ada", target)).rejects.toThrow("Cancelled");
  });

  it("does not ask with --yes", async () => {
    await confirmReplace({ yes: true }, "Ada", target);
    expect(prompts.confirm).not.toHaveBeenCalled();
  });
});

describe("sideOf", () => {
  it("gives each side of a move only its own folder", () => {
    const both: Ctx = { ...ctx, sourceDir: "/src", targetDir: "/dst" };
    expect(sideOf(both, "source")).toMatchObject({ sourceDir: "/src" });
    expect(sideOf(both, "source")).not.toHaveProperty("targetDir");
    expect(sideOf(both, "target")).toMatchObject({ targetDir: "/dst" });
    expect(sideOf(both, "target")).not.toHaveProperty("sourceDir");
  });
});

describe("ensureDetected", () => {
  /** An adapter whose app is not there; `detect` counts its calls. */
  function missingApp(createsOnWrite?: boolean): { adapter: Adapter; detected: () => number } {
    let calls = 0;
    const adapter: Adapter = {
      ...createMemoryAdapter({ name: "app" }),
      ...(createsOnWrite === undefined ? {} : { createsOnWrite }),
      detect: async () => {
        calls += 1;
        return { found: false, location: "/x", hint: "Pass --source-dir" };
      },
    };
    return { adapter, detected: () => calls };
  }

  it("is exit code 3 for a source that is not there", async () => {
    const error = await ensureDetected(missingApp().adapter, ctx, "source").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NotDetectedError);
    expect(exitCodeOf(error)).toBe(3);
    expect((error as Error).message).toBe("In-memory app was not detected at /x. Pass --source-dir");
  });

  it("is exit code 3 for a target that is not there", async () => {
    const error = await ensureDetected(missingApp().adapter, ctx, "target").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NotDetectedError);
    expect(exitCodeOf(error)).toBe(3);
  });

  it("is exit code 3 for a target that does not create itself, said so or not", async () => {
    await expect(ensureDetected(missingApp(false).adapter, ctx, "target")).rejects.toThrow(
      NotDetectedError,
    );
  });

  it("does not ask a target that is created on write whether it is there", async () => {
    const { adapter, detected } = missingApp(true);

    await expect(ensureDetected(adapter, ctx, "target")).resolves.toBeUndefined();
    expect(detected()).toBe(0);
  });

  it("still asks a source that is created on write", async () => {
    const { adapter, detected } = missingApp(true);

    await expect(ensureDetected(adapter, ctx, "source")).rejects.toThrow(NotDetectedError);
    expect(detected()).toBe(1);
  });

  it("returns when the app is there, whatever the target", async () => {
    const found: Adapter = { ...createMemoryAdapter({ name: "app" }) };

    await expect(ensureDetected(found, ctx, "target")).resolves.toBeUndefined();
    await expect(ensureDetected(found, ctx, "source")).resolves.toBeUndefined();
  });

  it("lets a folder target be created on write", () => {
    expect(folderAdapter.createsOnWrite).toBe(true);
  });

  it("does not go by the name: an adapter called folder that does not create itself is checked", async () => {
    const lookalike: Adapter = { ...missingApp().adapter, name: "folder" };

    await expect(ensureDetected(lookalike, ctx, "target")).rejects.toThrow(NotDetectedError);
  });
});

describe("exitOnBrokenPipe", () => {
  it("ends the program quietly when the reader of the output went away", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      exitOnBrokenPipe(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      exit.mockRestore();
    }
  });

  // `process.exit(0)` would turn a failure that was already recorded into a success.
  it("leaves the exit code to the one already set, asking for no code of its own", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const before = process.exitCode;
    try {
      process.exitCode = 1;
      exitOnBrokenPipe(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      expect(exit).toHaveBeenCalledWith();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
      exit.mockRestore();
    }
  });

  it("throws any other output error on", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const failure = Object.assign(new Error("write ENOSPC"), { code: "ENOSPC" });
      expect(() => exitOnBrokenPipe(failure)).toThrow(failure);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});

describe("fileSlug", () => {
  it.each([
    ["Ada", "ada"],
    ["Ada Lovelace!", "ada-lovelace"],
    ["???", "agent"],
    ["CON", "con-agent"],
  ])("%s → %s", (name, slug) => {
    expect(fileSlug(name)).toBe(slug);
  });
});
