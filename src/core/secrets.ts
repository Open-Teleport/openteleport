import { MAX_TEXT_ENTRY_BYTES } from "./paths.js";
import type { Bundle, FileEntry } from "./schema.js";

/** Where a secret was found. `line` is 1-based and present only where the text is line-oriented. */
export type SecretFinding = {
  path: string;
  line?: number;
  kind: string;
  /** The first six characters of the match and an ellipsis: enough to recognise it, never all of it. */
  preview: string;
};

export type SecretPattern = { kind: string; regex: RegExp };

// This is the gate before a bundle leaves the machine, so it prefers a false positive to a missed
// secret, but not at any price: export stops on any finding, and ordinary kebab-case prose such as
// `task-management-dashboard-component` must not stop it.
//
// The six patterns that start with a fixed prefix therefore begin with one shared boundary. It
// rejects a prefix glued to a letter or digit (`task-...`, `risk-...`) and allows everything else
// that can sit in front of a token in raw text: `_` and `-` (`KEY_sk-...`), `=`, `:`, quotes,
// whitespace, a JSON escape (a backslash and one of `n r t b f`, or `\u` and four hex digits) and
// a percent escape (`%3D`). A token glued directly to a letter or digit (`keysk-...`) is the one
// accepted miss.
//
// None of the regexes is global or sticky, so they keep no state between calls, and none
// backtracks over more than the run of token characters it is in. The JWT pattern needs care for
// that: its first segment may not run into another `eyJ`, so a long run of token characters is
// read once, not once per `eyJ` inside it. (A header that itself contains `eyJ` is matched from
// that inner `eyJ`: the finding is still reported.)
const TOKEN_BOUNDARY =
  /(?:(?<![A-Za-z0-9])|(?<=\\[nrtbf])|(?<=\\u[0-9A-Fa-f]{4})|(?<=%[0-9A-Fa-f]{2}))/.source;

const afterBoundary = (pattern: RegExp): RegExp => new RegExp(TOKEN_BOUNDARY + pattern.source);

/**
 * What counts as a credential, in the order findings are reported. A line that matches several
 * patterns reports each of them once. `sk-` takes 20 or more characters from the key alphabet;
 * the Anthropic prefix `sk-ant-` is told apart from the generic one by lookahead, and the
 * boundary keeps an `sk-` inside an Anthropic key's body from reporting again, so one key never
 * reports twice. A private key is any PEM `... PRIVATE KEY` header (`RSA`, `EC`, `DSA`,
 * `OPENSSH`, `ENCRYPTED`, `PGP ... BLOCK`). The `Bearer` scheme may start with either case.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: "openai-api-key", regex: afterBoundary(/sk-(?!ant-)[A-Za-z0-9_-]{20,}/) },
  { kind: "anthropic-api-key", regex: afterBoundary(/sk-(?=ant-)[A-Za-z0-9_-]{20,}/) },
  {
    kind: "github-token",
    regex: afterBoundary(/(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/),
  },
  { kind: "slack-token", regex: afterBoundary(/xox[bp]-[A-Za-z0-9-]{10,}/) },
  { kind: "aws-access-key", regex: afterBoundary(/AKIA[0-9A-Z]{16}(?![0-9A-Z])/) },
  { kind: "private-key", regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "google-api-key", regex: afterBoundary(/AIza[0-9A-Za-z_-]{35}/) },
  {
    kind: "jwt",
    regex: /eyJ(?:(?!eyJ)[A-Za-z0-9_-])+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  },
  { kind: "bearer-token", regex: /[Bb]earer [A-Za-z0-9._-]{20,}/ },
];

const PREVIEW_CHARS = 6;

/** A file is binary when a NUL byte shows up in this many leading bytes. */
const BINARY_SNIFF_BYTES = 8 * 1024;

// The note that carries the lines of `MEMORY.md` that are not facts; see `bundle.ts`.
const MEMORY_PROSE_NOTE = "MEMORY-prose";

const LINE_BREAK = /\r\n|\r|\n/;

// Decoding never throws: bytes that are not UTF-8 become U+FFFD and the rest is still scanned.
const decoder = new TextDecoder("utf-8", { fatal: false });

type Hit = Pick<SecretFinding, "kind" | "preview">;

/** The first match of every pattern in `text`, in pattern order. */
function findHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const { kind, regex } of SECRET_PATTERNS) {
    const match = regex.exec(text);
    if (match !== null) hits.push({ kind, preview: `${match[0].slice(0, PREVIEW_CHARS)}…` });
  }
  return hits;
}

