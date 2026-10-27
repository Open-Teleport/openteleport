import { describe, expect, it } from "vitest";
import {
  factsToProse,
  mergeInstructions,
  proseToFacts,
  splitInstructions,
} from "../../src/core/text.js";

describe("mergeInstructions", () => {
  it("writes the persona and instructions as two H1 sections", () => {
    expect(mergeInstructions("P", "I")).toBe("# Persona\n\nP\n\n# Instructions\n\nI\n");
  });

  it("trims both parts and ends with a single newline", () => {
    expect(mergeInstructions("\n  Warm and direct.  \n\n", "\n\nBe brief.\n\n\n")).toBe(
      "# Persona\n\nWarm and direct.\n\n# Instructions\n\nBe brief.\n",
    );
  });

  it.each([
    ["no persona", undefined],
    ["an empty persona", ""],
    ["a blank persona", " \n\t "],
  ])("returns the instructions untouched for %s", (_name, persona) => {
    expect(mergeInstructions(persona, "Be brief.\n")).toBe("Be brief.\n");
  });
});

describe("splitInstructions", () => {
  it("is the inverse of mergeInstructions", () => {
    expect(splitInstructions(mergeInstructions("P", "I"))).toEqual({
      persona: "P",
      instructions: "I",
    });
  });

  it.each([
    ["multi-paragraph parts", "Line one.\n\nLine two.", "Step 1.\n\nStep 2.\n- a\n- b"],
    ["lower-level headings", "## Tone\nCalm.", "## Rules\nNo guessing.\n\n### Edge cases\nAsk."],
    ["another H1 inside the instructions", "Dry wit.", "Intro.\n\n# Notes\n\nKeep going."],
    [
      "a mention of the section names in prose",
      "Say '# Persona' never.",
      "Do not write # Instructions.",
    ],
  ])("round-trips %s", (_name, persona, instructions) => {
    expect(splitInstructions(mergeInstructions(persona, instructions))).toStrictEqual({
      persona,
      instructions,
    });
  });

  it("splits at the first Instructions heading", () => {
    const text = "# Persona\n\nP\n\n# Instructions\n\nA\n\n# Instructions\n\nB\n";
    expect(splitInstructions(text)).toStrictEqual({
      persona: "P",
      instructions: "A\n\n# Instructions\n\nB",
    });
  });

  it("accepts CRLF line endings and trailing whitespace after the headings", () => {
    expect(
      splitInstructions("# Persona  \r\n\r\nP\r\n\r\n# Instructions\t\r\n\r\nI\r\n"),
    ).toStrictEqual({ persona: "P", instructions: "I" });
  });

  it("leaves out the persona when its section is empty", () => {
    expect(splitInstructions("# Persona\n\n# Instructions\n\nI\n")).toStrictEqual({
      instructions: "I",
    });
  });

  it("keeps empty instructions as an empty string", () => {
    expect(splitInstructions("# Persona\n\nP\n\n# Instructions\n")).toStrictEqual({
      persona: "P",
      instructions: "",
    });
  });

  it.each([
    ["plain instructions", "Just do it.\n"],
    ["an empty string", ""],
    ["only an Instructions heading", "# Instructions\n\nI\n"],
    ["only a Persona heading", "# Persona\n\nP\n"],
    ["the headings in the wrong order", "# Instructions\n\nI\n\n# Persona\n\nP\n"],
    ["text before the Persona heading", "Intro\n\n# Persona\n\nP\n\n# Instructions\n\nI\n"],
    ["an indented Persona heading", "  # Persona\n\nP\n\n# Instructions\n\nI\n"],
    ["headings without the space", "#Persona\n\nP\n\n#Instructions\n\nI\n"],
    ["H2 headings", "## Persona\n\nP\n\n## Instructions\n\nI\n"],
    ["differently cased headings", "# persona\n\nP\n\n# instructions\n\nI\n"],
    ["a heading with extra words", "# Persona notes\n\nP\n\n# Instructions\n\nI\n"],
    ["a heading glued to its text", "# PersonaP\n\n# Instructions\n\nI\n"],
  ])("returns %s as plain instructions, unchanged", (_name, text) => {
    expect(splitInstructions(text)).toStrictEqual({ instructions: text });
  });
});

