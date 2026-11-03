import { stringify } from "yaml";
import { splitFrontmatter } from "../../core/frontmatter.js";

/** A subagent file: YAML frontmatter between `---` lines, then the system prompt. */
export type AgentFile = {
  name?: string;
  description?: string;
  /** Present when the frontmatter declares `tools`, as a list or a comma-separated string. */
  tools?: string[];
  model?: string;
  /** Present when the frontmatter declares `disallowedTools`, as a list or a comma-separated string. */
  disallowedTools?: string[];
  /** The raw `permissionMode` value, as written. */
  permissionMode?: string;
  /** The text after the frontmatter, without the blank lines that open it. */
  body: string;
  /**
   * Frontmatter keys other than `name`, `description`, `tools`, `disallowedTools`, `model` and
   * `permissionMode`, in file order.
   */
  ignored: string[];
};

const KNOWN_KEYS = new Set([
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "permissionMode",
]);

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
 * Parses a Claude Code subagent file: the frontmatter as `splitFrontmatter` reads it, then the
 * fields this adapter knows. A file that does not open with a `---` line has no frontmatter, and
 * all of it is the body. Throws when the frontmatter is not YAML or not a mapping.
 */
export function parseAgentFile(text: string): AgentFile {
  const { data: fields, body } = splitFrontmatter(text);
  const file: AgentFile = {
    body,
    ignored: Object.keys(fields).filter((key) => !KNOWN_KEYS.has(key)),
  };
  const name = scalar(fields.name);
  if (name !== undefined) file.name = name;
  const description = scalar(fields.description);
  if (description !== undefined) file.description = description;
  const tools = toolsOf(fields.tools);
  if (tools !== undefined) file.tools = tools;
  const disallowedTools = toolsOf(fields.disallowedTools);
  if (disallowedTools !== undefined) file.disallowedTools = disallowedTools;
  const model = scalar(fields.model);
  if (model !== undefined) file.model = model;
  const permissionMode = scalar(fields.permissionMode);
  if (permissionMode !== undefined) file.permissionMode = permissionMode;
  return file;
}

/**
 * Writes a subagent file: `name`, `description`, then `tools` and `disallowedTools`
 * (comma-separated, left out when empty), `model` and `permissionMode` (left out when absent),
 * then a blank line and the body ending in a newline.
 */
export function renderAgentFile(agent: {
  name: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  permissionMode?: string;
  body: string;
}): string {
  const fields: Record<string, string> = { name: agent.name, description: agent.description };
  if (agent.tools !== undefined && agent.tools.length > 0) fields.tools = agent.tools.join(", ");
  if (agent.disallowedTools !== undefined && agent.disallowedTools.length > 0) {
    fields.disallowedTools = agent.disallowedTools.join(", ");
  }
  if (agent.model !== undefined) fields.model = agent.model;
  if (agent.permissionMode !== undefined) fields.permissionMode = agent.permissionMode;
  // lineWidth 0: never fold a long description onto several lines.
  const frontmatter = `---\n${stringify(fields, { lineWidth: 0 })}---\n`;
  if (agent.body === "") return frontmatter;
  return `${frontmatter}\n${agent.body.endsWith("\n") ? agent.body : `${agent.body}\n`}`;
}
