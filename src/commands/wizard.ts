// The run with no arguments: a few questions (where the agent is, which one, where it goes, a
// go-ahead), then the very function the matching command runs, so the report and the exit code
// are the same as when the command is typed. The wizard has no logic of its own beyond choosing.
import * as clack from "@clack/prompts";
import { listAdapters } from "../adapters/registry.js";
import type { Adapter, AgentRef, Ctx } from "../adapters/types.js";
import { oneLine } from "../core/text.js";
import { exportCommand } from "./export.js";
import { moveCommand } from "./move.js";
import {
  type CommonOptions,
  UsageError,
  NotDetectedError,
  buildCtx,
  fileSlug,
  hasTerminal,
  messageOf,
  sideOf,
} from "./shared.js";

// -- Asking ---------------------------------------------------------------------------------

/** What `Prompter.select` and `Prompter.confirm` give back when the user cancels. */
export const CANCELLED: unique symbol = Symbol("cancelled");

/** One line of a `select`. A `disabled` one is shown but cannot be picked; `hint` says why. */
export type Choice<T> = { value: T; label: string; hint?: string; disabled?: boolean };

/** Everything the wizard says or asks, so that a test can answer in the user's place. */
export type Prompter = {
  select<T>(message: string, choices: Choice<T>[]): Promise<T | typeof CANCELLED>;
  confirm(message: string): Promise<boolean | typeof CANCELLED>;
  note(text: string): void;
  intro(text: string): void;
  outro(text: string): void;
};

/**
 * The prompts of `@clack/prompts`. Its `select` has no disabled state, so a disabled choice is
 * listed with its hint and, when picked, the hint is shown again and the question is repeated.
 */
export function clackPrompter(): Prompter {
  return {
    async select<T>(message: string, choices: Choice<T>[]): Promise<T | typeof CANCELLED> {
      // clack is given the position of a choice: any `T`, an object included, can be a value.
      const options = choices.map(({ label, hint }, position) => ({
        value: position,
        label,
        ...(hint === undefined ? {} : { hint }),
      }));
      for (;;) {
        const picked = await clack.select({ message, options });
        if (clack.isCancel(picked)) return CANCELLED;
        const choice = choices[picked];
        if (choice === undefined) return CANCELLED;
        if (choice.disabled !== true) return choice.value;
        clack.note(choice.hint ?? `${choice.label} is not available`);
      }
    },
    async confirm(message) {
      const answer = await clack.confirm({ message, initialValue: true });
      return clack.isCancel(answer) ? CANCELLED : answer;
    },
    note: (text) => clack.note(text),
    intro: (text) => clack.intro(text),
    outro: (text) => clack.outro(text),
  };
}

// -- The wizard -----------------------------------------------------------------------------

/** The target that is no app: the agent is saved as a `.jetpack` file instead. */
export const JETPACK_TARGET = "__jetpack__";

/** What the wizard reaches outside itself; a test replaces these. */
export type WizardDeps = {
  adapters: () => Adapter[];
  move: typeof moveCommand;
  exportTo: typeof exportCommand;
  isTTY: () => boolean;
};

const DEFAULT_DEPS: WizardDeps = {
  adapters: listAdapters,
  move: moveCommand,
  exportTo: exportCommand,
  isTTY: hasTerminal,
};

type Detected = { adapter: Adapter; found: boolean; hint?: string };

/** What every adapter's `detect` says, all asked at once; one that fails counts as not found. */
function detectAll(adapters: readonly Adapter[], ctx: Ctx): Promise<Detected[]> {
  return Promise.all(
    adapters.map(async (adapter): Promise<Detected> => {
      try {
        const { found, hint } = await adapter.detect(ctx);
        return { adapter, found, ...(hint === undefined ? {} : { hint }) };
      } catch (error) {
        return { adapter, found: false, hint: `detect failed: ${messageOf(error)}` };
      }
    }),
  );
}

const notFound = (hint: string | undefined): string =>
  hint === undefined ? "not found" : oneLine(`not found: ${hint}`);

/** One sentence on what is about to happen, the last thing the user reads before saying yes. */
function summarize(agent: string, from: Adapter, to: Adapter | undefined, file: string, copy = false): string {
  if (to === undefined) return `Save ${agent} from ${from.displayName} as ${file} in this folder. Existing archives are kept.`;
  const ending =
    to.handoff === true
      ? `${to.displayName} needs one more step after this, which the report names.`
      : copy ? "A separate copy is created; the existing agent is kept." : "An agent of the same name is updated.";
  return `Move ${agent} from ${from.displayName} to ${to.displayName}. Routines arrive disabled. ${ending}`;
}

/** Nothing was asked of the user and nothing is written: the end of a run that cannot go on. */
function stop(prompter: Prompter, outro: string): "cancelled" {
  prompter.outro(outro);
  return "cancelled";
}

