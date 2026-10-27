import { describe, expect, it } from "vitest";
import { MAX_TEXT_ENTRY_BYTES } from "../../src/core/paths.js";
import { type Bundle, type FileEntry, parseManifest } from "../../src/core/schema.js";
import { SECRET_PATTERNS, type SecretFinding, scanSecrets } from "../../src/core/secrets.js";

const encoder = new TextEncoder();

const MANIFEST = parseManifest({
  schemaVersion: "0.1",
  id: "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T",
  name: "Ada",
  models: [],
  capabilities: [],
});

const bundleWith = (overrides: Partial<Bundle> = {}): Bundle => ({
  manifest: MANIFEST,
  instructions: "Be brief.\n",
  skills: [],
  routines: [],
  facts: [],
  notes: [],
  files: [],
  unknownPaths: [],
  ...overrides,
});

const file = (path: string, content: string | Uint8Array): FileEntry => ({
  path,
  bytes: typeof content === "string" ? encoder.encode(content) : content,
});

// Every fake credential below is assembled from two halves, so that no complete token sits in this
// file for a secret scanner (including this project's own) to flag.
const OPENAI_KEY = "sk-" + "proj-abcdefghijklmnopqrstuvwxyz0123";
const ANTHROPIC_KEY = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789";
const GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const GITHUB_PAT = "github_pat_" + "11ABCDEFG0abcdefghij_klmnopqrstuvwxyz0123456789";
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
  "." +
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0" +
  "." +
  "dozjgNryP4J3jVmNHl0w5N_XgL0n2I_h5rU4v1b2c3d";

type Sample = { name: string; kind: string; token: string; preview: string };

/** One positive sample per pattern; the private-key rule has one per PEM header. */
const SAMPLES: Sample[] = [
  { name: "OpenAI key", kind: "openai-api-key", token: OPENAI_KEY, preview: "sk-pro…" },
  { name: "Anthropic key", kind: "anthropic-api-key", token: ANTHROPIC_KEY, preview: "sk-ant…" },
  { name: "GitHub ghp_ token", kind: "github-token", token: GITHUB_TOKEN, preview: "ghp_a1…" },
  { name: "GitHub fine-grained", kind: "github-token", token: GITHUB_PAT, preview: "github…" },
  {
    name: "Slack bot token",
    kind: "slack-token",
    token: "xoxb-" + "123456789012-1234567890123-abcdefghijklmnopqrstuvwx",
    preview: "xoxb-1…",
  },
  {
    name: "Slack user token",
    kind: "slack-token",
    token: "xoxp-" + "123456789012-123456789012-abcdefghijklmnop",
    preview: "xoxp-1…",
  },
  { name: "AWS access key", kind: "aws-access-key", token: AWS_KEY, preview: "AKIAIO…" },
  {
    name: "PEM header",
    kind: "private-key",
    token: "-----BEGIN " + "PRIVATE KEY-----",
    preview: "-----B…",
  },
  {
    name: "RSA PEM header",
    kind: "private-key",
    token: "-----BEGIN " + "RSA PRIVATE KEY-----",
    preview: "-----B…",
  },
  {
    name: "EC PEM header",
    kind: "private-key",
    token: "-----BEGIN " + "EC PRIVATE KEY-----",
    preview: "-----B…",
  },
  {
    name: "OpenSSH PEM header",
    kind: "private-key",
    token: "-----BEGIN " + "OPENSSH PRIVATE KEY-----",
    preview: "-----B…",
  },
  {
    name: "DSA PEM header",
    kind: "private-key",
    token: "-----BEGIN " + "DSA PRIVATE KEY-----",
    preview: "-----B…",
  },
  {
    name: "encrypted PEM header",
    kind: "private-key",
    token: "-----BEGIN " + "ENCRYPTED PRIVATE KEY-----",
    preview: "-----B…",
  },
  {
    name: "PGP private key block",
    kind: "private-key",
    token: "-----BEGIN " + "PGP PRIVATE KEY BLOCK-----",
    preview: "-----B…",
  },
  {
    name: "Google API key",
    kind: "google-api-key",
    token: "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
    preview: "AIzaSy…",
  },
  { name: "JWT", kind: "jwt", token: JWT, preview: "eyJhbG…" },
  {
    name: "bearer token",
    kind: "bearer-token",
    token: "Bearer " + "abcdefghijklmnopqrstuvwxyz0123456789",
    preview: "Bearer…",
  },
  {
    name: "lowercase bearer token",
    kind: "bearer-token",
    token: "bearer " + "abcdefghijklmnopqrstuvwxyz0123456789",
    preview: "bearer…",
  },
];

