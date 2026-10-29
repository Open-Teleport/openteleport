// The memory files of a Hermes profile (`memories/MEMORY.md`, `memories/USER.md`): entries
// joined by one delimiter, as `tools/memory_tool_store.py` reads and writes them.

/** What Hermes puts between two entries. */
export const ENTRY_DELIMITER = "\n§\n";

/**
 * The entries of a memory file: a byte order mark dropped, CRLF read as LF, the text split at the
 * full delimiter, each entry trimmed and the empty ones left out.
 */
export function parseEntries(text: string): string[] {
  const clean = (text.startsWith("\uFEFF") ? text.slice(1) : text).replace(/\r\n/g, "\n");
  return clean
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** The file content for `entries`: joined by the delimiter, with no line break at the end. */
export function renderEntries(entries: readonly string[]): string {
  return entries.join(ENTRY_DELIMITER);
}

/**
 * An entry as the one-line fact it is read as: every line break, with the spaces around it, becomes
 * a single space (as `factsToProse` folds on writing), and the whole is trimmed. What the reader
 * returns and what `writeMemory` compares a fact against are both this.
 */
export function foldLines(entry: string): string {
  return entry.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/**
 * A fact as one entry: LF line breaks, trimmed, and without a line that is only a section sign,
 * which Hermes would read as the boundary of two entries.
 */
export function entryText(fact: string): string {
  return fact
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "§")
    .join("\n")
    .trim();
}
