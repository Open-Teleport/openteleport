// The wizard asks for source, agent, target, memory and go-ahead, then calls the same `move` or
// `export` the commands run. A fake prompter answers from a queue and records what it was asked;
// `move` and `export` are stand-ins, since what they do is covered by their own tests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AgentRef } from "../../src/adapters/types.js";
import type { Bundle } from "../../src/core/schema.js";
import type { exportCommand } from "../../src/commands/export.js";
import type { moveCommand } from "../../src/commands/move.js";
import { UsageError } from "../../src/commands/shared.js";
import {
  CANCELLED,
  type Choice,
  JETPACK_TARGET,
  type Prompter,
  type WizardDeps,
  clackPrompter,
  runWizard,
} from "../../src/commands/wizard.js";
import { createMemoryAdapter } from "../helpers/memory-adapter.js";

// -- The clack prompts, for `clackPrompter` -------------------------------------------------

const CANCEL = Symbol("clack:cancel");

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  note: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL,
}));
const clack = await import("@clack/prompts");

// -- A prompter that answers from a queue ---------------------------------------------------

/** What the wizard asked, in order. */
type Call =
  | { kind: "select"; message: string; choices: Choice<unknown>[] }
  | { kind: "confirm"; message: string }
  | { kind: "note" | "intro" | "outro"; text: string };

/**
 * `select` answers are the label of the choice to pick, as a user would pick it, or `CANCELLED`;
 * `confirm` answers are a boolean or `CANCELLED`. Picking a disabled choice or asking more than
 * was queued fails the test.
 */
function fakePrompter(answers: (string | boolean | typeof CANCELLED)[]): {
  prompter: Prompter;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...answers];
  const next = (what: string): string | boolean | typeof CANCELLED => {
    if (queue.length === 0) throw new Error(`Asked for more than was queued: ${what}`);
    return queue.shift() as string | boolean | typeof CANCELLED;
  };
  const prompter: Prompter = {
    async select<T>(message: string, choices: Choice<T>[]) {
      calls.push({ kind: "select", message, choices: choices as Choice<unknown>[] });
      const answer = next(message);
      if (answer === CANCELLED) return CANCELLED;
      const picked = choices.find((choice) => choice.label === answer);
      if (picked === undefined) {
        throw new Error(`No choice "${String(answer)}" in: ${choices.map((c) => c.label).join(", ")}`);
      }
      if (picked.disabled === true) throw new Error(`"${picked.label}" is disabled`);
      return picked.value;
    },
    async confirm(message) {
      calls.push({ kind: "confirm", message });
      const answer = next(message);
      if (typeof answer === "string") throw new Error(`Expected a yes or no for: ${message}`);
      return answer;
    },
    note: (text) => void calls.push({ kind: "note", text }),
    intro: (text) => void calls.push({ kind: "intro", text }),
    outro: (text) => void calls.push({ kind: "outro", text }),
  };
  return { prompter, calls };
}

const selects = (calls: Call[]): Extract<Call, { kind: "select" }>[] =>
  calls.filter((call) => call.kind === "select");
const texts = (calls: Call[], kind: "note" | "intro" | "outro"): string[] =>
  calls.flatMap((call) => (call.kind === kind ? [call.text] : []));

// -- Adapters -------------------------------------------------------------------------------

function agent(name: string): Bundle {
  return {
    manifest: { schemaVersion: "0.1", id: "", name, models: [], capabilities: [] },
    persona: "",
    instructions: "Be brief.\n",
    skills: [],
    routines: [],
    facts: [],
    notes: [],
    files: [],
    unknownPaths: [],
  };
}

/** An in-memory adapter called `name` (shown as `In-memory <name>`) holding these agents. */
function app(name: string, agents: Record<string, string> = { ada: "Ada" }, extra: Partial<Adapter> = {}): Adapter {
  const bundles = Object.fromEntries(Object.entries(agents).map(([id, label]) => [id, agent(label)]));
  return { ...createMemoryAdapter({ name, agents: bundles }), ...extra };
}

