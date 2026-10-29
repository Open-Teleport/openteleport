// Checks on values read from JSON, YAML or TOML, which can be anything.

/** A plain object: neither `null` nor an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A trimmed, non-blank string, or `undefined`. */
export function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
