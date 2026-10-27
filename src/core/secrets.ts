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

// This is the gate before a bundle leaves the machine, so it prefers a false positive to a
// missed secret: no pattern is anchored at the start. A token glued to a JSON escape (a backslash
// and `n`), to `%3D` or to an identifier (`KEY_sk-...`) is still found, at the price of the odd
// hit such as `risk-` followed by 20 key characters. None of the regexes is global or sticky, so
// they keep no state between calls, and none backtracks over more than the run of token
// characters it is in.
//
// The JWT pattern needs care for that last point. Its first segment may not run into another
// `eyJ`, so a long run of token characters is read once, not once per `eyJ` inside it. (A header
// that itself contains `eyJ` is matched from that inner `eyJ`: the finding is still reported.)

/**
 * What counts as a credential, in the order findings are reported. A line that matches several
 * patterns reports each of them once. `sk-` takes 20 or more characters from the key alphabet;
 * the Anthropic prefix `sk-ant-` is told apart from the generic one by lookahead, so one key
 * never reports twice. A private key is any PEM `... PRIVATE KEY` header (`RSA`, `EC`, `DSA`,
 * `OPENSSH`, `ENCRYPTED`, `PGP ... BLOCK`). The `Bearer` scheme may start with either case.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: "openai-api-key", regex: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/ },
  { kind: "anthropic-api-key", regex: /sk-(?=ant-)[A-Za-z0-9_-]{20,}/ },
  { kind: "github-token", regex: /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { kind: "slack-token", regex: /xox[bp]-[A-Za-z0-9-]{10,}/ },
  { kind: "aws-access-key", regex: /AKIA[0-9A-Z]{16}(?![0-9A-Z])/ },
  { kind: "private-key", regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "google-api-key", regex: /AIza[0-9A-Za-z_-]{35}/ },
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

/** Scans a file's bytes as UTF-8 text, unless it is too large or looks binary. */
function scanFile(path: string, entry: FileEntry, findings: SecretFinding[]): void {
  const { bytes } = entry;
  if (bytes.byteLength > MAX_TEXT_ENTRY_BYTES) return;
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return;
  scanLines(path, decoder.decode(bytes), findings);
}

/**
 * Looks for credentials in everything a Bundle would write out: the manifest's `title` and
 * `description`, the instructions and persona, skills, routine instructions, memory and the
 * extra files. Findings come in that order, with `path` as it would appear in an archive.
 *
 * Files over the text-entry limit and files with a NUL byte in their first 8 KB are skipped
 * without a finding, as are the avatar and the names of paths. A pure function: it reads nothing
 * but its argument and keeps nothing between calls.
 */
export function scanSecrets(bundle: Bundle): SecretFinding[] {
  const findings: SecretFinding[] = [];

  const { title, description } = bundle.manifest;
  if (title !== undefined) scanWhole("jetpack.json", title, findings);
  if (description !== undefined) scanWhole("jetpack.json", description, findings);

  scanLines("AGENTS.md", bundle.instructions, findings);
  if (bundle.persona !== undefined) scanLines("SOUL.md", bundle.persona, findings);

  for (const skill of bundle.skills) {
    for (const entry of skill.files) {
      scanFile(`skills/${skill.name}/${entry.path}`, entry, findings);
    }
  }

  for (const routine of bundle.routines) {
    scanWhole(`routines/${routine.name}.json`, routine.instruction, findings);
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
