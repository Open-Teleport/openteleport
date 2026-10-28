import type { execa } from "execa";
import type { Item } from "../core/report.js";
import type { Bundle, Schedule } from "../core/schema.js";

/**
 * What an app can hold. The engine empties every field marked `false` before `write` and lists
 * it as skipped; a routine whose `schedule.kind` is not in `schedules` is skipped on its own.
 */
export type AdapterCapabilities = {
  persona: boolean;
  instructions: boolean;
  skills: boolean;
  routines: boolean;
  facts: boolean;
  notes: boolean;
  files: boolean;
  avatar: boolean;
  models: boolean;
  schedules: Schedule["kind"][];
};

/** An agent as `list` shows it. `id` is what `read` takes. */
export type AgentRef = { id: string; name: string; title?: string; location?: string };

export type WriteResult = {
  /** `handoff`: the user still has to finish the move by hand, as `nextStep` says. */
  outcome: "done" | "handoff";
  nextStep?: string;
  /** How the target app now refers to the agent. */
  targetAgentId?: string;
  /** A file the adapter produced for the user, such as a bundle to import by hand. */
  artifactPath?: string;
  /**
   * Only what the adapter itself approximated, skipped or wants to warn about. What the engine
   * stripped before `write` (fields the capabilities mark `false`, routines with a schedule kind
   * not in `schedules`, `files` without `includeFiles`) is already in the report and is never
   * reported again here.
   */
  items: { approximated: Item[]; skipped: Item[]; warnings: string[] };
};

/**
 * Everything an adapter may touch outside its arguments. Adapters read the home directory only
 * from `home`, never from the process, so tests can point it at a temporary directory.
 */
export type Ctx = {
  /** Where to read from instead of the app's default location. */
  sourceDir?: string;
  /** Where to write to instead of the app's default location. */
  targetDir?: string;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  exec: typeof execa;
  logger: (msg: string) => void;
};

export type WriteOpts = {
  /** Leave imported routines enabled; by default they arrive disabled. */
  enableRoutines: boolean;
  includeFiles: boolean;
  /** What to do when the target already has an agent of the same name. */
  onConflict: "update" | "replace" | "copy";
};

export type Adapter = {
  /** The name used on the command line, such as `--from <name>`. */
  name: string;
  displayName: string;
  capabilities: AdapterCapabilities;
  detect(ctx: Ctx): Promise<{ found: boolean; location?: string; version?: string; hint?: string }>;
  list(ctx: Ctx): Promise<AgentRef[]>;
  /** Never modifies the source. */
  read(ctx: Ctx, agent: string): Promise<{ bundle: Bundle; warnings: string[] }>;
  /**
   * What tells this agent apart from every other one the adapter can read, when `agent` alone
   * does not: the engine keys the id it gives an agent without one (in
   * `~/.openteleport/ids.json`) by this instead of by `agent`. The folder adapter returns the
   * real path of the agent's folder, since `.` names a different agent in every folder.
   * Optional; called with the source's side of the context, after `read`.
   */
  cacheIdentity?(ctx: Ctx, agent: string): string | Promise<string>;
  /**
   * Must not mutate `bundle`. The engine hands over shallow copies whose nested arrays and
   * objects are shared with the Bundle the source adapter returned, so an adapter that needs to
   * reorder or edit anything copies it first.
   */
  write(ctx: Ctx, bundle: Bundle, opts: WriteOpts): Promise<WriteResult>;
};
