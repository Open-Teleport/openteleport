import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENTRY_DELIMITER,
  entryText,
  parseEntries,
  renderEntries,
} from "../../../src/adapters/hermes/memory.js";

const MEMORY = fileURLToPath(
  new URL("../../fixtures/hermes/home/memories/MEMORY.md", import.meta.url),
);

describe("parseEntries", () => {
  it("splits on the section sign between line breaks", () => {
    expect(ENTRY_DELIMITER).toBe("\n§\n");
    expect(parseEntries("one\n§\ntwo\n§\nthree")).toEqual(["one", "two", "three"]);
  });

  it("drops a byte order mark", () => {
    expect(parseEntries("﻿one\n§\ntwo")).toEqual(["one", "two"]);
  });

  it("reads CRLF files", () => {
    expect(parseEntries("one\r\n§\r\ntwo\r\nsecond line")).toEqual(["one", "two\nsecond line"]);
  });

  it("trims entries and skips empty ones", () => {
    expect(parseEntries("\n  one  \n§\n\n§\n   \n§\ntwo\n")).toEqual(["one", "two"]);
  });

  it("keeps a section sign that is not on a line of its own", () => {
    expect(parseEntries("a § b\n§\nc")).toEqual(["a § b", "c"]);
  });

  it("is empty for an empty or blank file", () => {
    expect(parseEntries("")).toEqual([]);
    expect(parseEntries("﻿ \n")).toEqual([]);
  });
});

describe("renderEntries", () => {
  it("joins with the delimiter and no trailing line break", () => {
    expect(renderEntries(["one", "two"])).toBe("one\n§\ntwo");
    expect(renderEntries([])).toBe("");
  });

  it("round-trips the fixture", async () => {
    const text = (await readFile(MEMORY, "utf8")).replace(/\r\n/g, "\n");
    const entries = parseEntries(text);
    expect(entries.map((entry) => entry.length)).toEqual([47, 56, 700]);
    expect(renderEntries(entries)).toBe(text);
  });
});

describe("entryText", () => {
  it("trims and uses LF line breaks", () => {
    expect(entryText("  a\r\nb \n")).toBe("a\nb");
  });

  it("drops a line that is only a section sign, so it cannot split the entry on the next read", () => {
    const text = entryText("before\n§\nafter");
    expect(text).toBe("before\nafter");
    expect(parseEntries(renderEntries([text, "next"]))).toEqual(["before\nafter", "next"]);
  });
});