/** Scans `text` line by line; each pattern is reported once per line, with its line number. */
function scanLines(path: string, text: string, findings: SecretFinding[]): void {
  text.split(LINE_BREAK).forEach((line, index) => {
    for (const hit of findHits(line)) findings.push({ path, line: index + 1, ...hit });
  });
}

/** Scans `text` as a whole; each pattern is reported once, without a line number. */
function scanWhole(path: string, text: string, findings: SecretFinding[]): void {
  for (const hit of findHits(text)) findings.push({ path, ...hit });
}

/** Too large to scan: over the text-entry limit. */
const isTooLarge = ({ bytes }: FileEntry): boolean => bytes.byteLength > MAX_TEXT_ENTRY_BYTES;

/** Scans a file's bytes as UTF-8 text, unless it is too large or looks binary. */
function scanFile(path: string, entry: FileEntry, findings: SecretFinding[]): void {
  const { bytes } = entry;
  if (isTooLarge(entry)) return;
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return;
  scanLines(path, decoder.decode(bytes), findings);
}

/** `text` with every match of every pattern cut to its preview, so that it can be shown. */
function masked(text: string): string {
  let shown = text;
  for (const { regex } of SECRET_PATTERNS) {
    const every = new RegExp(regex.source, `${regex.flags}g`);
    shown = shown.replace(every, (match) => `${match.slice(0, PREVIEW_CHARS)}…`);
  }
  return shown;
}

/**
 * Looks for credentials in everything a Bundle would write out: the manifest's `name`, `title`,
 * `description` and every `x-<vendor>` value (as its JSON), the instructions and persona, skills,
 * routine names and instructions, memory and the extra files. Findings come in that order, with
 * `path` as it would appear in an archive; a routine is `routines/<name>.json`, with any match in
 * the name cut to its preview, so that a path never shows a secret either.
 *
 * Files over the text-entry limit (see `unscannedFiles`) and files with a NUL byte in their first
 * 8 KB are skipped without a finding, as are the avatar and the names of paths. A pure function:
 * it reads nothing but its argument and keeps nothing between calls.
 */
export function scanSecrets(bundle: Bundle): SecretFinding[] {
  const findings: SecretFinding[] = [];

  const { name, title, description } = bundle.manifest;
  scanWhole("jetpack.json", name, findings);
  if (title !== undefined) scanWhole("jetpack.json", title, findings);
  if (description !== undefined) scanWhole("jetpack.json", description, findings);
  for (const [key, value] of Object.entries(bundle.manifest)) {
    if (!key.startsWith("x-")) continue;
    // JSON escapes a line break as `\n`, which the token boundary allows before a token.
    const json = JSON.stringify(value);
    if (json !== undefined) scanWhole("jetpack.json", json, findings);
  }

  scanLines("AGENTS.md", bundle.instructions, findings);
  if (bundle.persona !== undefined) scanLines("SOUL.md", bundle.persona, findings);

  for (const skill of bundle.skills) {
    for (const entry of skill.files) {
      scanFile(`skills/${skill.name}/${entry.path}`, entry, findings);
    }
  }

  for (const routine of bundle.routines) {
    const path = `routines/${masked(routine.name)}.json`;
    scanWhole(path, routine.name, findings);
    scanWhole(path, routine.instruction, findings);
  }

  // A fact's position in `facts` is its line number: facts keep their order in `MEMORY.md`.
  bundle.facts.forEach((fact, index) => {
    for (const hit of findHits(fact)) findings.push({ path: "MEMORY.md", line: index + 1, ...hit });
  });
  for (const note of bundle.notes) {
    if (note.name === MEMORY_PROSE_NOTE) scanWhole("MEMORY.md", note.text, findings);
  }
  for (const note of bundle.notes) {
    if (note.name !== MEMORY_PROSE_NOTE) scanLines(`memory/${note.name}.md`, note.text, findings);
  }

  for (const entry of bundle.files) scanFile(`files/${entry.path}`, entry, findings);

  return findings;
}

/**
 * The skill files and files `scanSecrets` skips for their size (over the text-entry limit,
 * 2 MiB), as it would name them: what a scan without findings does not vouch for.
 */
export function unscannedFiles(bundle: Bundle): string[] {
  return [
    ...bundle.skills.flatMap((skill) =>
      skill.files.filter(isTooLarge).map((entry) => `skills/${skill.name}/${entry.path}`),
    ),
    ...bundle.files.filter(isTooLarge).map((entry) => `files/${entry.path}`),
  ];
}
