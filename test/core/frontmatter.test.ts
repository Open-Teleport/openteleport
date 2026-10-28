import { describe, expect, it } from "vitest";
import { FrontmatterError, hasFrontmatter, splitFrontmatter } from "../../src/core/frontmatter.js";

const BOM = String.fromCharCode(0xfeff);

describe("splitFrontmatter", () => {
  it("reads the fields and the body, dropping a byte order mark and CRLF line endings", () => {
    const text = `${BOM}---\r\nname: Reviewer\r\ndescription: Reviews PRs\r\n---\r\nCalm.\r\nShort.\r\n`;
    expect(splitFrontmatter(text)).toEqual({
      data: { name: "Reviewer", description: "Reviews PRs" },
      body: "Calm.\nShort.\n",
    });
  });

  it("drops the blank lines that open the body", () => {
    expect(splitFrontmatter("---\nname: plain\n---\n\n\nJust text.\n")).toEqual({
      data: { name: "plain" },
      body: "Just text.\n",
    });
  });

  it("treats a file that does not open with --- as all body", () => {
    expect(splitFrontmatter("Hello\n---\nnot: frontmatter\n---\n")).toEqual({
      data: {},
      body: "Hello\n---\nnot: frontmatter\n---\n",
    });
    const persona = "# Persona\n\nCalm.\n\n# Instructions\n\nHelp.\n";
    expect(splitFrontmatter(persona)).toEqual({ data: {}, body: persona });
  });

  it("keeps the leading line breaks of a file without frontmatter", () => {
    expect(splitFrontmatter("\r\n\r\nBody\r\n")).toEqual({ data: {}, body: "\n\nBody\n" });
  });

  it("reads an empty frontmatter as no fields", () => {
    expect(splitFrontmatter("---\n---\nBody\n")).toEqual({ data: {}, body: "Body\n" });
  });

  it("ends the frontmatter at a closing fence without a body", () => {
    expect(splitFrontmatter("---\nname: a\n---")).toEqual({ data: { name: "a" }, body: "" });
  });

  it("allows spaces after the fences", () => {
    expect(splitFrontmatter("---  \nname: a\n--- \nBody\n")).toEqual({
      data: { name: "a" },
      body: "Body\n",
    });
  });

  it("throws for a frontmatter that is not YAML", () => {
    const failure = (() => {
      try {
        splitFrontmatter("---\nname: [unclosed\n---\nBody\n");
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(FrontmatterError);
    expect((failure as FrontmatterError).kind).toBe("yaml");
    expect((failure as FrontmatterError).message).toMatch(/^invalid frontmatter: /);
    expect((failure as FrontmatterError).cause).toBeInstanceOf(Error);
  });

  it("throws for a frontmatter that is not a mapping", () => {
    for (const text of ["---\njust text\n---\nBody\n", "---\n- a\n- b\n---\n"]) {
      const failure = (() => {
        try {
          splitFrontmatter(text);
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(FrontmatterError);
      expect((failure as FrontmatterError).kind).toBe("shape");
      expect((failure as FrontmatterError).message).toBe(
        "invalid frontmatter: expected key: value pairs",
      );
    }
  });
});

describe("hasFrontmatter", () => {
  it("is true for a file that opens with a frontmatter block, an empty one included", () => {
    expect(hasFrontmatter("---\nname: a\n---\nBody\n")).toBe(true);
    expect(hasFrontmatter(`${BOM}---\r\nname: a\r\n---\r\n`)).toBe(true);
    expect(hasFrontmatter("---\n---\n")).toBe(true);
  });

  it("is false when the file does not open with one, or the block is never closed", () => {
    expect(hasFrontmatter("# Plain\n\nNo frontmatter.\n")).toBe(false);
    expect(hasFrontmatter("Intro\n---\nname: x\n---\n")).toBe(false);
    expect(hasFrontmatter("---\nname: x\n")).toBe(false);
  });
});