describe("SECRET_PATTERNS", () => {
  it("lists the kinds in the documented order", () => {
    expect(SECRET_PATTERNS.map((pattern) => pattern.kind)).toEqual([
      "openai-api-key",
      "anthropic-api-key",
      "github-token",
      "slack-token",
      "aws-access-key",
      "private-key",
      "google-api-key",
      "jwt",
      "bearer-token",
    ]);
  });

  it("has a sample for every pattern", () => {
    const covered = new Set(SAMPLES.map((sample) => sample.kind));
    expect(SECRET_PATTERNS.every((pattern) => covered.has(pattern.kind))).toBe(true);
  });

  it("keeps regexes stateless, so that repeated tests give the same answer", () => {
    for (const { regex } of SECRET_PATTERNS) {
      expect(regex.global).toBe(false);
      expect(regex.sticky).toBe(false);
    }
  });
});

describe("scanSecrets: one test per pattern", () => {
  it.each(SAMPLES)("finds a $name", ({ kind, token, preview }) => {
    const findings = scanSecrets(bundleWith({ instructions: `Be brief.\nUse ${token} here.\n` }));

    expect(findings).toStrictEqual([{ path: "AGENTS.md", line: 2, kind, preview }]);
    // The preview is a mask: six characters and an ellipsis, never the whole token.
    expect(preview).toHaveLength(7);
    expect(JSON.stringify(findings)).not.toContain(token);
  });

  it("reports an Anthropic key in the instructions without leaking it", () => {
    const instructions = `Intro line.\nSet ANTHROPIC_API_KEY=${ANTHROPIC_KEY} before you start.\n`;

    const findings = scanSecrets(bundleWith({ instructions }));

    expect(findings).toStrictEqual([
      { path: "AGENTS.md", line: 2, kind: "anthropic-api-key", preview: "sk-ant…" },
    ]);
    expect(JSON.stringify(findings)).not.toContain("api03");
  });

  it("finds nothing in plain text", () => {
    const instructions =
      "Be brief and kind.\nAlways ask before deleting. The task-123 ticket is done.\n";

    expect(scanSecrets(bundleWith({ instructions }))).toStrictEqual([]);
  });

  it("finds nothing in an empty bundle", () => {
    expect(scanSecrets(bundleWith({ instructions: "" }))).toStrictEqual([]);
  });
});

describe("scanSecrets: false positives", () => {
  const filler = (length: number): string => "a".repeat(length);

  const NEGATIVES: { rule: string; text: string }[] = [
    { rule: "sk- inside the word task-123", text: "Close task-123 today." },
    { rule: "sk- with fewer than 20 characters", text: `The id is sk-${filler(19)}.` },
    { rule: "a bare sk-ant- prefix", text: `The prefix is sk-ant- and nothing more.` },
    { rule: "ghp_ with a short body", text: `A token starts with ghp_ or ghp_${filler(10)}.` },
    { rule: "github_pat_ with a short body", text: `Prefix github_pat_${filler(10)} is too short.` },
    { rule: "xoxb- with a short body", text: "Slack tokens look like xoxb-123 or xoxp-abc." },
    { rule: "AKIA with a short body", text: `Key AKIA${"A".repeat(15)} is too short.` },
    { rule: "AKIA with a long body", text: `Key AKIA${"A".repeat(17)} is too long.` },
    { rule: "a public key header", text: "-----BEGIN " + "PUBLIC KEY-----" },
    { rule: "a certificate header", text: "-----BEGIN " + "CERTIFICATE-----" },
    { rule: "AIza with a short body", text: `Key AIza${filler(34)} is too short.` },
    {
      rule: "a JWT with two segments",
      text: "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxIn0 has no signature.",
    },
    { rule: "eyJ without a body", text: "The segments eyJ.a.b are empty." },
    { rule: "a dotted version number", text: "Released as 1.2.3 and eyJ is only a prefix." },
    { rule: "the phrase Bearer of bad news", text: "Nobody likes being the Bearer of bad news." },
    { rule: "the phrase bearer of bad news", text: "Nobody likes being the bearer of bad news." },
    { rule: "a PEM header that is not private", text: "-----BEGIN " + "PGP PUBLIC KEY BLOCK-----" },
    { rule: "a short bearer token", text: "Send Authorization: Bearer abc123 to test." },
  ];

  it.each(NEGATIVES)("ignores $rule", ({ text }) => {
    expect(scanSecrets(bundleWith({ instructions: text }))).toStrictEqual([]);
  });
});