/** An adapter whose app is not on this machine. */
const missing = (name: string, hint?: string, extra: Partial<Adapter> = {}): Adapter =>
  app(name, {}, {
    detect: async () => ({ found: false, ...(hint === undefined ? {} : { hint }) }),
    ...extra,
  });

type Deps = WizardDeps & {
  move: ReturnType<typeof vi.fn<typeof moveCommand>>;
  exportTo: ReturnType<typeof vi.fn<typeof exportCommand>>;
};

function depsFor(adapters: Adapter[], overrides: Partial<WizardDeps> = {}): Deps {
  return {
    adapters: () => adapters,
    move: vi.fn<typeof moveCommand>(async () => {}),
    exportTo: vi.fn<typeof exportCommand>(async () => {}),
    isTTY: () => true,
    ...overrides,
  } as Deps;
}

const SOURCE_QUESTION = "Where does the agent live now?";
const ALPHA = "In-memory alpha";
const BETA = "In-memory beta";
const JETPACK = "Save as a .jetpack file";
const INCLUDE = "Include facts and notes";
const EXCLUDE = "Leave out facts and notes";
const COPY = "Create a separate copy";
const UPDATE = "Update the previously imported agent";

let alpha: Adapter;
let beta: Adapter;
beforeEach(() => {
  alpha = app("alpha");
  beta = app("beta", {});
});

