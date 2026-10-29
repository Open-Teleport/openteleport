import type { Bundle } from "./schema.js";
import type { Item } from "./report.js";

/** Select incoming structured memory; this does not preserve destination fields or anonymize text. */
export function selectMemory(bundle: Bundle, includeMemory = true, onConflict?: string) {
  const excluded: Item[] = [];
  const warnings: string[] = [];
  if (includeMemory) return { bundle, excluded, warnings };
  if (bundle.facts.length) excluded.push({ field: "memory.facts", detail: `${bundle.facts.length} facts excluded by includeMemory=false` });
  if (bundle.notes.length) excluded.push({ field: "memory.notes", detail: `${bundle.notes.length} notes excluded by includeMemory=false` });
  warnings.push("Only structured facts and notes are excluded. Instructions, persona, skills, routines, files and metadata may still contain personal information; this is not anonymization.");
  if (onConflict && onConflict !== "copy") warnings.push("Updating without memory may remove previously imported destination memory, depending on the adapter. Use copy to keep the existing agent.");
  return { bundle: { ...bundle, facts: [], notes: [] }, excluded, warnings };
}