describe("scanSecrets: tokens glued to other text", () => {
  // A gate before export prefers a false positive to a missed secret, so no pattern needs a word
  // boundary: raw JSON, logs and shell scripts put escapes and identifiers right before a token.
  const PREFIXES = ["\\n", "\\t", "\\u0020", "%3D", "KEY_"];
  const inConfig = (json: string): SecretFinding[] =>
    scanSecrets(bundleWith({ files: [file("config.json", json)] }));

  it.each(PREFIXES)("finds every kind right after %s inside a JSON string", (prefix) => {
    for (const { name, kind, token, preview } of SAMPLES) {
      expect(inConfig(`{"text":"key:${prefix}${token}"}`), `${name} after ${prefix}`).toStrictEqual([
        { path: "files/config.json", line: 1, kind, preview },
      ]);
    }
  });

  it("finds an AWS key inside an identifier, before or after it", () => {
    for (const text of [`KEY_${AWS_KEY}`, `id${AWS_KEY}`, `${AWS_KEY}_ID`, `${AWS_KEY}abc`]) {
      expect(scanSecrets(bundleWith({ instructions: text })), text).toStrictEqual([
        { path: "AGENTS.md", line: 1, kind: "aws-access-key", preview: "AKIAIO…" },
      ]);
    }
  });

  it("reports a JWT after a JSON newline escape from its first segment", () => {
    // Had the scan started at the payload (`eyJzdW…`), the first segment would be lost.
    expect(inConfig(`{"text":"key:\\n${JWT}"}`)).toStrictEqual([
      { path: "files/config.json", line: 1, kind: "jwt", preview: "eyJhbG…" },
    ]);
  });

  it("reports a JWT whose header itself contains eyJ", () => {
    const jwt = "eyJabcdef" + "eyJghijkl" + "." + "eyJzdWIiOiIxIn0" + "." + "c2lnbmF0dXJl";

    expect(inConfig(`{"text":"${jwt}"}`)).toStrictEqual([
      { path: "files/config.json", line: 1, kind: "jwt", preview: "eyJghi…" },
    ]);
  });

  it("prefers a false positive: a key that ends a longer word is reported", () => {
    expect(scanSecrets(bundleWith({ instructions: `See risk-${"a".repeat(30)}.` }))).toStrictEqual([
      { path: "AGENTS.md", line: 1, kind: "openai-api-key", preview: "sk-aaa…" },
    ]);
  });
});

describe("scanSecrets: findings per line", () => {
  it("reports each pattern once per line, in pattern order", () => {
    const instructions = `${GITHUB_TOKEN} ${OPENAI_KEY} ${GITHUB_PAT}\n`;

    expect(scanSecrets(bundleWith({ instructions }))).toStrictEqual([
      { path: "AGENTS.md", line: 1, kind: "openai-api-key", preview: "sk-pro…" },
      { path: "AGENTS.md", line: 1, kind: "github-token", preview: "ghp_a1…" },
    ]);
  });

  it("reports a bearer JWT as both a bearer token and a JWT", () => {
    const instructions = `curl -H "Authorization: Bearer ${JWT}" https://example.test\n`;

    expect(scanSecrets(bundleWith({ instructions }))).toStrictEqual([
      { path: "AGENTS.md", line: 1, kind: "jwt", preview: "eyJhbG…" },
      { path: "AGENTS.md", line: 1, kind: "bearer-token", preview: "Bearer…" },
    ]);
  });

  it("reports the same kind again on another line", () => {
    const instructions = `${OPENAI_KEY}\nnothing here\n${OPENAI_KEY}\n`;

    expect(scanSecrets(bundleWith({ instructions }))).toStrictEqual([
      { path: "AGENTS.md", line: 1, kind: "openai-api-key", preview: "sk-pro…" },
      { path: "AGENTS.md", line: 3, kind: "openai-api-key", preview: "sk-pro…" },
    ]);
  });

  it("counts lines the same way for LF, CRLF and CR endings", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const instructions = ["one", "two", `key ${OPENAI_KEY}`].join(eol);

      expect(scanSecrets(bundleWith({ instructions }))).toStrictEqual([
        { path: "AGENTS.md", line: 3, kind: "openai-api-key", preview: "sk-pro…" },
      ]);
    }
  });

  it("is deterministic across calls", () => {
    const bundle = bundleWith({ instructions: `${OPENAI_KEY}\n${AWS_KEY}\n` });

    expect(scanSecrets(bundle)).toStrictEqual(scanSecrets(bundle));
  });
});

