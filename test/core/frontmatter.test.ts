import { describe, expect, it } from "vitest";
import { FrontmatterError, parseFrontmatterBlock, splitFrontmatter } from "../../src/core/frontmatter.js";

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

describe("parseFrontmatterBlock", () => {
  it("reads the fields of a block, CRLF line endings included", () => {
    expect(parseFrontmatterBlock("name: Reviewer\r\ndescription: Reviews PRs")).toEqual({
      name: "Reviewer",
      description: "Reviews PRs",
    });
  });

  it("reads an empty block, or one that is only a comment, as no fields", () => {
    expect(parseFrontmatterBlock("")).toEqual({});
    expect(parseFrontmatterBlock("# nothing here")).toEqual({});
  });

  it("throws a yaml error for a block that is not YAML", () => {
    expect(() => parseFrontmatterBlock("name: [unclosed")).toThrow(
      expect.objectContaining({ name: "FrontmatterError", kind: "yaml" }),
    );
  });

  it("throws a shape error for YAML that is not a mapping", () => {
    for (const block of ["- a\n- b", "just text", "42"]) {
      expect(() => parseFrontmatterBlock(block)).toThrow(
        expect.objectContaining({ name: "FrontmatterError", kind: "shape" }),
      );
    }
  });
});
