import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { oneLine } from "./text.js";

/** One thing the move did to a part of the agent. `field` is a free-form label, never validated. */
export type Item = { field: string; detail: string };

export type MoveReport = {
  source: { app: string; agent: string };
  /** Absent when the move only exported a bundle. */
  target?: { app: string; agent?: string };
  outcome: "done" | "handoff" | "exported";
  /** What the user still has to do. Listed first, so it is the first thing they read. */
  nextStep?: string;
  moved: Item[];
  approximated: Item[];
  skipped: Item[];
  warnings: string[];
};

/** The file `writeReportFile` creates inside the directory it is given. */
const REPORT_FILE_NAME = "move-report.md";

const ESC = "\u001b";
const BOLD = "1";
const YELLOW = "33";

// A report line is built from text the source app produced, so each string is squeezed onto one
// line first (`oneLine`): a line break could start a forged `## Skipped` section, and a control
// character (an ANSI escape included) could drive the terminal the report is printed to.

type Entry = { field?: string; detail: string };
type Block = { title: string; entries: Entry[]; skipped?: true };

function blocksOf(report: MoveReport): Block[] {
  const items = (list: Item[]): Entry[] =>
    list.map(({ field, detail }) => ({ field: oneLine(field), detail: oneLine(detail) }));
  return [
    { title: "Moved", entries: items(report.moved) },
    { title: "Approximated", entries: items(report.approximated) },
    { title: "Skipped", entries: items(report.skipped), skipped: true },
    { title: "Warnings", entries: report.warnings.map((text) => ({ detail: oneLine(text) })) },
  ];
}

/** The lines under the title, in reading order: next step, who moved where, how it ended. */
function facts(report: MoveReport): { label: string; value: string }[] {
  const party = (side: { app: string; agent?: string }) =>
    side.agent === undefined ? oneLine(side.app) : `${oneLine(side.app)} / ${oneLine(side.agent)}`;
  return [
    ...(report.nextStep === undefined
      ? []
      : [{ label: "Next step", value: oneLine(report.nextStep) }]),
    { label: "Source", value: party(report.source) },
    ...(report.target === undefined ? [] : [{ label: "Target", value: party(report.target) }]),
    { label: "Outcome", value: report.outcome },
  ];
}

/** The report as the Markdown document written to `move-report.md`. */
export function renderReportMarkdown(report: MoveReport): string {
  const entry = ({ field, detail }: Entry) =>
    field === undefined ? `- ${detail}` : `- **${field}** — ${detail}`;
  const parts = [
    "# Move report",
    ...facts(report).map(({ label, value }) => `**${label}:** ${value}`),
    ...blocksOf(report).flatMap(({ title, entries }) => [
      `## ${title}`,
      entries.length === 0 ? "_nothing_" : entries.map(entry).join("\n"),
    ]),
  ];
  return `${parts.join("\n\n")}\n`;
}

/**
 * The report as plain text for the terminal, without a trailing newline. Colors are minimal: bold
 * section titles and yellow skipped items. They default to on only when stdout is a TTY; with
 * `color: false` the text holds no ANSI escape code at all.
 */
export function renderReportTerminal(
  report: MoveReport,
  opts: { color?: boolean } = {},
): string {
  const color = opts.color ?? process.stdout.isTTY === true;
  const style = (code: string, text: string) => (color ? `${ESC}[${code}m${text}${ESC}[0m` : text);
  const line = ({ field, detail }: Entry) =>
    field === undefined ? detail : `${field} — ${detail}`;

  const head = ["Move report", ...facts(report).map(({ label, value }) => `${label}: ${value}`)];
  const blocks = blocksOf(report).map(({ title, entries, skipped }) => [
    style(BOLD, title),
    ...(entries.length === 0
      ? ["  (nothing)"]
      : entries.map((entry) => {
          const text = `- ${line(entry)}`;
          return `  ${skipped ? style(YELLOW, text) : text}`;
        })),
  ]);
  return [head, ...blocks].map((block) => block.join("\n")).join("\n\n");
}

/** Writes the Markdown report to `<dir>/move-report.md`, creating `dir` if needed. */
export async function writeReportFile(report: MoveReport, dir: string): Promise<string> {
  const path = resolve(dir, REPORT_FILE_NAME);
  await mkdir(resolve(dir), { recursive: true });
  await writeFile(path, renderReportMarkdown(report), "utf8");
  return path;
}
