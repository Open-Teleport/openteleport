import { describe, expect, it } from "vitest";
import { isRecord, nonBlank } from "../../src/core/values.js";

describe("isRecord", () => {
  it("is true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
    ["a string", "text"],
    ["a number", 1],
    ["a boolean", true],
    ["a function", () => undefined],
  ])("is false for %s", (_what, value) => {
    expect(isRecord(value)).toBe(false);
  });
});

describe("nonBlank", () => {
  it("gives a string trimmed", () => {
    expect(nonBlank("  Ada \n")).toBe("Ada");
    expect(nonBlank("Ada")).toBe("Ada");
  });

  it.each([
    ["an empty string", ""],
    ["a blank string", " \t\r\n"],
    ["a number", 1],
    ["null", null],
    ["undefined", undefined],
    ["an object", { name: "Ada" }],
  ])("is undefined for %s", (_what, value) => {
    expect(nonBlank(value)).toBeUndefined();
  });
});