/**
 * Walks the user from the app an agent is in to where it should go, then moves it (or saves it
 * as `<name>.jetpack` in the working folder). Cancelling at any question, or answering no to
 * the last, writes nothing. `opts` goes on to `move` or `export` as it is.
 */
export async function runWizard(
  prompter: Prompter,
  opts: CommonOptions,
  deps: Partial<WizardDeps> = {},
): Promise<"done" | "cancelled"> {
  const { adapters, move, exportTo, isTTY } = { ...DEFAULT_DEPS, ...deps };
  if (!isTTY()) {
    throw new UsageError("The wizard needs a terminal; run `openteleport --help` for the commands");
  }

  prompter.intro("OpenTeleport");
  const ctx = buildCtx(opts);
  const detected = await detectAll(adapters(), ctx);
  const found = detected.filter((entry) => entry.found);
  if (found.length === 0) {
    const reasons = detected.map(
      ({ adapter, hint }) => `${adapter.displayName}${hint === undefined ? "" : `: ${oneLine(hint)}`}`,
    );
    if (reasons.length > 0) prompter.note(reasons.join("\n"));
    throw new NotDetectedError("No supported app was found, so there is nothing to move.");
  }

  // Apps that are there come first, so that the question starts on one that can be picked.
  const source = await prompter.select<Adapter>("Where does the agent live now?", [
    ...found.map(({ adapter }) => ({ value: adapter, label: adapter.displayName })),
    ...detected
      .filter((entry) => !entry.found)
      .map(({ adapter, hint }) => ({
        value: adapter,
        label: adapter.displayName,
        disabled: true,
        hint: notFound(hint),
      })),
  ]);
  if (source === CANCELLED) return stop(prompter, "Cancelled.");

  const [first, ...others] = await source.list(sideOf(ctx, "source"));
  if (first === undefined) throw new NotDetectedError(`${source.displayName} has no agents.`);
  let agent: AgentRef = first;
  if (others.length === 0) {
    prompter.note(`Agent: ${oneLine(agent.name)}`);
  } else {
    const picked = await prompter.select<AgentRef>(
      "Which agent?",
      [first, ...others].map((ref) => ({
        value: ref,
        label: oneLine(ref.name),
        hint: oneLine(ref.location ?? ref.id),
      })),
    );
    if (picked === CANCELLED) return stop(prompter, "Cancelled.");
    agent = picked;
  }

  // A target that creates what it writes (a folder, a hand-over) needs no app to be found.
  const target = await prompter.select<Adapter | typeof JETPACK_TARGET>("Where should it go?", [
    ...detected
      .filter(({ adapter, found: there }) => there || adapter.createsOnWrite === true)
      .map(({ adapter }) => ({ value: adapter, label: adapter.displayName })),
    { value: JETPACK_TARGET, label: "Save as a .jetpack file" },
  ]);
  if (target === CANCELLED) return stop(prompter, "Cancelled.");

  const file = `${fileSlug(agent.name)}.jetpack`;
  const to = target === JETPACK_TARGET ? undefined : target;
  const memory = await prompter.select<boolean>("Include the agent's saved facts and notes?", [
    { value: true, label: "Include facts and notes", hint: "Keep the agent's remembered context" },
    { value: false, label: "Leave out facts and notes", hint: "Other content may still contain personal information" },
  ]);
  if (memory === CANCELLED) return stop(prompter, "Cancelled.");
  let copy = false;
  if (!memory && to) {
    const mode = await prompter.select<boolean>("How should the destination agent be written?", [
      { value: true, label: "Create a separate copy", hint: "Keep the existing agent and its memory" },
      { value: false, label: "Update the previously imported agent", hint: "May remove its previously imported facts and notes" },
    ]);
    if (mode === CANCELLED) return stop(prompter, "Cancelled.");
    copy = mode;
  }
  prompter.note(memory
    ? "Saved facts and notes will be included. Review personal information before sharing."
    : "Saved facts and notes will be left out. Instructions, persona, skills and other content may still contain personal information."
      + (to && !copy ? " Updating may remove previously imported destination memory." : ""));
  prompter.note(summarize(oneLine(agent.name), source, to, file, copy));
  const go = await prompter.confirm("Go ahead?");
  if (go !== true) return stop(prompter, "Cancelled.");

  if (to === undefined) {
    await exportTo({ ...opts, ...(!memory ? { memory: false } : {}), from: source.name, agent: agent.id, out: file, overwrite: false });
  } else {
    await move({ ...opts, ...(!memory ? { memory: false, copy } : {}), from: source.name, to: to.name, agent: agent.id });
  }
  prompter.outro(to?.handoff === true ? "Done. The report names the step that is left." : "Done.");
  return "done";
}
