import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Item,
  type MoveReport,
  renderReportMarkdown,
  renderReportTerminal,
  writeReportFile,
} from "../../src/core/report.js";

const ESC = "\u001b";

const reportWith = (overrides: Partial<MoveReport> = {}): MoveReport => ({
  source: { app: "source-app", agent: "Ada" },
  target: { app: "target-app", agent: "Ada" },
  outcome: "done",
  moved: [],
  approximated: [],
  skipped: [],
  warnings: [],
  ...overrides,
});

const MOVED: Item[] = [
  { field: "instructions", detail: "Copied verbatim" },
  { field: "skill:triage", detail: "3 files" },
];
const APPROXIMATED: Item[] = [
  { field: "routine:Morning digest", detail: "Cron 0 8 * * 1-5 became a daily 08:00 schedule" },
];
const SKIPPED: Item[] = [{ field: "memory.facts", detail: "The target has no long-term memory" }];

const FULL: MoveReport = reportWith({
  outcome: "handoff",
  nextStep: "Open target-app and import move.jetpack from the Downloads folder.",
  moved: MOVED,
  approximated: APPROXIMATED,
  skipped: SKIPPED,
  warnings: ["The target app was not running, so the bundle was only written to disk."],
});

// Makes the escape character visible so a snapshot shows exactly which codes are emitted.
const visible = (text: string) => text.replaceAll(ESC, "<ESC>");