describe("scanSecrets: where it looks", () => {
  const key = (kindToken: string) => `key ${kindToken}`;

  it("scans the persona as SOUL.md", () => {
    const persona = `You are Ada.\n\n${key(OPENAI_KEY)}\n`;

    expect(scanSecrets(bundleWith({ persona }))).toStrictEqual([
      { path: "SOUL.md", line: 3, kind: "openai-api-key", preview: "sk-pro…" },
    ]);
  });

  it("scans the manifest title and description as jetpack.json, without a line", () => {
    const manifest = parseManifest({
      ...MANIFEST,
      title: key(OPENAI_KEY),
      description: `Reach me with ${key(AWS_KEY)}`,
    });

    expect(scanSecrets(bundleWith({ manifest }))).toStrictEqual([
      { path: "jetpack.json", kind: "openai-api-key", preview: "sk-pro…" },
      { path: "jetpack.json", kind: "aws-access-key", preview: "AKIAIO…" },
    ]);
  });

  it("scans every file of a skill as skills/<skill>/<file>", () => {
    const skills = [
      {
        name: "triage",
        files: [
          file("SKILL.md", `# Triage\n\n${key(OPENAI_KEY)}\n`),
          file("scripts/run.sh", `#!/bin/sh\nexport TOKEN=${GITHUB_TOKEN}\n`),
          file("references/clean.md", "Nothing to see.\n"),
        ],
      },
      { name: "other", files: [file("SKILL.md", `${AWS_KEY}\n`)] },
    ];

    expect(scanSecrets(bundleWith({ skills }))).toStrictEqual([
      { path: "skills/triage/SKILL.md", line: 3, kind: "openai-api-key", preview: "sk-pro…" },
      { path: "skills/triage/scripts/run.sh", line: 2, kind: "github-token", preview: "ghp_a1…" },
      { path: "skills/other/SKILL.md", line: 1, kind: "aws-access-key", preview: "AKIAIO…" },
    ]);
  });

  it("scans the instruction of a routine as routines/<name>.json, without a line", () => {
    const routines: Bundle["routines"] = [
      {
        name: "Morning digest",
        instruction: `Summarise my inbox.\nLog in with ${key(OPENAI_KEY)}`,
        enabled: true,
        timezone: "Europe/Warsaw",
        schedule: { kind: "cron", expression: "0 8 * * *" },
      },
    ];

    expect(scanSecrets(bundleWith({ routines }))).toStrictEqual([
      { path: "routines/Morning digest.json", kind: "openai-api-key", preview: "sk-pro…" },
    ]);
  });

  it("reports a fact as MEMORY.md with its 1-based position in the facts", () => {
    const facts = ["Likes tea", `Staging login is ${key(OPENAI_KEY)}`, "Lives in Krakow"];

    expect(scanSecrets(bundleWith({ facts }))).toStrictEqual([
      { path: "MEMORY.md", line: 2, kind: "openai-api-key", preview: "sk-pro…" },
    ]);
  });

  it("reports the MEMORY-prose note as MEMORY.md, without a line", () => {
    const notes = [{ name: "MEMORY-prose", text: `Intro.\n${key(GITHUB_TOKEN)}\n` }];

    expect(scanSecrets(bundleWith({ notes }))).toStrictEqual([
      { path: "MEMORY.md", kind: "github-token", preview: "ghp_a1…" },
    ]);
  });

  it("reports any other note as memory/<name>.md with its line", () => {
    const notes = [
      { name: "projects", text: `Alpha\n${key(AWS_KEY)}\n` },
      { name: "clean", text: "Nothing here.\n" },
    ];

    expect(scanSecrets(bundleWith({ notes }))).toStrictEqual([
      { path: "memory/projects.md", line: 2, kind: "aws-access-key", preview: "AKIAIO…" },
    ]);
  });

  it("scans files as files/<path>, counting CRLF lines", () => {
    const files = [
      file("docs/setup.txt", `first\r\nsecond\r\n${key(OPENAI_KEY)}\r\n`),
      file("notes.md", "No secrets.\n"),
    ];

    expect(scanSecrets(bundleWith({ files }))).toStrictEqual([
      { path: "files/docs/setup.txt", line: 3, kind: "openai-api-key", preview: "sk-pro…" },
    ]);
  });

  it("reports in layout order: manifest, instructions, persona, skills, routines, memory, notes, files", () => {
    const bundle = bundleWith({
      manifest: parseManifest({ ...MANIFEST, title: OPENAI_KEY }),
      instructions: AWS_KEY,
      persona: GITHUB_TOKEN,
      skills: [{ name: "s", files: [file("SKILL.md", ANTHROPIC_KEY)] }],
      routines: [
        {
          name: "r",
          instruction: JWT,
          enabled: false,
          timezone: "UTC",
          schedule: { kind: "every", every: "1h" },
        },
      ],
      facts: [OPENAI_KEY],
      notes: [
        { name: "extra", text: AWS_KEY },
        { name: "MEMORY-prose", text: GITHUB_PAT },
      ],
      files: [file("a.txt", ANTHROPIC_KEY)],
    });

    const order = scanSecrets(bundle).map((finding) => finding.path);

    expect(order).toEqual([
      "jetpack.json",
      "AGENTS.md",
      "SOUL.md",
      "skills/s/SKILL.md",
      "routines/r.json",
      "MEMORY.md",
      "MEMORY.md",
      "memory/extra.md",
      "files/a.txt",
    ]);
  });
});

