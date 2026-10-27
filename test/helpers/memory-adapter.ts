// An adapter that keeps its agents in memory, for tests of the engine and the CLI.
//
// The CLI tests load this file with a dynamic `import()` in plain Node, which strips the types
// but resolves no `.js` -> `.ts` paths. Every import here is therefore `import type`, erased
// entirely, and the file uses only syntax that type stripping can erase.
import type {
  Adapter,
  AdapterCapabilities,
  AgentRef,
  WriteOpts,
  WriteResult,
} from "../../src/adapters/types.js";
import type { Bundle } from "../../src/core/schema.js";

export type MemoryAdapterOptions = {
  /** Default `memory`. */
  name?: string;
  /** Merged over a set where everything is supported and every schedule kind is accepted. */
  capabilities?: Partial<AdapterCapabilities>;
  /** The agents `list` and `read` see, by id. `write` adds to them. */
  agents?: Record<string, Bundle>;
  /** What every `write` reports. Default `done`. */
  outcome?: "done" | "handoff";
  nextStep?: string;
};

export type MemoryAdapter = Adapter & {
  /** Every `write` call in order, with the Bundle exactly as the adapter received it. */
  written: { bundle: Bundle; opts: WriteOpts }[];
};

const ALL_CAPABILITIES: AdapterCapabilities = {
  persona: true,
  instructions: true,
  skills: true,
  routines: true,
  facts: true,
  notes: true,
  files: true,
  avatar: true,
  models: true,
  schedules: ["cron", "every", "at"],
};

/**
 * A fresh in-memory adapter. `read` returns a copy, so the stored agents never change through
 * it. `write` keeps a copy under the Bundle's name; with `onConflict: "copy"` a name already
 * taken gets a `-2`, `-3`... suffix, otherwise the stored agent is overwritten.
 */
export function createMemoryAdapter(opts: MemoryAdapterOptions = {}): MemoryAdapter {
  const name = opts.name ?? "memory";
  const agents = new Map<string, Bundle>(Object.entries(opts.agents ?? {}));
  const written: { bundle: Bundle; opts: WriteOpts }[] = [];

  const freeId = (wanted: string, onConflict: WriteOpts["onConflict"]): string => {
    if (onConflict !== "copy" || !agents.has(wanted)) return wanted;
    let suffix = 2;
    while (agents.has(`${wanted}-${suffix}`)) suffix += 1;
    return `${wanted}-${suffix}`;
  };

  return {
    name,
    displayName: `In-memory ${name}`,
    capabilities: { ...ALL_CAPABILITIES, ...opts.capabilities },
    written,
    async detect() {
      return { found: true, location: `memory:${name}` };
    },
    async list(): Promise<AgentRef[]> {
      return [...agents].map(([id, bundle]) => ({ id, name: bundle.manifest.name }));
    },
    async read(_ctx, agent) {
      const bundle = agents.get(agent);
      if (bundle === undefined) throw new Error(`${name} has no agent "${agent}"`);
      return { bundle: structuredClone(bundle), warnings: [] };
    },
    async write(_ctx, bundle, writeOpts): Promise<WriteResult> {
      written.push({ bundle, opts: writeOpts });
      const targetAgentId = freeId(bundle.manifest.name, writeOpts.onConflict);
      agents.set(targetAgentId, structuredClone(bundle));
      return {
        outcome: opts.outcome ?? "done",
        ...(opts.nextStep === undefined ? {} : { nextStep: opts.nextStep }),
        targetAgentId,
        items: { approximated: [], skipped: [], warnings: [] },
      };
    },
  };
}

/** A manifest-less agent, as an app that knows nothing of `.jetpack` would hand it over. */
function sampleAgent(): Bundle {
  return {
    manifest: { schemaVersion: "0.1", id: "", name: "Ada", models: [], capabilities: [] },
    persona: "Calm and curious.",
    instructions: "Answer in five lines or fewer.\n",
    skills: [],
    routines: [],
    facts: ["Prefers answers in Polish unless the source is in English."],
    notes: [],
    files: [],
    unknownPaths: [],
  };
}

/** A ready adapter named `memory` that supports everything and holds one agent, `ada`. */
export default createMemoryAdapter({ agents: { ada: sampleAgent() } });