describe("renderReportMarkdown", () => {
  it("renders the full layout for a handoff", () => {
    expect(renderReportMarkdown(FULL)).toMatchInlineSnapshot(`
      "# Move report

      **Next step:** Open target-app and import move.jetpack from the Downloads folder.

      **Source:** source-app / Ada

      **Target:** target-app / Ada

      **Outcome:** handoff

      ## Moved

      - **instructions** — Copied verbatim
      - **skill:triage** — 3 files

      ## Approximated

      - **routine:Morning digest** — Cron 0 8 * * 1-5 became a daily 08:00 schedule

      ## Skipped

      - **memory.facts** — The target has no long-term memory

      ## Warnings

      - The target app was not running, so the bundle was only written to disk.
      "
    `);
  });

  it("has the Moved, Approximated, Skipped and Warnings sections in that order", () => {
    const headings = renderReportMarkdown(FULL)
      .split("\n")
      .filter((line) => line.startsWith("#"));
    expect(headings).toEqual([
      "# Move report",
      "## Moved",
      "## Approximated",
      "## Skipped",
      "## Warnings",
    ]);
  });

  it("renders an empty section as the single line _nothing_", () => {
    expect(renderReportMarkdown(reportWith())).toMatchInlineSnapshot(`
      "# Move report

      **Source:** source-app / Ada

      **Target:** target-app / Ada

      **Outcome:** done

      ## Moved

      _nothing_

      ## Approximated

      _nothing_

      ## Skipped

      _nothing_

      ## Warnings

      _nothing_
      "
    `);
  });

  it("only empties the sections that have no entries", () => {
    const md = renderReportMarkdown(reportWith({ skipped: SKIPPED }));
    expect(md).toContain("## Moved\n\n_nothing_\n\n## Approximated");
    expect(md).toContain("## Skipped\n\n- **memory.facts** — The target has no long-term memory\n");
    expect(md).toContain("## Warnings\n\n_nothing_\n");
  });

  it("puts the next step on top, directly after the H1, for a handoff", () => {
    const lines = renderReportMarkdown(FULL).split("\n");
    expect(lines[0]).toBe("# Move report");
    expect(lines.slice(1, 3)).toEqual([
      "",
      "**Next step:** Open target-app and import move.jetpack from the Downloads folder.",
    ]);
    expect(lines.indexOf("**Source:** source-app / Ada")).toBeGreaterThan(2);
  });

  it("has no next step when the report has none", () => {
    expect(renderReportMarkdown(reportWith({ outcome: "handoff" }))).not.toContain("Next step");
    expect(renderReportMarkdown(reportWith({ outcome: "done" }))).not.toContain("Next step");
  });

  it("omits the target when the report has none", () => {
    const md = renderReportMarkdown(reportWith({ target: undefined, outcome: "exported" }));
    expect(md).not.toContain("**Target:**");
    expect(md).toContain("**Source:** source-app / Ada");
    expect(md).toContain("**Outcome:** exported");
  });

  it("names only the app when the target has no agent yet", () => {
    const md = renderReportMarkdown(reportWith({ target: { app: "target-app" } }));
    expect(md).toContain("\n**Target:** target-app\n");
  });

  it("keeps free-form field labels as they are", () => {
    const md = renderReportMarkdown(
      reportWith({
        moved: [
          { field: "memory.facts", detail: "12 facts" },
          { field: "routine:Morning digest", detail: "daily" },
          { field: "anything at all", detail: "x" },
        ],
      }),
    );
    expect(md).toContain("- **memory.facts** — 12 facts\n");
    expect(md).toContain("- **routine:Morning digest** — daily\n");
    expect(md).toContain("- **anything at all** — x\n");
  });

  it("keeps every entry on one line so text cannot forge a section", () => {
    const md = renderReportMarkdown(
      reportWith({
        moved: [{ field: "note:a\nb", detail: "first\n\n## Skipped\n- **fake** — entry" }],
        warnings: ["line one\r\nline two"],
      }),
    );
    expect(md.match(/^## /gm)).toHaveLength(4);
    expect(md).toContain("- **note:a b** — first ## Skipped - **fake** — entry\n");
    expect(md).toContain("- line one line two\n");
  });

  it("drops control characters from every string", () => {
    const md = renderReportMarkdown(
      reportWith({
        source: { app: `source${ESC}[2Japp`, agent: "Ada\u0007" },
        moved: [{ field: `a${ESC}[31mb`, detail: "c\u0000d" }],
      }),
    );
    expect(md).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  });
});

describe("renderReportTerminal", () => {
  it("renders plain text with two-space-indented dash items", () => {
    expect(renderReportTerminal(FULL, { color: false })).toMatchInlineSnapshot(`
      "Move report
      Next step: Open target-app and import move.jetpack from the Downloads folder.
      Source: source-app / Ada
      Target: target-app / Ada
      Outcome: handoff

      Moved
        - instructions — Copied verbatim
        - skill:triage — 3 files

      Approximated
        - routine:Morning digest — Cron 0 8 * * 1-5 became a daily 08:00 schedule

      Skipped
        - memory.facts — The target has no long-term memory

      Warnings
        - The target app was not running, so the bundle was only written to disk."
    `);
  });

  it("marks an empty section and leaves out the target and next step when absent", () => {
    expect(
      renderReportTerminal(reportWith({ target: undefined, outcome: "exported" }), {
        color: false,
      }),
    ).toMatchInlineSnapshot(`
      "Move report
      Source: source-app / Ada
      Outcome: exported

      Moved
        (nothing)

      Approximated
        (nothing)

      Skipped
        (nothing)

      Warnings
        (nothing)"
    `);
  });

  it("bolds the section titles and makes skipped items yellow when color is on", () => {
    expect(visible(renderReportTerminal(FULL, { color: true }))).toMatchInlineSnapshot(`
      "Move report
      Next step: Open target-app and import move.jetpack from the Downloads folder.
      Source: source-app / Ada
      Target: target-app / Ada
      Outcome: handoff

      <ESC>[1mMoved<ESC>[0m
        - instructions — Copied verbatim
        - skill:triage — 3 files

      <ESC>[1mApproximated<ESC>[0m
        - routine:Morning digest — Cron 0 8 * * 1-5 became a daily 08:00 schedule

      <ESC>[1mSkipped<ESC>[0m
        <ESC>[33m- memory.facts — The target has no long-term memory<ESC>[0m

      <ESC>[1mWarnings<ESC>[0m
        - The target app was not running, so the bundle was only written to disk."
    `);
  });

  it("carries the same text with and without color", () => {
    const stripped = renderReportTerminal(FULL, { color: true }).replaceAll(
      new RegExp(`${ESC}\\[\\d+m`, "g"),
      "",
    );
    expect(stripped).toBe(renderReportTerminal(FULL, { color: false }));
  });

  it("emits no ANSI escape code at all without color, whatever the text holds", () => {
    const hostile = reportWith({
      source: { app: `source${ESC}[31m`, agent: "Ada" },
      moved: [{ field: `a${ESC}]0;title\u0007`, detail: `b${ESC}[2J` }],
      skipped: [{ field: "c", detail: `${ESC}[33md` }],
      warnings: [`${ESC}[1me`],
    });
    expect(renderReportTerminal(hostile, { color: false })).not.toContain(ESC);
  });

  it("keeps hostile text from adding escape codes when color is on", () => {
    const out = renderReportTerminal(
      reportWith({ skipped: [{ field: "c", detail: `${ESC}[2Jd` }] }),
      { color: true },
    );
    // Four section titles (bold + reset) and one skipped item (yellow + reset): ten codes.
    expect(out.match(new RegExp(ESC, "g"))).toHaveLength(10);
  });

  describe("default color", () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

    const setIsTTY = (value: boolean | undefined) =>
      Object.defineProperty(process.stdout, "isTTY", { value, configurable: true, writable: true });

    afterEach(() => {
      if (original) Object.defineProperty(process.stdout, "isTTY", original);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    });

    it("is on when stdout is a TTY", () => {
      setIsTTY(true);
      expect(renderReportTerminal(FULL)).toContain(`${ESC}[1mMoved${ESC}[0m`);
    });

    it("is off when stdout is not a TTY", () => {
      setIsTTY(false);
      expect(renderReportTerminal(FULL)).not.toContain(ESC);
      setIsTTY(undefined);
      expect(renderReportTerminal(FULL)).not.toContain(ESC);
    });

    it("is overridden by an explicit color option", () => {
      setIsTTY(true);
      expect(renderReportTerminal(FULL, { color: false })).not.toContain(ESC);
      setIsTTY(false);
      expect(renderReportTerminal(FULL, { color: true })).toContain(ESC);
    });
  });
});

describe("writeReportFile", () => {
  const roots: string[] = [];
  const tempRoot = async () => {
    const root = await mkdtemp(join(tmpdir(), "openteleport-report-"));
    roots.push(root);
    return root;
  };

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("writes <dir>/move-report.md and returns its absolute path", async () => {
    const root = await tempRoot();
    const path = await writeReportFile(FULL, root);
    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(join(root, "move-report.md"));
    expect(await readFile(path, "utf8")).toBe(renderReportMarkdown(FULL));
  });

  it("creates the directory, with its parents, when it is missing", async () => {
    const root = await tempRoot();
    const path = await writeReportFile(FULL, join(root, "out", "reports"));
    expect(path).toBe(join(root, "out", "reports", "move-report.md"));
    expect(await readFile(path, "utf8")).toBe(renderReportMarkdown(FULL));
  });

  it("replaces the report of an earlier move", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "move-report.md"), "stale");
    const path = await writeReportFile(reportWith(), root);
    expect(await readFile(path, "utf8")).toBe(renderReportMarkdown(reportWith()));
  });
});
