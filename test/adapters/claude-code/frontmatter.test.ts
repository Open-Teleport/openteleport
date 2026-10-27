import { describe, expect, it } from "vitest";
import { parseAgentFile, renderAgentFile } from "../../../src/adapters/claude-code/frontmatter.js";

describe("parseAgentFile", () => {
  it("reads the frontmatter fields and the body after it", () => {
    const parsed = parseAgentFile(
      [
        "---",
        "name: reviewer",
        "description: Reviews pull requests.",
        "tools: Read, Grep, Bash",
        "model: claude-opus-5-5",
        "---",
        "",
        "Review the diff.",
        "",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      name: "reviewer",
      description: "Reviews pull requests.",
      tools: ["Read", "Grep", "Bash"],
      model: "claude-opus-5-5",
      body: "Review the diff.\n",
      ignored: [],
    });
  });

  it("takes tools as a YAML list", () => {
    const parsed = parseAgentFile("---\nname: a\ntools:\n  - Read\n  - ' WebFetch '\n---\nBody\n");
    expect(parsed.tools).toEqual(["Read", "WebFetch"]);
  });

  it("keeps commas inside a permission rule's brackets", () => {
    const parsed = parseAgentFile("---\nname: a\ntools: Read, Bash(git add:*, git commit:*), Grep\n---\n");
    expect(parsed.tools).toEqual(["Read", "Bash(git add:*, git commit:*)", "Grep"]);
  });

  it("reads an empty tools list as declared and empty", () => {
    expect(parseAgentFile("---\nname: a\ntools: []\n---\n").tools).toEqual([]);
  });

  it("leaves out fields that are not set", () => {
    const parsed = parseAgentFile("---\nname: plain\n---\n\nJust text.\n");
    expect(parsed).toEqual({ name: "plain", body: "Just text.\n", ignored: [] });
  });

  it("returns the whole text as the body when there is no frontmatter", () => {
    const text = "# Persona\n\nCalm.\n\n# Instructions\n\nHelp.\n";
    expect(parseAgentFile(text)).toEqual({ name: undefined, body: text, ignored: [] });
  });

  it("does not take a horizontal rule in the middle for frontmatter", () => {
    const text = "Intro\n---\nname: x\n---\n";
    expect(parseAgentFile(text)).toEqual({ name: undefined, body: text, ignored: [] });
  });

  it("handles CRLF line endings and a byte order mark", () => {
    const bom = String.fromCharCode(0xfeff);
    const parsed = parseAgentFile(
      `${bom}---\r\nname: crlf\r\nmodel: sonnet\r\n---\r\n\r\nLine one.\r\nLine two.\r\n`,
    );
    expect(parsed).toEqual({
      name: "crlf",
      model: "sonnet",
      body: "Line one.\nLine two.\n",
      ignored: [],
    });
  });

  it("accepts empty frontmatter", () => {
    expect(parseAgentFile("---\n---\nBody\n")).toEqual({ body: "Body\n", ignored: [] });
  });

  it("names the frontmatter keys it does not map", () => {
    const parsed = parseAgentFile("---\nname: a\ncolor: green\npermissionMode: plan\n---\n");
    expect(parsed.ignored).toEqual(["color", "permissionMode"]);
  });

  it("turns scalar values into text", () => {
    const parsed = parseAgentFile("---\nname: 42\ndescription: true\n---\n");
    expect(parsed.name).toBe("42");
    expect(parsed.description).toBe("true");
  });

  it("throws on frontmatter that is not YAML", () => {
    expect(() => parseAgentFile("---\nname: [unclosed\n---\n")).toThrow(/frontmatter/);
  });

  it("throws on frontmatter that is not a mapping", () => {
    expect(() => parseAgentFile("---\n- a\n- b\n---\n")).toThrow(/frontmatter/);
  });
});

describe("renderAgentFile", () => {
  it("writes name, description, tools and model, then the body", () => {
    const text = renderAgentFile({
      name: "reviewer",
      description: "Reviews pull requests.",
      tools: ["Read", "Grep", "Bash"],
      model: "claude-opus-5-5",
      body: "Review the diff.\n",
    });

    expect(text).toBe(
      [
        "---",
        "name: reviewer",
        "description: Reviews pull requests.",
        "tools: Read, Grep, Bash",
        "model: claude-opus-5-5",
        "---",
        "",
        "Review the diff.",
        "",
      ].join("\n"),
    );
  });

  it("leaves out tools and model when there are none", () => {
    const text = renderAgentFile({ name: "ada", description: "Research assistant", tools: [], body: "Hi" });
    expect(text).toBe("---\nname: ada\ndescription: Research assistant\n---\n\nHi\n");
  });

  it("quotes what YAML needs quoted and reads it back unchanged", () => {
    const description = 'Use it when: the build fails, or "tests" are red # not a comment';
    const long = `${"word ".repeat(60)}end`;
    const text = renderAgentFile({ name: "ci", description, model: long, body: "Fix it.\n" });

    const parsed = parseAgentFile(text);
    expect(parsed.description).toBe(description);
    expect(parsed.model).toBe(long);
    expect(parsed.body).toBe("Fix it.\n");
  });

  it("writes an empty body as frontmatter alone", () => {
    expect(renderAgentFile({ name: "a", description: "b", body: "" })).toBe(
      "---\nname: a\ndescription: b\n---\n",
    );
  });
});
