// The YAML frontmatter at the top of a Markdown file (`---` lines around key: value pairs): a
// Claude Code subagent, a Letta memory file, a skill's SKILL.md.
import { parse } from "yaml";
import { withoutMark } from "./text.js";

// The opening fence must be the first line; the closing one is the next line that is only `---`.
const FRONTMATTER = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/;

/** The text with its byte order mark dropped and its line endings made `\n`. */
function normalized(text: string): string {
  return withoutMark(text).replace(/\r\n?/g, "\n");
}

/** What is wrong with a frontmatter block: it is not YAML (`yaml`) or not a mapping (`shape`). */
export class FrontmatterError extends Error {
  readonly kind: "yaml" | "shape";

  constructor(kind: "yaml" | "shape", detail: string, options?: ErrorOptions) {
    super(`invalid frontmatter: ${detail}`, options);
    this.name = "FrontmatterError";
    this.kind = kind;
  }
}

/** Whether the text opens with a frontmatter block, an empty one included. */
export function hasFrontmatter(text: string): boolean {
  return FRONTMATTER.test(normalized(text));
}

/**
 * Splits a Markdown file into its YAML frontmatter (between `---` lines at the top) and the
 * text after it, without the blank lines that open it. A byte order mark is dropped and line
 * endings become `\n`. A file that does not open with a `---` line has no frontmatter: `data` is
 * empty and all of the text is the body, as an empty frontmatter has an empty `data` too. Throws
 * a `FrontmatterError` when the frontmatter is not YAML or not a mapping of keys to values.
 */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const source = normalized(text);
  const match = FRONTMATTER.exec(source);
  if (match === null) return { data: {}, body: source };
  let data: unknown;
  try {
    data = parse(match[1] ?? "");
  } catch (error) {
    throw new FrontmatterError("yaml", (error as Error).message, { cause: error });
  }
  data ??= {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new FrontmatterError("shape", "expected key: value pairs");
  }
  return {
    data: data as Record<string, unknown>,
    body: source.slice(match[0].length).replace(/^\n+/, ""),
  };
}
