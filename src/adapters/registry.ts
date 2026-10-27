import type { Adapter } from "./types.js";

export class UnknownAdapterError extends Error {
  readonly adapterName: string;
  /** The names that were registered when the lookup failed, in registration order. */
  readonly available: string[];

  constructor(adapterName: string, available: string[]) {
    super(
      available.length === 0
        ? `Unknown adapter "${adapterName}": none registered`
        : `Unknown adapter "${adapterName}". Available: ${available.join(", ")}`,
    );
    this.name = "UnknownAdapterError";
    this.adapterName = adapterName;
    this.available = available;
  }
}

/** Keyed by `Adapter.name`. A `Map` keeps insertion order, which is the order `listAdapters` uses. */
const adapters = new Map<string, Adapter>();

/**
 * Adds an adapter. One registered again under a name already taken replaces the earlier one and
 * keeps its place in the list.
 */
export function registerAdapter(adapter: Adapter): void {
  adapters.set(adapter.name, adapter);
}

/** Every registered adapter, in registration order. */
export function listAdapters(): Adapter[] {
  return [...adapters.values()];
}

/** The adapter registered under `name`; throws `UnknownAdapterError` naming the others. */
export function getAdapter(name: string): Adapter {
  const adapter = adapters.get(name);
  if (adapter === undefined) throw new UnknownAdapterError(name, [...adapters.keys()]);
  return adapter;
}
