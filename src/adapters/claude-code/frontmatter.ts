import { parse, stringify } from "yaml";

/** A subagent file: YAML frontmatter between `---` lines, then the system prompt. */
export type AgentFile = {
  name?: string;
  description?: string;
  /** Present when the frontmatter declares `tools`, as a list or a comma-separated string. */
  tools?: string[];
  model?: string;
  /** The text after the frontmatter, without the blank lines that open it. */
  body: string;
  /** Frontmatter keys other than `name`, `description`, `tools` and `model`, in file order. */
  ignored: string[];
};

const KNOWN_KEYS = new Set(["name", "description", "tools", "model"]);

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

// The opening fence must be the first line; the closing one is the next line that is only `---`.
const FRONTMATTER = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/;

/** A scalar as text; anything else, and an empty string, is absent. */
function scalar(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return undefined;
  }
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/** Splits `Read, Bash(git add:*, git commit:*)` on the commas outside brackets. */
function splitTools(list: string): string[] {
  const tools: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    if (char === "," && depth === 0) {
      tools.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  tools.push(current);
  return tools.map((tool) => tool.trim()).filter((tool) => tool !== "");
}

function toolsOf(value: unknown): string[] | undefined {
  if (typeof value === "string") return splitTools(value);
  if (Array.isArray(value)) {
    return value.map(scalar).filter((tool): tool is string => tool !== undefined);
  }
  return undefined;
}

/**
 * Parses a Claude Code subagent file. Line endings become `\n` and a byte order mark is dropped.
 * A file that does not open with a `---` line has no frontmatter: all of it is the body. Throws
 * when the frontmatter is not YAML or not a mapping.
 */
export function parseAgentFile(text: string): AgentFile {
  const unmarked = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const source = unmarked.replace(/\r\n?/g, "\n");
  const match = FRONTMATTER.exec(source);
  if (match === null) return { name: undefined, body: source, ignored: [] };

  let data: unknown;
  try {
    data = parse(match[1] ?? "");
  } catch (error) {
    throw new Error(`invalid frontmatter: ${(error as Error).message}`);
  }
  data ??= {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("invalid frontmatter: expected key: value pairs");
  }
  const fields = data as Record<string, unknown>;

  const file: AgentFile = {
    body: source.slice(match[0].length).replace(/^\n+/, ""),
    ignored: Object.keys(fields).filter((key) => !KNOWN_KEYS.has(key)),
  };
  const name = scalar(fields.name);
  if (name !== undefined) file.name = name;
  const description = scalar(fields.description);
  if (description !== undefined) file.description = description;
  const tools = toolsOf(fields.tools);
  if (tools !== undefined) file.tools = tools;
  const model = scalar(fields.model);
  if (model !== undefined) file.model = model;
  return file;
}

/**
 * Writes a subagent file: `name`, `description`, then `tools` (comma-separated, left out when
 * empty) and `model` (left out when absent), then a blank line and the body ending in a newline.
 */
export function renderAgentFile(agent: {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  body: string;
}): string {
  const fields: Record<string, string> = { name: agent.name, description: agent.description };
  if (agent.tools !== undefined && agent.tools.length > 0) fields.tools = agent.tools.join(", ");
  if (agent.model !== undefined) fields.model = agent.model;
  // lineWidth 0: never fold a long description onto several lines.
  const frontmatter = `---\n${stringify(fields, { lineWidth: 0 })}---\n`;
  if (agent.body === "") return frontmatter;
  return `${frontmatter}\n${agent.body.endsWith("\n") ? agent.body : `${agent.body}\n`}`;
}
