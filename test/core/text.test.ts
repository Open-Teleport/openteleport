import { describe, expect, it } from "vitest";
import {
  byCodeUnit,
  errorLine,
  factsToProse,
  mergeInstructions,
  oneLine,
  plural,
  proseToFacts,
  slugify,
  splitInstructions,
  truncate,
  withoutMark,
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

describe("byCodeUnit", () => {
  it("orders by UTF-16 code unit, whatever the locale: capitals before small letters", () => {
    expect(["b", "a", "B", "_", "ä", "A", "Z", "z"].sort(byCodeUnit)).toEqual([
      "A",
      "B",
      "Z",
      "_",
      "a",
      "b",
      "z",
      "ä",
    ]);
  });

  it("is 0 for equal strings", () => {
    expect(byCodeUnit("same", "same")).toBe(0);
  });
});

describe("slugify", () => {
  it.each([
    ["Ada Lovelace", "ada-lovelace"],
    ["  Ada --  Lovelace!! ", "ada-lovelace"],
    ["Web_Brief v2", "web-brief-v2"],
    ["already-a-slug", "already-a-slug"],
    ["2026 plan", "2026-plan"],
  ])("makes %j into %j", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it("cuts to 64 characters and does not end in a dash", () => {
    const slug = slugify(`${"a".repeat(63)} b`);

    expect(slug).toBe("a".repeat(63));
    expect(slugify("x".repeat(100))).toHaveLength(64);
  });

  it("cuts to the length it is given", () => {
    expect(slugify("hermes profile name", { maxChars: 7 })).toBe("hermes");
    expect(slugify("abcdefghij", { maxChars: 4 })).toBe("abcd");
  });

  it("is empty for a name with no letter or digit, or the fallback", () => {
    expect(slugify("")).toBe("");
    expect(slugify("---")).toBe("");
    expect(slugify("Łódź", {})).toBe("d");
    expect(slugify("***", { fallback: "agent" })).toBe("agent");
    expect(slugify("Ada", { fallback: "agent" })).toBe("ada");
  });

  it("leaves accents as characters outside a-z unless it folds them", () => {
    expect(slugify("Zażółć gęślą jaźń")).toBe("za-g-l-ja");
    expect(slugify("Zażółć gęślą jaźń", { fold: true })).toBe("zazolc-gesla-jazn");
    expect(slugify("Łukasz Ñandú", { fold: true })).toBe("lukasz-nandu");
  });

  it.each(["con", "NUL", "Aux", "com1", "lpt9"])("puts the suffix after the device name %s", (name) => {
    expect(slugify(name, { deviceSuffix: "-r" })).toBe(`${name.toLowerCase()}-r`);
    expect(slugify(name, { deviceSuffix: "-agent" })).toBe(`${name.toLowerCase()}-agent`);
  });

  it("leaves a device name alone without a suffix, and any other name with one", () => {
    expect(slugify("con")).toBe("con");
    expect(slugify("console", { deviceSuffix: "-r" })).toBe("console");
    expect(slugify("con.txt", { deviceSuffix: "-r" })).toBe("con-txt");
  });

  it("gives the fallback, not the suffix, for nothing usable", () => {
    expect(slugify("", { fallback: "agent", deviceSuffix: "-r" })).toBe("agent");
  });
});

describe("truncate", () => {
  it("leaves a text of at most max characters alone", () => {
    expect(truncate("Ada", 3)).toBe("Ada");
    expect(truncate("", 1)).toBe("");
  });

  it("cuts to max characters, the last one an ellipsis", () => {
    expect(truncate("Reviews pull requests", 10)).toBe("Reviews p\u2026");
    expect(truncate("Reviews pull requests", 10)).toHaveLength(10);
  });
});

describe("oneLine", () => {
  it("turns every run of whitespace and control characters into one space", () => {
    expect(oneLine("  Ada\r\n\tLovelace \u0007 wrote\n\nnotes ")).toBe("Ada Lovelace wrote notes");
  });

  it("is empty for a text with nothing in it", () => {
    expect(oneLine(" \n\t ")).toBe("");
  });
});

describe("plural", () => {
  it("counts in the singular for 1 and the plural for anything else", () => {
    expect(plural(1, "skill")).toBe("1 skill");
    expect(plural(0, "skill")).toBe("0 skills");
    expect(plural(3, "skill")).toBe("3 skills");
  });

  it("takes the plural it is given when the word with an s is not it", () => {
    expect(plural(1, "memory entry", "memory entries")).toBe("1 memory entry");
    expect(plural(2, "memory entry", "memory entries")).toBe("2 memory entries");
  });
});

describe("withoutMark", () => {
  it("drops one byte order mark at the start", () => {
    expect(withoutMark("\uFEFF# Persona")).toBe("# Persona");
    expect(withoutMark("\uFEFF\uFEFFx")).toBe("\uFEFFx");
  });

  it("leaves a text without one, or with one inside, alone", () => {
    expect(withoutMark("# Persona")).toBe("# Persona");
    expect(withoutMark("a\uFEFFb")).toBe("a\uFEFFb");
    expect(withoutMark("")).toBe("");
  });
});

describe("errorLine", () => {
  it("is the first line of the message of an error, trimmed", () => {
    expect(errorLine(new Error("  Unexpected token at line 2: \n\nname: [x\n      ^"))).toBe(
      "Unexpected token at line 2:",
    );
    expect(errorLine(new Error("one line"))).toBe("one line");
  });

  it("is the text of anything that is not an error", () => {
    expect(errorLine("plain failure\nsecond line")).toBe("plain failure");
    expect(errorLine(404)).toBe("404");
    expect(errorLine(undefined)).toBe("undefined");
  });

  it("is empty for an error with no message", () => {
    expect(errorLine(new Error(""))).toBe("");
  });
});