describe("proseToFacts", () => {
  it("turns paragraphs and bullets into separate facts", () => {
    expect(proseToFacts("Akapit.\n\n- a\n- b")).toStrictEqual({
      facts: ["Akapit.", "a", "b"],
      truncated: 0,
    });
  });

  it.each([
    ["dash bullets", "- one\n- two", ["one", "two"]],
    ["star bullets", "* one\n* two", ["one", "two"]],
    ["numbered items", "1. one\n2. two\n10. ten", ["one", "two", "ten"]],
    ["indented bullets", "- one\n  - nested\n    * deeper", ["one", "nested", "deeper"]],
    ["mixed markers", "- a\n* b\n3. c", ["a", "b", "c"]],
    ["paragraphs separated by several blank lines", "One.\n\n\n  \nTwo.", ["One.", "Two."]],
    ["a soft-wrapped paragraph", "first line\nsecond line", ["first line second line"]],
    ["a wrapped bullet", "- a\n  more\n- b", ["a more", "b"]],
    ["an intro line before bullets", "Intro:\n- a\n- b", ["Intro:", "a", "b"]],
    ["bullets followed by a paragraph", "- a\n\nClosing words.", ["a", "Closing words."]],
    ["CRLF line endings", "One.\r\n\r\n- a\r\n- b\r\n", ["One.", "a", "b"]],
    ["padding around items", "  \n-    spaced out   \n\n   padded   ", ["spaced out", "padded"]],
    ["a minus sign that is not a bullet", "-5 degrees at night", ["-5 degrees at night"]],
    ["emphasis that is not a bullet", "**bold** claim", ["**bold** claim"]],
    ["a decimal that is not a numbered item", "1.5 litres daily", ["1.5 litres daily"]],
    ["a marker without text", "- \n- x\n2. ", ["x"]],
  ])("handles %s", (_name, notes, facts) => {
    expect(proseToFacts(notes)).toStrictEqual({ facts, truncated: 0 });
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", " \n\n \t \n"],
  ])("returns no facts for %s", (_name, notes) => {
    expect(proseToFacts(notes)).toStrictEqual({ facts: [], truncated: 0 });
  });

  it("cuts a fact over 500 characters to exactly 500, ending with an ellipsis", () => {
    const { facts, truncated } = proseToFacts(`- ${"x".repeat(600)}`);
    expect(truncated).toBe(1);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toHaveLength(500);
    expect(facts[0]).toBe(`${"x".repeat(499)}…`);
  });

  it("leaves facts of exactly the limit alone and cuts one character more", () => {
    expect(proseToFacts("y".repeat(500))).toStrictEqual({ facts: ["y".repeat(500)], truncated: 0 });
    expect(proseToFacts("y".repeat(501))).toStrictEqual({
      facts: [`${"y".repeat(499)}…`],
      truncated: 1,
    });
  });

  it("measures the limit on the trimmed item, not on its marker or padding", () => {
    const body = "z".repeat(500);
    expect(proseToFacts(`-   ${body}   `)).toStrictEqual({ facts: [body], truncated: 0 });
  });

  it("honours a custom limit", () => {
    expect(proseToFacts("abcdefghij", 5)).toStrictEqual({ facts: ["abcd…"], truncated: 1 });
    expect(proseToFacts("abcde", 5)).toStrictEqual({ facts: ["abcde"], truncated: 0 });
    expect(proseToFacts("abcdef", 1)).toStrictEqual({ facts: ["…"], truncated: 1 });
  });

  it("counts every fact it had to cut", () => {
    const notes = `- ${"a".repeat(30)}\n- short\n- ${"b".repeat(40)}\n\n${"c".repeat(10)}`;
    expect(proseToFacts(notes, 20)).toStrictEqual({
      facts: [`${"a".repeat(19)}…`, "short", `${"b".repeat(19)}…`, "c".repeat(10)],
      truncated: 2,
    });
  });

  it("never cuts a surrogate pair in half", () => {
    const { facts, truncated } = proseToFacts(`${"a".repeat(498)}😀😀`);
    expect(truncated).toBe(1);
    // With the `u` flag a lone surrogate is matched as a code point of its own.
    expect(/\p{Surrogate}/u.test(facts[0] ?? "")).toBe(false);
    expect(facts[0]?.length).toBeLessThanOrEqual(500);
    expect(facts[0]?.endsWith("…")).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects the limit %s", (max) => {
    expect(() => proseToFacts("a", max)).toThrow(RangeError);
  });
});

describe("factsToProse", () => {
  it("writes one bullet per line", () => {
    expect(factsToProse(["a", "b"])).toBe("- a\n- b");
  });

  it("returns an empty string for no facts", () => {
    expect(factsToProse([])).toBe("");
  });

  it("keeps each fact on a single line and skips blank ones", () => {
    expect(factsToProse(["  first\nwrapped  ", "", " \n ", "second\r\n\r\nthird"])).toBe(
      "- first wrapped\n- second third",
    );
  });

  it("round-trips through proseToFacts", () => {
    const facts = [
      "Lives in Gdańsk.",
      "Prefers short answers",
      "Birthday: 3 May",
      "2024. was a good year",
    ];
    expect(proseToFacts(factsToProse(facts))).toStrictEqual({ facts, truncated: 0 });
  });
});