describe("scanSecrets: binary and large files", () => {
  const padded = (size: number, token: string): Uint8Array => {
    const bytes = new Uint8Array(size).fill(0x20);
    bytes.set(encoder.encode(token), 0);
    return bytes;
  };

  const finding = (path: string): SecretFinding => ({
    path,
    line: 1,
    kind: "openai-api-key",
    preview: "sk-pro…",
  });

  it("skips a file with a NUL byte in the first 8 KB", () => {
    const bytes = padded(9000, OPENAI_KEY);
    bytes[8191] = 0;

    expect(scanSecrets(bundleWith({ files: [file("blob.bin", bytes)] }))).toStrictEqual([]);
  });

  it("skips a file that starts with a NUL byte", () => {
    const bytes = padded(64, OPENAI_KEY);
    bytes[0] = 0;

    expect(scanSecrets(bundleWith({ files: [file("blob.bin", bytes)] }))).toStrictEqual([]);
  });

  it("scans a file whose first NUL byte comes after the first 8 KB", () => {
    const bytes = padded(9000, OPENAI_KEY);
    bytes[8192] = 0;

    expect(scanSecrets(bundleWith({ files: [file("late-nul.txt", bytes)] }))).toStrictEqual([
      finding("files/late-nul.txt"),
    ]);
  });

  it("skips binary skill files the same way", () => {
    const bytes = padded(64, OPENAI_KEY);
    bytes[10] = 0;
    const skills = [{ name: "s", files: [file("SKILL.md", "ok\n"), file("tool.bin", bytes)] }];

    expect(scanSecrets(bundleWith({ skills }))).toStrictEqual([]);
  });

  it("skips a file over the text-entry limit", () => {
    const bytes = padded(MAX_TEXT_ENTRY_BYTES + 1, OPENAI_KEY);

    expect(scanSecrets(bundleWith({ files: [file("huge.txt", bytes)] }))).toStrictEqual([]);
  });

  it("scans a file of exactly the text-entry limit", () => {
    const bytes = padded(MAX_TEXT_ENTRY_BYTES, OPENAI_KEY);

    expect(scanSecrets(bundleWith({ files: [file("edge.txt", bytes)] }))).toStrictEqual([
      finding("files/edge.txt"),
    ]);
  });

  it("still scans text that is not valid UTF-8", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x20, ...encoder.encode(OPENAI_KEY)]);

    expect(scanSecrets(bundleWith({ files: [file("latin1.txt", bytes)] }))).toStrictEqual([
      finding("files/latin1.txt"),
    ]);
  });

  it("scans an empty file without a finding", () => {
    expect(scanSecrets(bundleWith({ files: [file("empty.txt", "")] }))).toStrictEqual([]);
  });
});

describe("scanSecrets: hostile input", () => {
  const timed = (text: string): SecretFinding[] => {
    const started = performance.now();
    const findings = scanSecrets(bundleWith({ files: [file("hostile.txt", text)] }));
    expect(performance.now() - started).toBeLessThan(2000);
    return findings;
  };

  it("stays fast on a long line of repeated prefixes", () => {
    const units = [
      ...["eyJ", "eyJ_", "eyJ-", "eyJ.", "eyJa.", "eyJa.b.", "eyJ1.", "eyJa.b"],
      ...["sk-", "sk-ant-", "Bearer ", "bearer ", "AIza", "xoxb-", "ghp_", "github_pat_", "AKIA"],
      ...["-----BEGIN ", "-----BEGIN A ", "-----BEGIN A PRIVATE ", "PRIVATE KEY-----"],
    ];
    for (const unit of units) timed(unit.repeat(Math.floor(100_000 / unit.length)));
  });

  it("stays fast on one long list of PEM header words", () => {
    timed("-----BEGIN " + "A ".repeat(500_000));
  });

  it("stays fast on one long run of token characters", () => {
    expect(timed("eyJ" + "a".repeat(1_000_000))).toStrictEqual([]);
    expect(timed("sk-ant-" + "a".repeat(1_000_000))).toHaveLength(1);
  });
});
