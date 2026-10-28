/** Plain code-unit order, so that a sorted list does not depend on the locale. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const PERSONA_HEADING = "# Persona";
const INSTRUCTIONS_HEADING = "# Instructions";

/**
 * Joins a persona and instructions into the one document that a target without a separate persona
 * slot can hold: an H1 `# Persona` section, then an H1 `# Instructions` section, each part trimmed
 * and the whole ending in a single newline. Without a persona (missing or blank) the instructions
 * pass through exactly as given.
 */
export function mergeInstructions(persona: string | undefined, instructions: string): string {
  const personaText = persona?.trim() ?? "";
  if (personaText === "") return instructions;
  const personaSection = `${PERSONA_HEADING}\n\n${personaText}`;
  return `${personaSection}\n\n${INSTRUCTIONS_HEADING}\n\n${instructions.trim()}\n`;
}

function isHeading(line: string | undefined, heading: string): boolean {
  // `trimEnd` also drops the carriage return of a CRLF file.
  return line !== undefined && line.trimEnd() === heading;
}

/**
 * The inverse of `mergeInstructions`. It recognises exactly that layout: the text starts with an
 * H1 `# Persona` line, and an H1 `# Instructions` line follows it. The first such line ends the
 * persona, so any later H1 stays inside the instructions. Both parts come back trimmed; an empty
 * persona is left out. Any other text is not split and comes back as the instructions, unchanged.
 */
export function splitInstructions(text: string): { persona?: string; instructions: string } {
  const lines = text.split("\n");
  if (!isHeading(lines[0], PERSONA_HEADING)) return { instructions: text };
  const split = lines.findIndex((line, i) => i > 0 && isHeading(line, INSTRUCTIONS_HEADING));
  if (split === -1) return { instructions: text };
  const persona = lines.slice(1, split).join("\n").trim();
  const instructions = lines.slice(split + 1).join("\n").trim();
  return persona === "" ? { instructions } : { persona, instructions };
}

// A list item starts with `-`, `*` or `N.` followed by whitespace, so `-5`, `**bold**` and `1.5`
// stay prose.
const LIST_ITEM = /^\s*(?:[-*]|\d+\.)\s+(.*)$/;

const ELLIPSIS = "…";

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function clip(item: string, max: number): string {
  if (item.length <= max) return item;
  let end = max - 1;
  // Do not leave half of a surrogate pair at the cut; the result is then one unit shorter.
  if (end > 0 && isHighSurrogate(item.charCodeAt(end - 1))) end -= 1;
  return `${item.slice(0, end)}${ELLIPSIS}`;
}

/**
 * Splits free-form notes into short facts. Paragraphs are separated by blank lines; inside one,
 * every `- `, `* ` or `N. ` line starts its own fact, and any other line is the start of a fact or
 * a soft-wrapped continuation of the one before it. Items are trimmed (list markers dropped),
 * empty ones are skipped, and an item longer than `max` is cut to `max` characters ending in an
 * ellipsis; `truncated` counts those cuts.
 */
export function proseToFacts(notes: string, max = 500): { facts: string[]; truncated: number } {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`max must be a positive integer, got ${max}`);
  }
  const items: string[] = [];
  for (const paragraph of notes.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const start = items.length;
    for (const line of paragraph.split("\n")) {
      const listItem = LIST_ITEM.exec(line);
      if (listItem) {
        items.push(listItem[1] ?? "");
      } else if (line.trim() !== "") {
        if (items.length > start) items[items.length - 1] += ` ${line.trim()}`;
        else items.push(line);
      }
    }
  }

  const facts: string[] = [];
  let truncated = 0;
  for (const item of items) {
    const fact = item.trim();
    if (fact === "") continue;
    const clipped = clip(fact, max);
    if (clipped !== fact) truncated += 1;
    facts.push(clipped);
  }
  return { facts, truncated };
}

/**
 * Writes facts as a bullet list, one `- fact` per line and no trailing newline. A fact stays on
 * one line (its line breaks become spaces) and blank facts are skipped.
 */
export function factsToProse(facts: string[]): string {
  return facts
    .map((fact) => fact.replace(/\s*[\r\n]+\s*/g, " ").trim())
    .filter((fact) => fact !== "")
    .map((fact) => `- ${fact}`)
    .join("\n");
}