describe("runWizard", () => {
  describe("the source", () => {
    it("offers every adapter, those not found last and disabled with the reason", async () => {
      const gamma = missing("gamma", "Install Gamma first");
      const { prompter, calls } = fakePrompter([CANCELLED]);
      await runWizard(prompter, {}, depsFor([alpha, gamma, beta]));

      const [first] = selects(calls);
      expect(first?.message).toBe(SOURCE_QUESTION);
      expect(first?.choices.map(({ label, disabled, hint }) => ({ label, disabled, hint }))).toEqual([
        { label: ALPHA, disabled: undefined, hint: undefined },
        { label: BETA, disabled: undefined, hint: undefined },
        { label: "In-memory gamma", disabled: true, hint: "not found: Install Gamma first" },
      ]);
    });

    it("says only 'not found' for an adapter that gave no hint", async () => {
      const { prompter, calls } = fakePrompter([CANCELLED]);
      await runWizard(prompter, {}, depsFor([alpha, missing("gamma")]));
      expect(selects(calls)[0]?.choices[1]).toMatchObject({ disabled: true, hint: "not found" });
    });

    it("treats an adapter whose detect fails as not found, and says why", async () => {
      const broken = app("broken", {}, {
        detect: async () => {
          throw new Error("disk\nfull");
        },
      });
      const { prompter, calls } = fakePrompter([CANCELLED]);
      await runWizard(prompter, {}, depsFor([alpha, broken]));
      expect(selects(calls)[0]?.choices[1]).toMatchObject({
        disabled: true,
        hint: "not found: detect failed: disk full",
      });
    });

    it("detects every adapter, all at once, before the first question", async () => {
      const order: string[] = [];
      const slow = (name: string): Adapter =>
        app(name, { ada: "Ada" }, {
          detect: async () => {
            order.push(`start ${name}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push(`end ${name}`);
            return { found: true };
          },
        });
      const { prompter } = fakePrompter([CANCELLED]);
      await runWizard(prompter, {}, depsFor([slow("one"), slow("two")]));
      expect(order).toEqual(["start one", "start two", "end one", "end two"]);
    });

    it("ends without a question when no adapter is found, naming what each one lacks", async () => {
      const { prompter, calls } = fakePrompter([]);
      const deps = depsFor([missing("one", "Install One"), missing("two")]);
      await expect(runWizard(prompter, {}, deps)).resolves.toBe("cancelled");

      expect(selects(calls)).toEqual([]);
      expect(texts(calls, "note")).toEqual(["In-memory one: Install One\nIn-memory two"]);
      expect(texts(calls, "outro")).toEqual(["No supported app was found, so there is nothing to move."]);
      expect(deps.move).not.toHaveBeenCalled();
    });
  });

  describe("the agent", () => {
    it("asks which one when the source holds several", async () => {
      const two = app("alpha", { ada: "Ada", bob: "Bob" });
      const { prompter, calls } = fakePrompter([ALPHA, CANCELLED]);
      await runWizard(prompter, {}, depsFor([two, beta]));

      const [, which] = selects(calls);
      expect(which?.message).toBe("Which agent?");
      expect(which?.choices.map(({ label, value }) => [label, (value as AgentRef).id])).toEqual([
        ["Ada", "ada"],
        ["Bob", "bob"],
      ]);
    });

    it("takes the one agent without asking, and shows its name", async () => {
      const { prompter, calls } = fakePrompter([ALPHA, CANCELLED]);
      await runWizard(prompter, {}, depsFor([alpha, beta]));

      expect(selects(calls).map(({ message }) => message)).toEqual([SOURCE_QUESTION, "Where should it go?"]);
      expect(texts(calls, "note")).toEqual(["Agent: Ada"]);
    });

    it("ends when the source holds no agent", async () => {
      const empty = app("alpha", {});
      const { prompter, calls } = fakePrompter([ALPHA]);
      const deps = depsFor([empty, beta]);
      await expect(runWizard(prompter, {}, deps)).resolves.toBe("cancelled");

      expect(texts(calls, "outro")).toEqual(["In-memory alpha has no agents."]);
      expect(selects(calls)).toHaveLength(1);
      expect(deps.move).not.toHaveBeenCalled();
    });
  });

  describe("the target", () => {
    it("offers the adapters found, those that create on write, and a .jetpack file", async () => {
      const creates = missing("gamma", "Not here", { createsOnWrite: true });
      const absent = missing("delta", "Not here");
      const { prompter, calls } = fakePrompter([ALPHA, CANCELLED]);
      await runWizard(prompter, {}, depsFor([alpha, beta, creates, absent]));

      const target = selects(calls)[1];
      expect(target?.message).toBe("Where should it go?");
      expect(target?.choices.map(({ label, disabled }) => [label, disabled])).toEqual([
        [ALPHA, undefined],
        [BETA, undefined],
        ["In-memory gamma", undefined],
        [JETPACK, undefined],
      ]);
      expect(target?.choices.at(-1)?.value).toBe(JETPACK_TARGET);
    });
  });

  describe("the summary", () => {
    it("says what will happen, in one go, before asking", async () => {
      const { prompter, calls } = fakePrompter([ALPHA, BETA, INCLUDE, CANCELLED]);
      await runWizard(prompter, {}, depsFor([alpha, beta]));

      expect(texts(calls, "note").at(-1)).toBe(
        "Move Ada from In-memory alpha to In-memory beta. Routines arrive disabled. " +
          "An agent of the same name is updated.",
      );
      expect(calls.filter((call) => call.kind === "confirm")).toEqual([
        { kind: "confirm", message: "Go ahead?" },
      ]);
    });

    it("tells of the extra step when the target hands the agent over", async () => {
      const handoff = {
        ...createMemoryAdapter({ name: "beta", outcome: "handoff" }),
        displayName: "OpenBot",
      };
      const { prompter, calls } = fakePrompter([ALPHA, "OpenBot", INCLUDE, CANCELLED]);
      await runWizard(prompter, {}, depsFor([alpha, handoff]));

      const summary = texts(calls, "note").at(-1);
      expect(summary).toBe(
        "Move Ada from In-memory alpha to OpenBot. Routines arrive disabled. " +
          "OpenBot needs one more step after this, which the report names.",
      );
    });

    it("says where a .jetpack file will go, and not that routines arrive disabled", async () => {
      const { prompter, calls } = fakePrompter([ALPHA, JETPACK, INCLUDE, CANCELLED]);
      await runWizard(prompter, {}, depsFor([alpha, beta]));
      expect(texts(calls, "note").at(-1)).toBe("Save Ada from In-memory alpha as ada.jetpack in this folder. Existing archives are kept.");
    });
  });

  describe("doing it", () => {
    it("moves with the same function the move command runs, by default options", async () => {
      const { prompter, calls } = fakePrompter([ALPHA, BETA, INCLUDE, true]);
      const deps = depsFor([alpha, beta]);
      await expect(runWizard(prompter, {}, deps)).resolves.toBe("done");

      expect(deps.move).toHaveBeenCalledTimes(1);
      expect(deps.move.mock.calls[0]?.[0]).toEqual({ from: "alpha", to: "beta", agent: "ada" });
      expect(deps.exportTo).not.toHaveBeenCalled();
      expect(texts(calls, "intro")).toEqual(["OpenTeleport"]);
      expect(texts(calls, "outro")).toEqual(["Done."]);
    });

    it("passes the options it was given on, and never asks to replace", async () => {
      const { prompter } = fakePrompter([ALPHA, BETA, INCLUDE, true]);
      const deps = depsFor([alpha, beta]);
      await runWizard(prompter, { quiet: true, sourceDir: "/somewhere" }, deps);

      const options = deps.move.mock.calls[0]?.[0];
      expect(options).toMatchObject({ quiet: true, sourceDir: "/somewhere" });
      expect(options).not.toHaveProperty("replace");
      expect(options).not.toHaveProperty("copy");
    });

    it("points at the report for the step that is left after a hand-over", async () => {
      const handoff = createMemoryAdapter({ name: "beta", outcome: "handoff" });
      const { prompter, calls } = fakePrompter([ALPHA, BETA, INCLUDE, true]);
      await runWizard(prompter, {}, depsFor([alpha, handoff]));
      expect(texts(calls, "outro")).toEqual(["Done. The report names the step that is left."]);
    });

    it("exports to <slug>.jetpack when the .jetpack file is picked", async () => {
      const lovelace = app("alpha", { ada: "Ada Lovelace" });
      const { prompter } = fakePrompter([ALPHA, JETPACK, INCLUDE, true]);
      const deps = depsFor([lovelace, beta]);
      await expect(runWizard(prompter, { quiet: true }, deps)).resolves.toBe("done");

      expect(deps.exportTo).toHaveBeenCalledTimes(1);
      expect(deps.exportTo.mock.calls[0]?.[0]).toEqual({
        quiet: true,
        from: "alpha",
        agent: "ada",
        out: "ada-lovelace.jetpack",
        overwrite: false,
      });
      expect(deps.move).not.toHaveBeenCalled();
    });

    it("uses the agent that was picked, not the first one", async () => {
      const builders = app("alpha", { ada: "Ada", bob: "Bob" });
      const { prompter } = fakePrompter([ALPHA, "Bob", BETA, INCLUDE, true]);
      const deps = depsFor([builders, beta]);
      await expect(runWizard(prompter, {}, deps)).resolves.toBe("done");

      expect(deps.move).toHaveBeenCalledTimes(1);
      expect(deps.move.mock.calls[0]?.[0]).toEqual({ from: "alpha", to: "beta", agent: "bob" });
    });

    it("uses the source and the target that were picked, and lists the agents of that source", async () => {
      const zed = app("beta", { zed: "Zed" });
      const gamma = app("gamma", {});
      const listAlpha = vi.spyOn(alpha, "list");
      const listZed = vi.spyOn(zed, "list");
      const { prompter, calls } = fakePrompter([BETA, "In-memory gamma", INCLUDE, true]);
      const deps = depsFor([alpha, zed, gamma]);
      await expect(runWizard(prompter, {}, deps)).resolves.toBe("done");

      expect(listZed).toHaveBeenCalled();
      expect(listAlpha).not.toHaveBeenCalled();
      expect(texts(calls, "note")[0]).toBe("Agent: Zed");
      expect(deps.move.mock.calls[0]?.[0]).toEqual({ from: "beta", to: "gamma", agent: "zed" });
    });

    it("exports the agent that was picked when there are several", async () => {
      const builders = app("alpha", { ada: "Ada", bob: "Bob Builder" });
      const { prompter } = fakePrompter([ALPHA, "Bob Builder", JETPACK, INCLUDE, true]);
      const deps = depsFor([builders, beta]);
      await expect(runWizard(prompter, {}, deps)).resolves.toBe("done");

      expect(deps.exportTo.mock.calls[0]?.[0]).toEqual({
        from: "alpha",
        agent: "bob",
        out: "bob-builder.jetpack",
        overwrite: false,
      });
    });

    it("lets a failure of move through", async () => {
      const { prompter } = fakePrompter([ALPHA, BETA, INCLUDE, true]);
      const deps = depsFor([alpha, beta]);
      deps.move.mockRejectedValue(new Error("Found 1 possible secret"));
      await expect(runWizard(prompter, {}, deps)).rejects.toThrow("Found 1 possible secret");
      expect(deps.exportTo).not.toHaveBeenCalled();
    });

    it("lets a failure of export through", async () => {
      const { prompter } = fakePrompter([ALPHA, JETPACK, INCLUDE, true]);
      const deps = depsFor([alpha, beta]);
      deps.exportTo.mockRejectedValue(new Error("Found 2 possible secrets"));
      await expect(runWizard(prompter, {}, deps)).rejects.toThrow("Found 2 possible secrets");
      expect(deps.move).not.toHaveBeenCalled();
    });
  });

  describe("cancelling", () => {
    const two = (): Adapter => app("alpha", { ada: "Ada", bob: "Bob" });

    // Every question, including the optional destination mode, can be cancelled before writes.
    it.each([
      ["source", [CANCELLED]],
      ["agent", [ALPHA, CANCELLED]],
      ["target", [ALPHA, "Ada", CANCELLED]],
      ["memory", [ALPHA, "Ada", BETA, CANCELLED]],
      ["destination mode", [ALPHA, "Ada", BETA, EXCLUDE, CANCELLED]],
      ["go-ahead", [ALPHA, "Ada", BETA, INCLUDE, CANCELLED]],
      ["go-ahead, answered no", [ALPHA, "Ada", BETA, INCLUDE, false]],
      ["go-ahead for a file, answered no", [ALPHA, "Ada", JETPACK, INCLUDE, false]],
    ] as const)("at the %s question does nothing and says so", async (_question, answers) => {
      const { prompter, calls } = fakePrompter([...answers]);
      const deps = depsFor([two(), beta]);
      await expect(runWizard(prompter, {}, deps)).resolves.toBe("cancelled");

      expect(deps.move).not.toHaveBeenCalled();
      expect(deps.exportTo).not.toHaveBeenCalled();
      expect(texts(calls, "outro")).toEqual(["Cancelled."]);
    });
  });

  describe("memory selection", () => {
    it("exports without memory only after showing the selection and approval", async () => {
      const { prompter, calls } = fakePrompter([ALPHA, JETPACK, EXCLUDE, true]);
      const deps = depsFor([alpha, beta]);
      await runWizard(prompter, {}, deps);
      expect(deps.exportTo).toHaveBeenCalledWith({ from: "alpha", agent: "ada", out: "ada.jetpack", overwrite: false, memory: false });
      expect(texts(calls, "note").join(" ")).toContain("other content may still contain personal information");
      const selection = calls.findIndex(call => call.kind === "note" && call.text.includes("will be left out"));
      expect(selection).toBeGreaterThan(-1);
      expect(selection).toBeLessThan(calls.findIndex(call => call.kind === "confirm"));
    });

    it.each([[COPY, true], [UPDATE, false]] as const)("moves without memory using the selected mode: %s", async (mode, copy) => {
      const { prompter, calls } = fakePrompter([ALPHA, BETA, EXCLUDE, mode, true]);
      const deps = depsFor([alpha, beta]);
      await runWizard(prompter, {}, deps);
      expect(deps.move).toHaveBeenCalledWith({ from: "alpha", to: "beta", agent: "ada", memory: false, copy });
      const notes = texts(calls, "note").join(" ");
      expect(notes).toContain(copy ? "existing agent is kept" : "may remove previously imported destination memory");
    });

    it("does not transfer excluded memory when final approval is declined", async () => {
      const { prompter } = fakePrompter([ALPHA, BETA, EXCLUDE, COPY, false]);
      const deps = depsFor([alpha, beta]);
      expect(await runWizard(prompter, {}, deps)).toBe("cancelled");
      expect(deps.move).not.toHaveBeenCalled();
      expect(deps.exportTo).not.toHaveBeenCalled();
    });
  });

  describe("without a terminal", () => {
    it("refuses with a usage error and asks nothing", async () => {
      const { prompter, calls } = fakePrompter([]);
      const deps = depsFor([alpha, beta], { isTTY: () => false });
      await expect(runWizard(prompter, {}, deps)).rejects.toThrow(UsageError);
      expect(calls).toEqual([]);
    });
  });
});

describe("clackPrompter", () => {
  beforeEach(() => {
    for (const mock of [clack.select, clack.confirm, clack.note, clack.intro, clack.outro]) {
      vi.mocked(mock).mockReset();
    }
  });

  const choices: Choice<string>[] = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta", hint: "second" },
    { value: "c", label: "Gamma", disabled: true, hint: "not found: Install Gamma" },
  ];

  it("gives clack the labels and hints, and returns the value of the pick", async () => {
    vi.mocked(clack.select).mockResolvedValue(1);
    await expect(clackPrompter().select("Pick", choices)).resolves.toBe("b");
    expect(clack.select).toHaveBeenCalledWith({
      message: "Pick",
      options: [
        { value: 0, label: "Alpha" },
        { value: 1, label: "Beta", hint: "second" },
        { value: 2, label: "Gamma", hint: "not found: Install Gamma" },
      ],
    });
  });

  it("shows the hint of a disabled choice that is picked and asks again", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    await expect(clackPrompter().select("Pick", choices)).resolves.toBe("a");
    expect(clack.note).toHaveBeenCalledTimes(1);
    expect(clack.note).toHaveBeenCalledWith("not found: Install Gamma");
    expect(clack.select).toHaveBeenCalledTimes(2);
  });

  it("returns CANCELLED when the user cancels, and for a confirm too", async () => {
    vi.mocked(clack.select).mockResolvedValue(CANCEL);
    await expect(clackPrompter().select("Pick", choices)).resolves.toBe(CANCELLED);
    vi.mocked(clack.confirm).mockResolvedValue(CANCEL);
    await expect(clackPrompter().confirm("Sure?")).resolves.toBe(CANCELLED);
  });

  it("returns the answer of a confirm, yes being the default", async () => {
    vi.mocked(clack.confirm).mockResolvedValue(false);
    await expect(clackPrompter().confirm("Sure?")).resolves.toBe(false);
    expect(clack.confirm).toHaveBeenCalledWith({ message: "Sure?", initialValue: true });
  });

  it("passes intro, note and outro on", () => {
    const prompter = clackPrompter();
    prompter.intro("OpenTeleport");
    prompter.note("Agent: Ada");
    prompter.outro("Done.");
    expect(clack.intro).toHaveBeenCalledWith("OpenTeleport");
    expect(clack.note).toHaveBeenCalledWith("Agent: Ada");
    expect(clack.outro).toHaveBeenCalledWith("Done.");
  });
});
