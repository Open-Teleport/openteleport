import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleToEntries } from "../../src/core/bundle.js";
import {
  MAX_ARCHIVE_BYTES,
  MAX_AVATAR_BYTES,
  MAX_FILES_BYTES,
  MAX_TEXT_ENTRY_BYTES,
  isForbiddenPath,
  isSafeArchivePath,
} from "../../src/core/paths.js";
import {
  type Bundle,
  type FileEntry,
  type Routine,
  type Schedule,
  parseManifest,
} from "../../src/core/schema.js";
import {
  OPENBOT_IMPORT_MANIFEST,
  OPENBOT_TRANSFER_MANIFEST,
  type OpenBotRoutine,
  openBotModelPref,
  readOpenBotZip,
  toBundleRoutine,
  writeOpenBotImportZip,
} from "../../src/formats/openbot-zip.js";
import { zipDirectoryToFile } from "../helpers/zip.js";

const IMPORT_DIR = fileURLToPath(new URL("../fixtures/openbot/import-v1", import.meta.url));
const TRANSFER_DIR = fileURLToPath(new URL("../fixtures/openbot/transfer-v1", import.meta.url));

const ADA_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
const BO_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B3A";
const WARSAW = "Europe/Warsaw";
const WRITE_OPTS = { app: "openteleport", version: "0.2.0", includeFiles: true };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-openbot-zip-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// -- Helpers: archives to read ---------------------------------------------------------------

type Json = Record<string, unknown>;

const agentAt = (manifest: Json, index: number): Json =>
  (manifest.agents as Json[])[index] as Json;
const routineAt = (manifest: Json, agent: number, index: number): Json =>
  (agentAt(manifest, agent).routines as Json[])[index] as Json;

/** A fixture folder, zipped to a file of the temp folder. */
async function packed(dir: string, name: string): Promise<string> {
  return zipDirectoryToFile(dir, join(root, name));
}

/**
 * A copy of a fixture folder whose manifest `change` edits and to which `extraFiles` are added,
 * zipped to a file of the temp folder.
 */
async function patched(
  dir: string,
  manifestName: string,
  change: (manifest: Json) => void,
  extraFiles: Record<string, string | Uint8Array> = {},
): Promise<string> {
  const copy = await mkdtemp(join(root, "copy-"));
  await cp(dir, copy, { recursive: true });
  const manifestPath = join(copy, manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Json;
  change(manifest);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  for (const [path, content] of Object.entries(extraFiles)) {
    const target = join(copy, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return zipDirectoryToFile(copy, `${copy}.zip`);
}

/** An import manifest with one agent, `ada`, that has only the required fields. */
function minimal(change: (manifest: Json) => void = () => undefined): string {
  const manifest: Json = {
    format: "openbot-agent-import",
    version: 1,
    source: { app: "grok-bot", exportedAt: "2026-10-28T10:00:00.000Z" },
    agents: [
      {
        key: "ada",
        name: "Ada",
        title: "",
        description: "Hello.",
        avatar: null,
        skills: [],
        routines: [],
        memories: [],
        files: null,
      },
    ],
  };
  change(manifest);
  return JSON.stringify(manifest);
}

let archives = 0;
async function archiveFile(archive: Uint8Array): Promise<string> {
  archives += 1;
  const file = join(root, `archive-${archives}.zip`);
  await writeFile(file, archive);
  return file;
}

/** An archive of `files` (strings are UTF-8) beside `manifest` (`null`: none), as a file. */
async function forged(
  files: Record<string, string | Uint8Array>,
  manifest: string | null = minimal(),
): Promise<string> {
  const entries: Record<string, Uint8Array> = {};
  if (manifest !== null) entries[OPENBOT_IMPORT_MANIFEST] = strToU8(manifest);
  for (const [path, content] of Object.entries(files)) {
    entries[path] = typeof content === "string" ? strToU8(content) : content;
  }
  return archiveFile(zipSync(entries));
}

/**
 * Changes one entry of an archive without touching the rest: `claimedSize` is the uncompressed
 * size its central directory entry declares, and `breakData` damages its deflate stream so that
 * inflating it fails (block type 3 is reserved). Entries are found by name.
 */
function tamper(
  archive: Uint8Array,
  path: string,
  change: { claimedSize?: number; breakData?: boolean },
): Uint8Array {
  const data = archive.slice();
  const view = new DataView(data.buffer);
  const nameAt = (at: number, length: number) =>
    new TextDecoder().decode(data.subarray(at, at + length));
  for (let i = 0; i + 46 <= data.length; i += 1) {
    const signature = view.getUint32(i, true);
    // Central directory entry: uncompressed size at 24, name length at 28, name at 46.
    if (signature === 0x02014b50 && nameAt(i + 46, view.getUint16(i + 28, true)) === path) {
      if (change.claimedSize !== undefined) view.setUint32(i + 24, change.claimedSize, true);
    }
    // Local header: name length at 26, extra length at 28, name at 30, then the data.
    if (signature === 0x04034b50 && nameAt(i + 30, view.getUint16(i + 26, true)) === path) {
      if (change.breakData) {
        const dataAt = i + 30 + view.getUint16(i + 26, true) + view.getUint16(i + 28, true);
        data[dataAt] = 0xff;
      }
    }
  }
  return data;
}

// -- Helpers: bundles to write ---------------------------------------------------------------

function bundleOf(overrides: Partial<Bundle> = {}, name = "Ada", id = ADA_ID): Bundle {
  return {
    manifest: { schemaVersion: "0.1", id, name, models: [], capabilities: [] },
    instructions: "Be kind.",
    skills: [],
    routines: [],
    facts: [],
    notes: [],
    files: [],
    unknownPaths: [],
    ...overrides,
  };
}

function routineOf(name: string, schedule: Schedule, over: Partial<Routine> = {}): Routine {
  return { name, instruction: `Do ${name}.`, enabled: true, timezone: WARSAW, schedule, ...over };
}

/** The bundle with an id, as a move gives it one before it writes anywhere. */
const withId = (bundle: Bundle): Bundle => ({
  ...bundle,
  manifest: parseManifest({ ...bundle.manifest, id: ADA_ID }),
});

const daily: Schedule = { kind: "cron", expression: "0 9 * * *" };

const skillMd = (name: string): string =>
  `---\nname: ${name}\ndescription: Does ${name}.\n---\n\n# ${name}\n`;

const skillOf = (name: string, extra: FileEntry[] = [], markdown = skillMd(name)) => ({
  name,
  files: [{ path: "SKILL.md", bytes: strToU8(markdown) }, ...extra],
});

type Written = {
  bytes: Uint8Array;
  manifest: Json;
  agents: Json[];
  files: Record<string, Uint8Array>;
  items: ReturnType<typeof writeOpenBotImportZip>["items"];
};

function write(bundles: readonly Bundle[], opts = WRITE_OPTS): Written {
  const { bytes, items } = writeOpenBotImportZip(bundles, opts);
  const files = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8(files[OPENBOT_IMPORT_MANIFEST] as Uint8Array)) as Json;
  return { bytes, manifest, agents: manifest.agents as Json[], files, items };
}

/** The limits of the import format (the Grok Bot export skill and OpenBot's decoder). */
function expectWithinImportLimits({ manifest, agents, files }: Written): void {
  expect(manifest.format).toBe("openbot-agent-import");
  expect(manifest.version).toBe(1);
  expect(agents.length).toBeGreaterThan(0);
  const keys = new Set<string>();
  for (const agent of agents) {
    const key = agent.key as string;
    expect(key).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(keys.has(key)).toBe(false);
    keys.add(key);
    expect((agent.name as string).length).toBeGreaterThan(0);
    expect((agent.name as string).length).toBeLessThanOrEqual(80);
    expect((agent.title as string).length).toBeLessThanOrEqual(120);
    expect((agent.description as string).length).toBeLessThanOrEqual(2000);
    for (const path of [agent.avatar, agent.files, ...(agent.skills as string[])]) {
      if (path !== null) expect((path as string).startsWith(`agents/${key}/`)).toBe(true);
    }
    expect((agent.skills as string[]).length).toBeLessThanOrEqual(32);
    expect((agent.routines as unknown[]).length).toBeLessThanOrEqual(64);
    const memories = agent.memories as string[];
    expect(memories.length).toBeLessThanOrEqual(64);
    for (const memory of memories) expect(memory.length).toBeLessThanOrEqual(500);
    if (agent.avatar !== null) {
      const avatar = files[agent.avatar as string];
      expect(avatar).toBeDefined();
      expect((avatar as Uint8Array).length).toBeLessThanOrEqual(MAX_AVATAR_BYTES);
    }
  }
  for (const path of Object.keys(files)) {
    expect(isSafeArchivePath(path)).toBe(true);
    expect(isForbiddenPath(path)).toBe(false);
  }
}

// -- Reading ---------------------------------------------------------------------------------

describe("readOpenBotZip: agent import", () => {
  it("reads the format and the agents in the order of the manifest", async () => {
    const result = await readOpenBotZip(await packed(IMPORT_DIR, "import.zip"));

    expect(result.format).toBe("openbot-agent-import");
    expect(result.agents.map(({ key }) => key)).toEqual(["ada", "min"]);
    expect(result.agents.map(({ bundle }) => bundle.manifest.name)).toEqual(["Ada", "Min"]);
  });

  it("reads the routines of ada, one for each shape, and keeps the switch on or off", async () => {
    const { agents } = await readOpenBotZip(await packed(IMPORT_DIR, "import.zip"));
    const ada = agents[0]?.bundle as Bundle;

    expect(ada.routines.length).toBe(8);
    expect(ada.routines.map(({ name, enabled }) => [name, enabled])).toEqual([
      ["Hourly check", true],
      ["Morning digest", true],
      ["Standup prompt", true],
      ["Weekly review", true],
      ["Monthly report", true],
      ["Inbox sweep", false],
      ["Seasonal plan", true],
      ["Backup ping", true],
    ]);
    expect(ada.routines.map(({ schedule }) => schedule)).toEqual([
      { kind: "cron", expression: "15 * * * *" },
      { kind: "cron", expression: "30 8 * * *" },
      { kind: "cron", expression: "0 9 * * 1-5" },
      { kind: "cron", expression: "0 16 * * 5" },
      { kind: "cron", expression: "0 9 1 * *" },
      { kind: "every", every: "90m" },
      { kind: "cron", expression: "0 9 1,15 1,6 *" },
      { kind: "cron", expression: "*/10 * * * *" },
    ]);
    expect(ada.routines.every(({ timezone }) => timezone === WARSAW)).toBe(true);
    expect(ada.routines[0]?.instruction).toBe(
      "Look at the release board and report anything that changed.",
    );
  });

  it("reads the memories as facts, the skills with their files and the avatar", async () => {
    const { agents } = await readOpenBotZip(await packed(IMPORT_DIR, "import.zip"));
    const ada = agents[0]?.bundle as Bundle;

    expect(ada.facts).toEqual([
      "The user reports in EUR.",
      "Releases freeze on the last Thursday of the month.",
      "Bug reports tagged security go to the user first.",
    ]);
    expect(ada.notes).toEqual([]);
    expect(ada.skills.map((skill) => skill.name)).toEqual(["release-notes", "triage"]);
    expect(ada.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md", "template.md"]);
    expect(strFromU8(ada.skills[0]?.files[0]?.bytes as Uint8Array)).toContain(
      "name: release-notes",
    );
    expect(ada.avatar?.name).toBe("avatar.png");
    expect(ada.avatar?.bytes.length).toBeGreaterThan(0);
  });

  it("reads the files of the workspace only when asked to", async () => {
    const file = await packed(IMPORT_DIR, "import.zip");

    const without = await readOpenBotZip(file);
    expect(without.agents[0]?.bundle.files).toEqual([]);

    const withFiles = await readOpenBotZip(file, { includeFiles: true });
    const files = withFiles.agents[0]?.bundle.files as FileEntry[];
    expect(files.map(({ path }) => path)).toEqual(["notes/todo.md"]);
    expect(strFromU8(files[0]?.bytes as Uint8Array)).toContain("Tag the next release candidate.");
  });

  it("takes the description as the instructions and builds the manifest", async () => {
    const { agents } = await readOpenBotZip(await packed(IMPORT_DIR, "import.zip"));
    const ada = agents[0]?.bundle as Bundle;

    expect(ada.instructions).toHaveLength(300);
    expect(ada.instructions.startsWith("Ada keeps releases on track.")).toBe(true);
    expect(ada.persona).toBeUndefined();
    expect(ada.unknownPaths).toEqual([]);
    expect(ada.manifest).toStrictEqual({
      schemaVersion: "0.1",
      id: "",
      name: "Ada",
      title: "Release manager",
      models: [],
      capabilities: [],
      origin: { app: "grok-bot", exportedAt: "2026-10-28T10:00:00.000Z" },
    });
  });

  it("reads the minimal agent", async () => {
    const { agents } = await readOpenBotZip(await packed(IMPORT_DIR, "import.zip"), {
      includeFiles: true,
    });
    const min = agents[1]?.bundle as Bundle;

    expect(min.instructions).toBe("Answers in one sentence.");
    expect(min.manifest.title).toBe("Minimal agent");
    expect(min.manifest.origin?.app).toBe("grok-bot");
    expect(min).toMatchObject({ skills: [], routines: [], facts: [], notes: [], files: [] });
    expect(min.avatar).toBeUndefined();
  });

  it("says that the channel is not moved", async () => {
    const { warnings } = await readOpenBotZip(await packed(IMPORT_DIR, "import.zip"));

    expect(warnings).toEqual([
      "The archive holds 1 channel (group chat); channels are not moved.",
    ]);
  });

  it("builds bundles the manifest schema and the jetpack writer accept", async () => {
    const { agents } = await readOpenBotZip(await packed(IMPORT_DIR, "import.zip"), {
      includeFiles: true,
    });

    // The id stays empty until a move assigns one.
    for (const { bundle } of agents) {
      expect(bundle.manifest.id).toBe("");
      expect(() => bundleToEntries(withId(bundle))).not.toThrow();
    }
  });

  it("takes the id of the archive for its only agent, when it is a ULID", async () => {
    const single = await forged(
      {},
      minimal((m) => {
        m["x-openteleport"] = { id: ADA_ID, version: "0.2.0" };
      }),
    );
    expect((await readOpenBotZip(single)).agents[0]?.bundle.manifest.id).toBe(ADA_ID);

    const notAnId = await forged(
      {},
      minimal((m) => {
        m["x-openteleport"] = { id: "ada" };
      }),
    );
    expect((await readOpenBotZip(notAnId)).agents[0]?.bundle.manifest.id).toBe("");

    // Two agents in one archive: the id of the archive belongs to neither.
    const two = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      m["x-openteleport"] = { id: ADA_ID, version: "0.2.0" };
    });
    const { agents } = await readOpenBotZip(two);
    expect(agents.map(({ bundle }) => bundle.manifest.id)).toEqual(["", ""]);
  });

  it("takes the id of an agent from the x-openteleport of that agent", async () => {
    const marked = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      agentAt(m, 1)["x-openteleport"] = { id: BO_ID };
    });

    const { agents } = await readOpenBotZip(marked);

    expect(agents.map(({ bundle }) => bundle.manifest.id)).toEqual(["", BO_ID]);
  });

  it("takes the full instructions from files/INSTRUCTIONS.md and keeps them out of the files", async () => {
    const full = `${"Long instructions line.\n".repeat(200)}The end.\n`;
    const file = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, () => undefined, {
      "agents/ada/files/INSTRUCTIONS.md": full,
    });

    const without = await readOpenBotZip(file);
    expect(without.agents[0]?.bundle.instructions).toBe(full);

    const { agents } = await readOpenBotZip(file, { includeFiles: true });
    const ada = agents[0]?.bundle as Bundle;
    expect(ada.instructions).toBe(full);
    expect(ada.files.map(({ path }) => path)).toEqual(["notes/todo.md"]);
  });

  it("leaves out a routine it cannot carry and says why", async () => {
    const file = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      routineAt(m, 0, 0).schedule = { kind: "hourly", minute: 99 };
      routineAt(m, 0, 1).timezone = "Mars/Olympus";
      routineAt(m, 0, 2).timezone = null;
      routineAt(m, 0, 7).schedule = { kind: "custom", expression: "soon" };
      routineAt(m, 0, 4).instruction = "  ";
    });

    const { agents, warnings } = await readOpenBotZip(file);

    expect(agents[0]?.bundle.routines.map(({ name }) => name)).toEqual([
      "Weekly review",
      "Inbox sweep",
      "Seasonal plan",
    ]);
    expect(warnings).toEqual([
      'Ada: the routine "Hourly check" is left out because its schedule cannot be carried over.',
      'Ada: the routine "Morning digest" is left out because "Mars/Olympus" is not a time zone.',
      'Ada: the routine "Standup prompt" is left out because it has no time zone.',
      'Ada: the routine "Monthly report" is left out because it has no instruction.',
      'Ada: the routine "Backup ping" is left out because its schedule cannot be carried over.',
      "The archive holds 1 channel (group chat); channels are not moved.",
    ]);
  });

  it("keeps a memory on one line and leaves out one that is too long", async () => {
    const file = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      agentAt(m, 0).memories = [
        "The user reports\nin EUR.",
        "  ",
        "x".repeat(501),
        "Releases freeze on the last Thursday of the month.",
      ];
    });

    const { agents, warnings } = await readOpenBotZip(file);

    expect(agents[0]?.bundle.facts).toEqual([
      "The user reports in EUR.",
      "Releases freeze on the last Thursday of the month.",
    ]);
    expect(warnings).toContain("Ada: 1 memory is left out because it is over 500 characters.");
  });

  it("keeps the first 64 memories and says that the rest are left out", async () => {
    const file = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      agentAt(m, 0).memories = Array.from({ length: 70 }, (_, i) => `Memory ${i + 1}`);
    });

    const { agents, warnings } = await readOpenBotZip(file);

    expect(agents[0]?.bundle.facts).toHaveLength(64);
    expect(agents[0]?.bundle.facts.at(-1)).toBe("Memory 64");
    expect(warnings).toContain("Ada: 6 memories are left out because OpenBot keeps at most 64.");
  });

  it("leaves out an avatar that OpenBot would not take, with a warning", async () => {
    const file = await patched(
      IMPORT_DIR,
      OPENBOT_IMPORT_MANIFEST,
      (m) => {
        agentAt(m, 0).avatar = "agents/ada/avatar.gif";
      },
      { "agents/ada/avatar.gif": "GIF89a" },
    );

    const { agents, warnings } = await readOpenBotZip(file);

    expect(agents[0]?.bundle.avatar).toBeUndefined();
    expect(warnings).toContain(
      "Ada: the avatar is left out because it is not a PNG, JPEG or WebP image.",
    );
  });

  it("leaves out an avatar over 512 KB and one that the archive does not hold", async () => {
    const big = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, () => undefined, {
      "agents/ada/avatar.png": new Uint8Array(MAX_AVATAR_BYTES + 1),
    });
    const bigResult = await readOpenBotZip(big);
    expect(bigResult.agents[0]?.bundle.avatar).toBeUndefined();
    expect(bigResult.warnings).toContain("Ada: the avatar is left out because it is over 512 KB.");

    const missing = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      agentAt(m, 0).avatar = "agents/ada/nobody.png";
    });
    const missingResult = await readOpenBotZip(missing);
    expect(missingResult.agents[0]?.bundle.avatar).toBeUndefined();
    expect(missingResult.warnings).toContain(
      "Ada: the avatar is left out because the archive does not hold it.",
    );
  });

  it("leaves out a skill without a SKILL.md, with a warning", async () => {
    const file = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      agentAt(m, 0).skills = ["agents/ada/skills/release-notes", "agents/ada/skills/empty"];
    });

    const { agents, warnings } = await readOpenBotZip(file);

    expect(agents[0]?.bundle.skills.map(({ name }) => name)).toEqual(["release-notes"]);
    expect(warnings).toContain('Ada: the skill "empty" is left out because it has no SKILL.md.');
  });

  it("reads an agent whose optional fields are missing", async () => {
    const file = await forged(
      {},
      minimal((m) => {
        const agent = agentAt(m, 0);
        for (const field of ["title", "avatar", "skills", "routines", "memories", "files"]) {
          delete agent[field];
        }
        delete m.source;
      }),
    );

    const { agents } = await readOpenBotZip(file, { includeFiles: true });

    const bundle = agents[0]?.bundle as Bundle;
    expect(bundle.manifest).toStrictEqual({
      schemaVersion: "0.1",
      id: "",
      name: "Ada",
      models: [],
      capabilities: [],
    });
    expect(bundle).toMatchObject({ skills: [], routines: [], facts: [], files: [] });
  });
});

describe("readOpenBotZip: instance transfer", () => {
  it("reads the format and the agent with the model of its runtime", async () => {
    const result = await readOpenBotZip(await packed(TRANSFER_DIR, "transfer.zip"));

    expect(result.format).toBe("openbot-instance-transfer");
    expect(result.agents.map(({ key }) => key)).toEqual(["ada"]);
    const ada = result.agents[0]?.bundle as Bundle;
    expect(ada.manifest.models).toEqual([
      { runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" },
    ]);
    expect(ada.manifest.origin).toEqual({
      app: "openbot",
      version: "1.4.0",
      exportedAt: "2026-10-28T10:00:00.000Z",
    });
    expect(ada.instructions).toBe("Ada keeps releases on track and drafts the release notes.");
  });

  it("keeps what has no place in the bundle under x-openbot", async () => {
    const { agents } = await readOpenBotZip(await packed(TRANSFER_DIR, "transfer.zip"));
    const vendor = agents[0]?.bundle.manifest["x-openbot"] as Record<string, unknown>;

    expect(vendor).toMatchObject({
      reasoningEffort: "high",
      avatarSeed: "ada-7f3a",
      avatarHue: 210,
      notifications: true,
    });
    expect(vendor.memories).toEqual([{ text: "The user reports in EUR.", inclusion: "essential" }]);
    const routines = vendor.routines as Record<string, Record<string, unknown>>;
    expect(routines["Quarterly review"]).toEqual({ limitPolicy: "wait", missedPolicy: "skip" });
    expect(routines["Inbox sweep"]).toEqual({
      limitPolicy: "skip",
      missedPolicy: "run-once",
      anchorAt: "2026-10-28T09:00:00.000Z",
    });
    expect(routines["Launch checklist"]).toEqual({ limitPolicy: "wait", missedPolicy: "run-once" });
  });

  it("reads the routines, the one-time routine as a time", async () => {
    const { agents } = await readOpenBotZip(await packed(TRANSFER_DIR, "transfer.zip"));
    const ada = agents[0]?.bundle as Bundle;

    expect(ada.routines).toHaveLength(3);
    expect(ada.routines.map(({ name, enabled, schedule }) => [name, enabled, schedule])).toEqual([
      ["Quarterly review", true, { kind: "cron", expression: "0 9 * 1,4,7,10 1" }],
      ["Inbox sweep", false, { kind: "every", every: "30m" }],
      ["Launch checklist", true, { kind: "at", at: "2026-12-01T07:00:00.000Z" }],
    ]);
    expect(ada.facts).toEqual([
      "The user reports in EUR.",
      "Releases freeze on the last Thursday of the month.",
    ]);
  });

  it("says that the settings and the shared files are not moved", async () => {
    const { warnings } = await readOpenBotZip(await packed(TRANSFER_DIR, "transfer.zip"));

    expect(warnings).toEqual([
      "The OpenBot settings in the transfer file (MCP servers, providers and the like) are not moved.",
      "The shared files of the OpenBot instance (shared/) are not moved.",
    ]);
  });

  it("builds bundles the manifest schema and the jetpack writer accept", async () => {
    const { agents } = await readOpenBotZip(await packed(TRANSFER_DIR, "transfer.zip"));
    const bundle = agents[0]?.bundle as Bundle;

    expect(() => bundleToEntries(withId(bundle))).not.toThrow();
  });

  it("says nothing of settings and shared files that are not there, and names the sign-ins", async () => {
    const file = await patched(TRANSFER_DIR, OPENBOT_TRANSFER_MANIFEST, (m) => {
      m.settings = null;
      m.shared = null;
      m.signedIn = ["claude"];
    });

    const { warnings } = await readOpenBotZip(file);

    expect(warnings).toEqual(["The providers OpenBot was signed in to are not moved; sign in again."]);
  });

  it("reads a version it does not know as an error", async () => {
    const file = await patched(TRANSFER_DIR, OPENBOT_TRANSFER_MANIFEST, (m) => {
      m.version = 2;
    });

    await expect(readOpenBotZip(file)).rejects.toThrow(
      /openbot-transfer\.json was made by a newer version/,
    );
  });
});

describe("openBotModelPref", () => {
  it.each([
    [
      "claude",
      "claude-opus-5-5",
      { runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" },
    ],
    ["codex", "gpt-5.5", { runtime: "codex", provider: "openai", model: "gpt-5.5" }],
    [
      "gemini",
      "gemini-3-pro",
      { runtime: "gemini-cli", provider: "google", model: "gemini-3-pro" },
    ],
    ["grok", "grok-5", { runtime: "grok", provider: "xai", model: "grok-5" }],
    ["opencode", "x", { runtime: "opencode", model: "x" }],
    ["cursor", "auto", { runtime: "cursor", model: "auto" }],
    ["cline", "m", { runtime: "cline", model: "m" }],
    ["somethingnew", "m", { runtime: "somethingnew", model: "m" }],
  ])("maps the runtime %s", (provider, model, expected) => {
    expect(openBotModelPref(provider, model)).toStrictEqual(expected);
  });

  it("keeps what is given and nothing else", () => {
    expect(openBotModelPref("claude", undefined)).toStrictEqual({
      runtime: "claude-code",
      provider: "anthropic",
    });
    expect(openBotModelPref(undefined, "gpt-5.5")).toStrictEqual({ model: "gpt-5.5" });
    expect(openBotModelPref("", "")).toBeUndefined();
    expect(openBotModelPref(undefined, undefined)).toBeUndefined();
    expect(openBotModelPref(null, null)).toBeUndefined();
    expect(openBotModelPref(5, {})).toBeUndefined();
  });
});

// -- Reading archives it must refuse -----------------------------------------------------------

describe("readOpenBotZip: archives it refuses", () => {
  it("refuses a key that leaves the folder of the agents", async () => {
    const file = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      agentAt(m, 1).key = "../x";
    });

    await expect(readOpenBotZip(file)).rejects.toThrow(/agent 2 has an invalid key/);
  });

  it.each(["", "Ada", "ada_1", "a".repeat(65), "ada/x", "ada\\x", 7, null])(
    "refuses the key %j",
    async (key) => {
      const file = await forged(
        {},
        minimal((m) => {
          agentAt(m, 0).key = key;
        }),
      );

      await expect(readOpenBotZip(file)).rejects.toThrow(/invalid key/);
    },
  );

  it("refuses a skill that lies in the folder of another agent", async () => {
    const file = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      agentAt(m, 0).skills = ["agents/ada/skills/release-notes", "agents/other/skills/x"];
    });

    await expect(readOpenBotZip(file)).rejects.toThrow(
      /agent "ada" has an invalid skill path "agents\/other\/skills\/x"/,
    );
  });

  it.each<[string, string, unknown]>([
    ["avatar", "avatar", "agents/min/avatar.png"],
    ["avatar", "avatar", "/etc/passwd"],
    ["avatar", "avatar", 7],
    ["files", "files", "agents/ada"],
    ["files", "files", "agents/ada/../min/files"],
    ["files", "files", "agents/ada/files/.git"],
    ["skill", "skills", ["agents/ada/skills/../../min/skills/x"]],
    ["skill", "skills", ["agents/ada/skills/.git"]],
    ["skill", "skills", ["agents/ada/skills/x", 7]],
  ])("refuses an unsafe %s path in the manifest: %j", async (word, field, value) => {
    const file = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      agentAt(m, 0)[field] = value;
    });

    await expect(readOpenBotZip(file)).rejects.toThrow(
      new RegExp(`agent "ada" has an invalid ${word} path`),
    );
  });

  it("reads a trailing slash on a folder path as the folder, as OpenBot does", async () => {
    const file = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      const ada = agentAt(m, 0);
      ada.skills = ["agents/ada/skills/triage/"];
      ada.files = "agents/ada/files/";
    });

    const { agents } = await readOpenBotZip(file, { includeFiles: true });

    expect(agents[0]?.bundle.skills.map(({ name }) => name)).toEqual(["triage"]);
    expect(agents[0]?.bundle.files.map(({ path }) => path)).toEqual(["notes/todo.md"]);
  });

  it("refuses two agents of one key", async () => {
    const file = await patched(IMPORT_DIR, OPENBOT_IMPORT_MANIFEST, (m) => {
      agentAt(m, 1).key = "ada";
    });

    await expect(readOpenBotZip(file)).rejects.toThrow(/two agents use the key "ada"/);
  });

  it("refuses an entry whose path leaves the archive", async () => {
    const file = await forged({ "agents/ada/files/../../../evil.txt": "x" });

    await expect(readOpenBotZip(file)).rejects.toThrow(/unsafe path: agents\/ada\/files\/\.\.\//);
  });

  // Under files/ and shared/ a forbidden path is left out (see the next describe); anywhere else
  // it is not content OpenTeleport may carry, nor skip without the archive being changed.
  it.each([
    "agents/ada/skills/x/.env",
    "agents/ada/skills/x/.git/config",
    "agents/ada/skills/x/node_modules/p/index.js",
    "agents/ada/skills/x/private-key.pem",
    "agents/ada/skills/x/backup.zip",
    "agents/ada/.env",
    "agents/ada/avatar.zip",
    ".env",
    "notes/.git/config",
  ])("refuses the forbidden path %s", async (path) => {
    const file = await forged({ [path]: "x" });

    await expect(readOpenBotZip(file)).rejects.toThrow(/forbidden path/);
  });

  it.each(["agents/Ada/x.md", "agents/ada_1/x.md", `agents/${"a".repeat(65)}/x.md`, "agents/x.md"])(
    "refuses the path %s that no agent key names",
    async (path) => {
      const file = await forged({ [path]: "x" });

      await expect(readOpenBotZip(file)).rejects.toThrow(/invalid agent key in path/);
    },
  );

  it("refuses an archive with no manifest, and one with both", async () => {
    const none = await forged({ "agents/ada/x.md": "x" }, null);
    await expect(readOpenBotZip(none)).rejects.toThrow(
      /holds no openbot-import\.json or openbot-transfer\.json/,
    );

    const both = await forged({ [OPENBOT_TRANSFER_MANIFEST]: "{}" });
    await expect(readOpenBotZip(both)).rejects.toThrow(
      /holds both openbot-import\.json and openbot-transfer\.json/,
    );
  });

  it("refuses a file that is not a zip, and a file that is not there", async () => {
    const file = join(root, "plain.zip");
    await writeFile(file, "not a zip at all");

    await expect(readOpenBotZip(file)).rejects.toThrow(/is not a valid zip archive/);
    await expect(readOpenBotZip(join(root, "missing.zip"))).rejects.toThrow(/ENOENT/);
  });

  it.each<[string, string, RegExp]>([
    ["is not JSON", "{", /openbot-import\.json is not valid JSON/],
    ["is not an object", "[]", /openbot-import\.json is not an agent import/],
    [
      "is of another format",
      minimal((m) => {
        m.format = "openbot-instance-transfer";
      }),
      /openbot-import\.json is not an agent import/,
    ],
    [
      "is of a newer version",
      minimal((m) => {
        m.version = 2;
      }),
      /openbot-import\.json was made by a newer version/,
    ],
    [
      "has no version",
      minimal((m) => {
        delete m.version;
      }),
      /openbot-import\.json has no version 1/,
    ],
    [
      "lists no agents",
      minimal((m) => {
        m.agents = [];
      }),
      /openbot-import\.json lists no agents/,
    ],
    [
      "has agents that are not a list",
      minimal((m) => {
        m.agents = {};
      }),
      /openbot-import\.json lists no agents/,
    ],
    [
      "has an agent that is not an object",
      minimal((m) => {
        m.agents = ["ada"];
      }),
      /agent 1 is not an object/,
    ],
    [
      "has no name",
      minimal((m) => {
        agentAt(m, 0).name = " ";
      }),
      /agent "ada" has an invalid name/,
    ],
    [
      "has a name over 80 characters",
      minimal((m) => {
        agentAt(m, 0).name = "n".repeat(81);
      }),
      /invalid name/,
    ],
    [
      "has a title over 120 characters",
      minimal((m) => {
        agentAt(m, 0).title = "t".repeat(121);
      }),
      /invalid title/,
    ],
    [
      "has a description over 2000 characters",
      minimal((m) => {
        agentAt(m, 0).description = "d".repeat(2001);
      }),
      /invalid description/,
    ],
    [
      "has no description",
      minimal((m) => {
        delete agentAt(m, 0).description;
      }),
      /invalid description/,
    ],
    [
      "has more than 32 skills",
      minimal((m) => {
        agentAt(m, 0).skills = Array.from({ length: 33 }, (_, i) => `agents/ada/skills/s${i}`);
      }),
      /invalid skill list/,
    ],
    [
      "has routines that are not a list",
      minimal((m) => {
        agentAt(m, 0).routines = {};
      }),
      /invalid routine list/,
    ],
    [
      "has memories that are not a list",
      minimal((m) => {
        agentAt(m, 0).memories = "one";
      }),
      /invalid memory list/,
    ],
  ])("refuses a manifest that %s", async (_name, manifest, message) => {
    await expect(readOpenBotZip(await forged({}, manifest))).rejects.toThrow(message);
  });

  it("refuses an archive that declares more than MAX_FILES_BYTES under files/", async () => {
    const archive = tamper(
      zipSync({
        [OPENBOT_IMPORT_MANIFEST]: strToU8(minimal()),
        "agents/ada/files/big.bin": new Uint8Array(2000),
      }),
      "agents/ada/files/big.bin",
      { claimedSize: MAX_FILES_BYTES + 1 },
    );

    await expect(readOpenBotZip(await archiveFile(archive))).rejects.toThrow(
      /files\/ is 104857601 bytes, over the 104857600 byte limit/,
    );
  });

  it("refuses a text entry over MAX_TEXT_ENTRY_BYTES", async () => {
    const archive = tamper(
      zipSync({
        [OPENBOT_IMPORT_MANIFEST]: strToU8(minimal()),
        "agents/ada/skills/x/SKILL.md": new Uint8Array(100),
      }),
      "agents/ada/skills/x/SKILL.md",
      { claimedSize: MAX_TEXT_ENTRY_BYTES + 1 },
    );

    await expect(readOpenBotZip(await archiveFile(archive))).rejects.toThrow(
      /agents\/ada\/skills\/x\/SKILL\.md is 2097153 bytes, over the 2097152 byte limit/,
    );
  });

  it("does not inflate what lies outside agents/ or what it was not asked for", async () => {
    const base = zipSync({
      [OPENBOT_IMPORT_MANIFEST]: strToU8(minimal()),
      "shared/data.bin": strToU8("x".repeat(500)),
      "agents/ada/files/todo.md": strToU8("y".repeat(500)),
    });
    const broken = tamper(
      tamper(base, "shared/data.bin", { breakData: true }),
      "agents/ada/files/todo.md",
      { breakData: true },
    );
    const file = await archiveFile(broken);

    const result = await readOpenBotZip(file);
    expect(result.agents).toHaveLength(1);
    // Only a read that asks for the files inflates them.
    await expect(readOpenBotZip(file, { includeFiles: true })).rejects.toThrow(
      /is not a valid zip archive/,
    );
  });

  // The one file of files/ that is always inflated, so it is held to the limit of a text entry.
  it.each([false, true])(
    "refuses files/INSTRUCTIONS.md over MAX_TEXT_ENTRY_BYTES (includeFiles %s)",
    async (includeFiles) => {
      const archive = tamper(
        zipSync({
          [OPENBOT_IMPORT_MANIFEST]: strToU8(minimal()),
          "agents/ada/files/INSTRUCTIONS.md": new Uint8Array(100),
        }),
        "agents/ada/files/INSTRUCTIONS.md",
        { claimedSize: MAX_TEXT_ENTRY_BYTES + 1 },
      );

      await expect(readOpenBotZip(await archiveFile(archive), { includeFiles })).rejects.toThrow(
        /agents\/ada\/files\/INSTRUCTIONS\.md is 2097153 bytes, over the 2097152 byte limit/,
      );
    },
  );

  it("reads files/INSTRUCTIONS.md of exactly MAX_TEXT_ENTRY_BYTES", async () => {
    const text = "y".repeat(MAX_TEXT_ENTRY_BYTES);
    const file = await forged({ "agents/ada/files/INSTRUCTIONS.md": text });

    const { agents } = await readOpenBotZip(file);

    expect(agents[0]?.bundle.instructions).toHaveLength(MAX_TEXT_ENTRY_BYTES);
  });
});

describe("readOpenBotZip: entries it leaves out", () => {
  const withWorkspace = (m: Json): void => {
    agentAt(m, 0).files = "agents/ada/files";
  };

  /** An archive of `files`, with the deflate stream of each of `broken` damaged. */
  async function withBroken(
    files: Record<string, string>,
    broken: readonly string[],
    manifest = minimal(withWorkspace),
  ): Promise<string> {
    const entries: Record<string, Uint8Array> = { [OPENBOT_IMPORT_MANIFEST]: strToU8(manifest) };
    for (const [path, content] of Object.entries(files)) entries[path] = strToU8(content);
    let archive: Uint8Array = zipSync(entries);
    for (const path of broken) archive = tamper(archive, path, { breakData: true });
    return archiveFile(archive);
  }

  const FORBIDDEN = {
    "agents/ada/files/.env": "SECRET=".repeat(50),
    "agents/ada/files/.git/config": "[core]\n".repeat(50),
    "shared/old.zip": "PK".repeat(100),
  };

  it.each([false, true])(
    "leaves out forbidden entries of files/ and shared/ with one warning, never inflating them (includeFiles %s)",
    async (includeFiles) => {
      const file = await withBroken(
        { ...FORBIDDEN, "agents/ada/files/notes.md": "- one\n" },
        Object.keys(FORBIDDEN),
      );

      const { agents, warnings } = await readOpenBotZip(file, { includeFiles });

      expect(warnings).toEqual([
        "3 entries were left out because their paths are forbidden: " +
          "agents/ada/files/.env, agents/ada/files/.git/config, shared/old.zip.",
      ]);
      const files = agents[0]?.bundle.files as FileEntry[];
      expect(files.map(({ path }) => path)).toEqual(includeFiles ? ["notes.md"] : []);
    },
  );

  it("says so once for one entry, and names the first five of many", async () => {
    const one = await withBroken({ "shared/.env": "K=V" }, ["shared/.env"]);
    expect((await readOpenBotZip(one)).warnings).toEqual([
      "1 entry was left out because its path is forbidden: shared/.env.",
    ]);

    const many: Record<string, string> = {};
    for (let i = 7; i >= 1; i -= 1) many[`agents/ada/files/node_modules/p${i}/index.js`] = "x";
    const file = await withBroken(many, Object.keys(many));
    expect((await readOpenBotZip(file, { includeFiles: true })).warnings).toEqual([
      "7 entries were left out because their paths are forbidden: " +
        "agents/ada/files/node_modules/p1/index.js, agents/ada/files/node_modules/p2/index.js, " +
        "agents/ada/files/node_modules/p3/index.js, agents/ada/files/node_modules/p4/index.js, " +
        "agents/ada/files/node_modules/p5/index.js and 2 more.",
    ]);
  });

  it("puts the warning before the ones about the agents and the archive", async () => {
    const file = await patched(TRANSFER_DIR, OPENBOT_TRANSFER_MANIFEST, () => undefined, {
      "agents/ada/files/.env": "K=V",
      "shared/old.zip": "PK",
    });

    const { warnings } = await readOpenBotZip(file, { includeFiles: true });

    expect(warnings).toEqual([
      "2 entries were left out because their paths are forbidden: " +
        "agents/ada/files/.env, shared/old.zip.",
      "The OpenBot settings in the transfer file (MCP servers, providers and the like) are not moved.",
      "The shared files of the OpenBot instance (shared/) are not moved.",
    ]);
  });

  it("still counts what it leaves out toward the limits", async () => {
    const archive = tamper(
      zipSync({
        [OPENBOT_IMPORT_MANIFEST]: strToU8(minimal()),
        "shared/old.zip": new Uint8Array(100),
      }),
      "shared/old.zip",
      { claimedSize: MAX_ARCHIVE_BYTES + 1 },
    );

    await expect(readOpenBotZip(await archiveFile(archive))).rejects.toThrow(
      /entries add up to \d+ bytes, over the 115343360 byte limit/,
    );
  });

  it("still refuses an unsafe path, forbidden or not", async () => {
    const file = await forged({ "agents/ada/files/../.env": "K=V" });

    await expect(readOpenBotZip(file)).rejects.toThrow(/unsafe path/);
  });

});

// -- Writing ---------------------------------------------------------------------------------

describe("writeOpenBotImportZip", () => {
  it("writes the manifest of the import format with the id of the bundle", () => {
    const written = write([bundleOf({ instructions: "Be kind.", facts: ["A fact."] })]);

    expect(Object.keys(written.files)).toEqual([OPENBOT_IMPORT_MANIFEST]);
    expect(written.manifest).toMatchObject({
      format: "openbot-agent-import",
      version: 1,
      source: { app: "openteleport" },
      "x-openteleport": { id: ADA_ID, version: "0.2.0" },
    });
    const source = written.manifest.source as { exportedAt: string };
    expect(new Date(source.exportedAt).toISOString()).toBe(source.exportedAt);
    expect(written.agents).toEqual([
      {
        key: "ada",
        name: "Ada",
        title: "",
        description: "Be kind.",
        avatar: null,
        skills: [],
        routines: [],
        memories: ["A fact."],
        files: null,
      },
    ]);
    expect(written.items).toEqual({ approximated: [], skipped: [], warnings: [] });
    expectWithinImportLimits(written);
  });

  it("leaves the id out for a bundle that has none yet", () => {
    const written = write([bundleOf({}, "Ada", "")]);

    expect(written.manifest["x-openteleport"]).toEqual({ version: "0.2.0" });
  });

  it("gives each agent of a larger archive its own id", () => {
    const written = write([bundleOf(), bundleOf({}, "Bo", BO_ID)]);

    expect(written.manifest["x-openteleport"]).toEqual({ version: "0.2.0" });
    expect(written.agents.map((agent) => agent["x-openteleport"])).toEqual([
      { id: ADA_ID },
      { id: BO_ID },
    ]);
  });

  it("refuses to write an archive with no agent", () => {
    expect(() => writeOpenBotImportZip([], WRITE_OPTS)).toThrow(/no agent/);
  });

  // An archive the reader would refuse is not built: a later move could not read it back.
  describe("limits of the archive", () => {
    const filesOf = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ path: `f${i}.txt`, bytes: strToU8("x") }));

    it("holds 5000 entries, the manifest among them, and no more", async () => {
      const atLimit = write([bundleOf({ files: filesOf(4999) })]);
      expect(Object.keys(atLimit.files)).toHaveLength(5000);
      const back = await readOpenBotZip(await archiveFile(atLimit.bytes), { includeFiles: true });
      expect(back.agents[0]?.bundle.files).toHaveLength(4999);

      expect(() => write([bundleOf({ files: filesOf(5000) })])).toThrow(
        "the archive would hold 5001 entries, over the 5000 OpenBot takes; " +
          "leave out the files of the workspace",
      );
    });

    it("counts the entries of the skills and of every agent", () => {
      const skills = Array.from({ length: 32 }, (_, i) =>
        skillOf(`s${i}`, Array.from({ length: 150 }, (_, n) => ({ path: `f${n}`, bytes: strToU8("x") }))),
      );
      const several = Array.from({ length: 2 }, (_, i) =>
        bundleOf({ skills, files: filesOf(100) }, `Agent ${i}`),
      );

      expect(() => write(several)).toThrow(/over the 5000 OpenBot takes/);
    });

    it("does not count the files that are not written", () => {
      const written = write([bundleOf({ files: filesOf(6000) })], {
        ...WRITE_OPTS,
        includeFiles: false,
      });

      expect(Object.keys(written.files)).toEqual([OPENBOT_IMPORT_MANIFEST]);
    });

    it("holds at most MAX_FILES_BYTES of files", () => {
      const big = { path: "big.bin", bytes: new Uint8Array(MAX_FILES_BYTES + 1) };

      expect(() => write([bundleOf({ files: [big] })])).toThrow(
        "the files of the workspace would be 104857601 bytes, over the 104857600 byte limit",
      );
    });

    it("holds at most MAX_ARCHIVE_BYTES in all", () => {
      const files = [{ path: "big.bin", bytes: new Uint8Array(MAX_FILES_BYTES) }];
      const bulk = (name: string) =>
        skillOf(name, [{ path: "data.bin", bytes: new Uint8Array(6 * 1024 * 1024) }]);

      expect(() => write([bundleOf({ files, skills: [bulk("one"), bulk("two")] })])).toThrow(
        /the archive would be \d+ bytes, over the 115343360 byte limit/,
      );
    });
  });

  describe("names and keys", () => {
    it.each([
      ["Ada", "ada"],
      ["Release  Manager!", "release-manager"],
      ["  --Ada--  ", "ada"],
      ["Zażółć gęślą", "zazolc-gesla"],
      ["!!!", "agent"],
      ["日本語", "agent"],
      ["Con", "agent"],
      ["Private Key Keeper", "agent"],
      ["x".repeat(100), "x".repeat(64)],
    ])("makes the key of %j", (name, key) => {
      const written = write([bundleOf({}, name)]);

      expect(written.agents[0]?.key).toBe(key);
      expectWithinImportLimits(written);
    });

    it("gives agents of the same name different keys", () => {
      const written = write([bundleOf({}, "Ada"), bundleOf({}, "Ada"), bundleOf({}, "ada")]);

      expect(written.agents.map(({ key }) => key)).toEqual(["ada", "ada-2", "ada-3"]);
    });

    it("keeps a numbered key within 64 characters", () => {
      const long = "x".repeat(80);
      const written = write([bundleOf({}, long), bundleOf({}, long)]);

      expect(written.agents.map(({ key }) => (key as string).length)).toEqual([64, 64]);
      expect(written.agents[1]?.key).toMatch(/-2$/);
    });

    it("cuts a name over 80 characters and a title over 120, and says so", () => {
      const name = "n".repeat(90);
      const title = "t".repeat(130);
      const written = write([bundleOf({ manifest: { ...bundleOf().manifest, name, title } })]);

      expect(written.agents[0]?.name).toBe("n".repeat(80));
      expect(written.agents[0]?.title).toBe("t".repeat(120));
      expect(written.items.approximated).toEqual([
        { field: "name", detail: "cut to the 80 characters OpenBot takes" },
        { field: "title", detail: "cut to the 120 characters OpenBot takes" },
      ]);
    });
  });

  describe("instructions", () => {
    it("keeps instructions of up to 2000 characters in the description", () => {
      const text = `${"a".repeat(1999)}\n`;
      const written = write([bundleOf({ instructions: text })]);

      expect(written.agents[0]?.description).toBe(text);
      expect(written.agents[0]?.files).toBeNull();
      expect(written.items.approximated).toEqual([]);
    });

    it("cuts instructions over 2000 characters at the last full line and keeps the whole text in a file", () => {
      const line = `${"b".repeat(99)}\n`;
      const text = line.repeat(25); // 2500 characters
      const written = write([bundleOf({ instructions: text })], {
        ...WRITE_OPTS,
        includeFiles: false,
      });

      const description = written.agents[0]?.description as string;
      expect(text).toHaveLength(2500);
      expect(description).toBe(line.repeat(20).trimEnd());
      expect(description.length).toBeLessThanOrEqual(2000);
      expect(written.agents[0]?.files).toBe("agents/ada/files");
      expect(strFromU8(written.files["agents/ada/files/INSTRUCTIONS.md"] as Uint8Array)).toBe(
        text,
      );
      expect(written.items.approximated).toEqual([
        {
          field: "instructions",
          detail:
            "over the 2000 characters OpenBot takes in a description: the description holds " +
            "the first lines, the whole text is in files/INSTRUCTIONS.md",
        },
      ]);
      expectWithinImportLimits(written);
    });

    it("cuts in the middle of a line only when the first 2000 characters hold no full line", () => {
      const text = `${"b".repeat(1500)}\n${"c".repeat(1500)}\n`;
      const cutAtLine = write([bundleOf({ instructions: text })]);
      expect(cutAtLine.agents[0]?.description).toBe("b".repeat(1500));

      const oneLine = write([bundleOf({ instructions: "c".repeat(2500) })]);
      expect(oneLine.agents[0]?.description).toBe("c".repeat(2000));
    });

    it("does not cut a surrogate pair in two", () => {
      const text = `${"d".repeat(1999)}\u{1F600}${"e".repeat(500)}`;
      const written = write([bundleOf({ instructions: text })]);

      expect(written.agents[0]?.description).toBe("d".repeat(1999));
    });

    it("joins the persona and the instructions with an empty line, and says so", () => {
      const written = write([
        bundleOf({ persona: "Calm and curious.\n", instructions: "Read first.\n" }),
      ]);

      expect(written.agents[0]?.description).toBe("Calm and curious.\n\nRead first.");
      expect(written.items.approximated).toEqual([
        {
          field: "persona",
          detail:
            "OpenBot has no persona field; it is joined with the instructions in the description",
        },
      ]);
    });

    it("writes a persona alone, and a long text of both, whole", () => {
      const alone = write([bundleOf({ persona: "Calm.", instructions: "  \n" })]);
      expect(alone.agents[0]?.description).toBe("Calm.");

      const long = write([bundleOf({ persona: "Calm.", instructions: "x ".repeat(1500) })]);
      expect(strFromU8(long.files["agents/ada/files/INSTRUCTIONS.md"] as Uint8Array)).toBe(
        `Calm.\n\n${"x ".repeat(1500).trim()}`,
      );
    });

    it("always writes the full instructions, even without the files of the workspace", () => {
      const written = write([bundleOf({ instructions: "f".repeat(2500) })], {
        ...WRITE_OPTS,
        includeFiles: false,
      });

      expect(Object.keys(written.files)).toContain("agents/ada/files/INSTRUCTIONS.md");
    });

    // The reader inflates files/INSTRUCTIONS.md whatever it is asked for, so it holds it to the
    // limit of a text entry; the writer keeps within it, or its own archive would be refused.
    const OVER_CAP_DETAIL =
      "over the 2000 characters OpenBot takes in a description and over the 2097152 bytes " +
      "OpenTeleport reads back from files/INSTRUCTIONS.md: the description holds the first " +
      "lines and the rest is left out";

    it("writes the whole text of exactly MAX_TEXT_ENTRY_BYTES, and the reader takes it back", async () => {
      const text = `first line\n${"z".repeat(MAX_TEXT_ENTRY_BYTES - 11)}`;
      expect(new TextEncoder().encode(text)).toHaveLength(MAX_TEXT_ENTRY_BYTES);
      const written = write([bundleOf({ instructions: text })]);

      expect(written.files["agents/ada/files/INSTRUCTIONS.md"]).toHaveLength(MAX_TEXT_ENTRY_BYTES);
      const back = await readOpenBotZip(await archiveFile(written.bytes));
      expect(back.agents[0]?.bundle.instructions).toBe(text);
    });

    it("keeps only the first lines of a text over MAX_TEXT_ENTRY_BYTES, and says so", async () => {
      const text = `first line\n${"z".repeat(MAX_TEXT_ENTRY_BYTES - 10)}`;
      const written = write([bundleOf({ instructions: text })]);

      expect(Object.keys(written.files)).toEqual([OPENBOT_IMPORT_MANIFEST]);
      expect(written.agents[0]).toMatchObject({ description: "first line", files: null });
      expect(written.items).toEqual({
        approximated: [{ field: "instructions", detail: OVER_CAP_DETAIL }],
        skipped: [],
        warnings: [],
      });
      const back = await readOpenBotZip(await archiveFile(written.bytes));
      expect(back.agents[0]?.bundle.instructions).toBe("first line");
    });

    it("counts the bytes of the text, not its characters", () => {
      const text = "é".repeat(1_100_000); // 1.1 million characters, 2.2 million bytes
      const written = write([bundleOf({ instructions: text })]);

      expect(Object.keys(written.files)).toEqual([OPENBOT_IMPORT_MANIFEST]);
      expect(written.items.approximated.map(({ detail }) => detail)).toEqual([OVER_CAP_DETAIL]);
    });

    it("counts the persona with the instructions", () => {
      const half = "h".repeat(MAX_TEXT_ENTRY_BYTES / 2 + 1);
      const written = write([bundleOf({ persona: half, instructions: half })]);

      expect(Object.keys(written.files)).toEqual([OPENBOT_IMPORT_MANIFEST]);
      expect(written.items.approximated.map(({ field }) => field)).toEqual([
        "persona",
        "instructions",
      ]);
    });

    it("does not write a file named INSTRUCTIONS.md beside instructions that did not fit", () => {
      const text = "z".repeat(MAX_TEXT_ENTRY_BYTES + 1);
      const written = write([
        bundleOf({ instructions: text, files: [{ path: "INSTRUCTIONS.md", bytes: strToU8("mine") }] }),
      ]);

      expect(Object.keys(written.files)).toEqual([OPENBOT_IMPORT_MANIFEST]);
      expect(written.items.skipped).toEqual([
        { field: "file:INSTRUCTIONS.md", detail: "this name is kept for the full instructions" },
      ]);
    });
  });

  describe("memories", () => {
    it("writes up to 64 facts and skips the rest by their place", () => {
      const facts = Array.from({ length: 65 }, (_, i) => `Fact number ${i + 1}`);
      const written = write([bundleOf({ facts })]);

      expect(written.agents[0]?.memories).toEqual(facts.slice(0, 64));
      expect(written.items.skipped).toEqual([
        { field: "fact:65", detail: "Fact number 65… (OpenBot memory limit: 64 facts)" },
      ]);
    });

    it("skips a fact over 500 characters without counting it toward the 64", () => {
      const facts = ["w".repeat(100), "x".repeat(501), ...Array.from({ length: 64 }, (_, i) => `F${i}`)];
      const written = write([bundleOf({ facts })]);

      expect(written.agents[0]?.memories).toEqual([facts[0], ...facts.slice(2, 65)]);
      expect(written.items.skipped).toEqual([
        { field: "fact:2", detail: `${"x".repeat(60)}… (OpenBot memory limit: 500 chars)` },
        { field: "fact:66", detail: "F63… (OpenBot memory limit: 64 facts)" },
      ]);
    });

    it("skips a fact with nothing in it", () => {
      const written = write([bundleOf({ facts: ["Keep.", "   "] })]);

      expect(written.agents[0]?.memories).toEqual(["Keep."]);
      expect(written.items.skipped).toEqual([{ field: "fact:2", detail: "… (empty)" }]);
    });
  });

  describe("routines", () => {
    it.each<[string, Schedule, unknown]>([
      ["hourly", { kind: "cron", expression: "15 * * * *" }, { kind: "hourly", minute: 15 }],
      ["daily", { kind: "cron", expression: "30 8 * * *" }, { kind: "daily", time: "08:30" }],
      ["weekdays", { kind: "cron", expression: "0 9 * * 1-5" }, { kind: "weekdays", time: "09:00" }],
      [
        "weekly",
        { kind: "cron", expression: "0 16 * * 5" },
        { kind: "weekly", weekday: 5, time: "16:00" },
      ],
      [
        "monthly",
        { kind: "cron", expression: "0 9 1 * *" },
        { kind: "monthly", day: 1, time: "09:00" },
      ],
      [
        "an interval",
        { kind: "every", every: "90m" },
        { kind: "interval", amount: 90, unit: "minutes" },
      ],
      [
        "an interval in days",
        { kind: "every", every: "2d" },
        { kind: "interval", amount: 2, unit: "days" },
      ],
      [
        "advanced, in the nested form OpenBot reads",
        { kind: "cron", expression: "0 9 1,15 1,6 *" },
        {
          kind: "advanced",
          months: [1, 6],
          days: { kind: "days-of-month", days: [1, 15] },
          time: { kind: "at-time", time: "09:00" },
        },
      ],
      [
        "custom",
        { kind: "cron", expression: "*/10 * * * *" },
        { kind: "custom", expression: "*/10 * * * *" },
      ],
    ])("writes %s", (_name, schedule, wire) => {
      const written = write([bundleOf({ routines: [routineOf("Job", schedule)] })]);

      expect(written.agents[0]?.routines).toEqual([
        { name: "Job", instruction: "Do Job.", active: true, timezone: WARSAW, schedule: wire },
      ]);
      expect(written.items).toEqual({ approximated: [], skipped: [], warnings: [] });
    });

    it("writes the switch and the zone of the routine", () => {
      const off = routineOf("Off", daily, { enabled: false, timezone: "UTC" });
      const written = write([bundleOf({ routines: [off] })]);

      expect(written.agents[0]?.routines).toMatchObject([
        { name: "Off", active: false, timezone: "UTC" },
      ]);
    });

    it("gives an interval back the anchor it was read with", () => {
      const anchorAt = "2026-10-28T09:00:00.000Z";
      const manifest = {
        ...bundleOf().manifest,
        "x-openbot": { routines: { Sweep: { anchorAt, limitPolicy: "skip" } } },
      };
      const written = write([
        bundleOf({ manifest, routines: [routineOf("Sweep", { kind: "every", every: "30m" })] }),
      ]);

      expect(written.agents[0]?.routines).toMatchObject([
        { schedule: { kind: "interval", amount: 30, unit: "minutes", anchorAt } },
      ]);
    });

    it("skips a routine OpenBot cannot hold, by name", () => {
      const written = write([
        bundleOf({
          routines: [
            routineOf("One shot", { kind: "at", at: "2026-11-01T08:30:00.000Z" }),
            routineOf("Fast", { kind: "every", every: "2m" }),
            routineOf("Odd", { kind: "cron", expression: "@daily" }),
            routineOf("Fine", { kind: "every", every: "3m" }),
          ],
        }),
      ]);

      expect(written.agents[0]?.routines).toHaveLength(1);
      expect(written.items.skipped).toEqual([
        { field: "routine:One shot", detail: "the OpenBot import format has no one-time schedule" },
        { field: "routine:Fast", detail: "OpenBot runs a routine at most every 3 minutes" },
        { field: "routine:Odd", detail: "OpenBot cannot hold this schedule" },
      ]);
    });

    it("skips a routine whose interval is not a duration without failing", () => {
      const written = write([bundleOf({ routines: [routineOf("Often", { kind: "every", every: "often" })] })]);

      expect(written.items.skipped).toEqual([
        { field: "routine:Often", detail: "OpenBot cannot hold this schedule" },
      ]);
    });

    it("skips the routines after the 64th and a routine with a too long instruction", () => {
      const routines = Array.from({ length: 65 }, (_, i) => routineOf(`R${i + 1}`, daily));
      const huge = routineOf("Huge", daily, { instruction: "i".repeat(100_001) });
      const written = write([bundleOf({ routines: [huge, ...routines] })]);

      expect(written.agents[0]?.routines).toHaveLength(64);
      expect(written.items.skipped).toEqual([
        {
          field: "routine:Huge",
          detail: "the instruction is over the 100000 characters OpenBot takes",
        },
        { field: "routine:R65", detail: "OpenBot takes at most 64 routines per agent" },
      ]);
      expectWithinImportLimits(written);
    });

    it("cuts a routine name over 80 characters and says so", () => {
      const name = "r".repeat(90);
      const written = write([bundleOf({ routines: [routineOf(name, daily)] })]);

      expect((written.agents[0]?.routines as { name: string }[])[0]?.name).toBe("r".repeat(80));
      expect(written.items.approximated).toEqual([
        { field: `routine:${name}`, detail: "name cut to the 80 characters OpenBot takes" },
      ]);
    });
  });

  describe("skills", () => {
    it("writes the files of a skill under its folder", () => {
      const skill = skillOf("web-brief", [{ path: "refs/notes.md", bytes: strToU8("notes") }]);
      const written = write([bundleOf({ skills: [skill] })]);

      expect(written.agents[0]?.skills).toEqual(["agents/ada/skills/web-brief"]);
      expect(Object.keys(written.files).sort()).toEqual([
        "agents/ada/skills/web-brief/SKILL.md",
        "agents/ada/skills/web-brief/refs/notes.md",
        OPENBOT_IMPORT_MANIFEST,
      ]);
      expect(
        strFromU8(written.files["agents/ada/skills/web-brief/refs/notes.md"] as Uint8Array),
      ).toBe("notes");
    });

    it("writes 32 skills and skips the 33rd", () => {
      const skills = Array.from({ length: 33 }, (_, i) =>
        skillOf(`skill-${String(i + 1).padStart(2, "0")}`),
      );
      const written = write([bundleOf({ skills })]);

      expect(written.agents[0]?.skills).toHaveLength(32);
      expect(written.items.skipped).toEqual([
        { field: "skill:skill-33", detail: "OpenBot takes at most 32 skills per agent" },
      ]);
      expectWithinImportLimits(written);
    });

    it("skips a skill of more than 200 files or 10 MB", () => {
      const filesOf = (count: number) =>
        Array.from({ length: count }, (_, i) => ({ path: `f${i}.md`, bytes: strToU8("x") }));
      const written = write([
        bundleOf({
          skills: [
            skillOf("many", filesOf(200)),
            skillOf("heavy", [
              { path: "a.bin", bytes: new Uint8Array(6 * 1024 * 1024) },
              { path: "b.bin", bytes: new Uint8Array(5 * 1024 * 1024) },
            ]),
            skillOf("fine", filesOf(199)),
          ],
        }),
      ]);

      expect(written.agents[0]?.skills).toEqual(["agents/ada/skills/fine"]);
      expect(written.items.skipped).toEqual([
        { field: "skill:many", detail: "OpenBot takes at most 200 files in a skill" },
        { field: "skill:heavy", detail: "OpenBot takes at most 10 MB in a skill" },
      ]);
    });

    it("skips a skill with a name or a file OpenBot would refuse, so it never refuses the archive", () => {
      const written = write([
        bundleOf({
          skills: [
            skillOf("../evil"),
            skillOf("with-env", [{ path: ".env", bytes: strToU8("K=V") }]),
            skillOf("nested-git", [{ path: ".git/config", bytes: strToU8("x") }]),
            skillOf("backslash", [{ path: "a\\b.md", bytes: strToU8("x") }]),
            { name: "no-skill-file", files: [{ path: "README.md", bytes: strToU8("x") }] },
            skillOf("good"),
          ],
        }),
      ]);

      expect(written.agents[0]?.skills).toEqual(["agents/ada/skills/good"]);
      expect(written.items.skipped.map(({ field }) => field)).toEqual([
        "skill:../evil",
        "skill:with-env",
        "skill:nested-git",
        "skill:backslash",
        "skill:no-skill-file",
      ]);
      expectWithinImportLimits(written);
    });

    it("skips the second skill of a name", () => {
      const written = write([bundleOf({ skills: [skillOf("twice"), skillOf("twice")] })]);

      expect(written.agents[0]?.skills).toEqual(["agents/ada/skills/twice"]);
      expect(written.items.skipped).toEqual([
        { field: "skill:twice", detail: "another skill of this name is already written" },
      ]);
    });

    it("leaves out a skill whose SKILL.md OpenBot could not read, so that it does not refuse the agent", () => {
      const needs = "needs a name of at most 80 characters and a description of at most 1024";
      const written = write([
        bundleOf({
          skills: [
            skillOf("plain", [], "# Plain\n\nNo frontmatter.\n"),
            skillOf("no-description", [], "---\nname: no-description\n---\n# x\n"),
            skillOf("no-name", [], "---\ndescription: Has none.\n---\n# x\n"),
            skillOf("long-name", [], `---\nname: ${"n".repeat(81)}\ndescription: d\n---\n`),
            skillOf("long-description", [], `---\nname: x\ndescription: ${"d".repeat(1025)}\n---\n`),
            skillOf("not-yaml", [], "---\nname: [unclosed\ndescription: d\n---\n"),
            skillOf("not-a-map", [], "---\n- one\n- two\n---\n"),
            { name: "binary", files: [{ path: "SKILL.md", bytes: new Uint8Array([0xff, 0xfe]) }] },
            skillOf("crlf", [], "---\r\nname: crlf\r\ndescription: Works.\r\n---\r\n# x\r\n"),
            skillOf("limits", [], `---\nname: ${"n".repeat(80)}\ndescription: ${"d".repeat(1024)}\n---\n`),
          ],
        }),
      ]);

      expect(written.agents[0]?.skills).toEqual([
        "agents/ada/skills/crlf",
        "agents/ada/skills/limits",
      ]);
      expect(written.items.skipped).toEqual([
        { field: "skill:plain", detail: "its SKILL.md has no frontmatter, which OpenBot needs" },
        { field: "skill:no-description", detail: `the frontmatter of its SKILL.md ${needs}` },
        { field: "skill:no-name", detail: `the frontmatter of its SKILL.md ${needs}` },
        { field: "skill:long-name", detail: `the frontmatter of its SKILL.md ${needs}` },
        { field: "skill:long-description", detail: `the frontmatter of its SKILL.md ${needs}` },
        { field: "skill:not-yaml", detail: "the frontmatter of its SKILL.md is not valid YAML" },
        { field: "skill:not-a-map", detail: `the frontmatter of its SKILL.md ${needs}` },
        { field: "skill:binary", detail: "its SKILL.md is not valid UTF-8" },
      ]);
    });
  });

  describe("avatar and files", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    it("writes the avatar under the folder of the agent", () => {
      const written = write([bundleOf({ avatar: { name: "avatar.PNG", bytes: png } })]);

      expect(written.agents[0]?.avatar).toBe("agents/ada/avatar.png");
      expect(written.files["agents/ada/avatar.png"]).toEqual(png);
    });

    it.each([
      ["a GIF", { name: "avatar.gif", bytes: png }, "OpenBot takes PNG, JPEG or WebP avatars"],
      [
        "an avatar over 512 KB",
        { name: "avatar.png", bytes: new Uint8Array(MAX_AVATAR_BYTES + 1) },
        "OpenBot takes avatars of at most 512 KB",
      ],
    ])("skips %s", (_name, avatar, detail) => {
      const written = write([bundleOf({ avatar })]);

      expect(written.agents[0]?.avatar).toBeNull();
      expect(written.items.skipped).toEqual([{ field: "avatar", detail }]);
    });

    it("writes the files of the workspace only when asked to", () => {
      const files = [{ path: "notes/todo.md", bytes: strToU8("- one") }];

      const without = write([bundleOf({ files })], { ...WRITE_OPTS, includeFiles: false });
      expect(without.agents[0]?.files).toBeNull();
      expect(Object.keys(without.files)).toEqual([OPENBOT_IMPORT_MANIFEST]);

      const withFiles = write([bundleOf({ files })]);
      expect(withFiles.agents[0]?.files).toBe("agents/ada/files");
      expect(strFromU8(withFiles.files["agents/ada/files/notes/todo.md"] as Uint8Array)).toBe(
        "- one",
      );
    });

    it("skips a file whose path OpenBot refuses, and a file that would clash with the long instructions", () => {
      const written = write([
        bundleOf({
          instructions: "g".repeat(2500),
          files: [
            { path: ".env", bytes: strToU8("K=V") },
            { path: "keys/private-key.pem", bytes: strToU8("x") },
            { path: "../up.md", bytes: strToU8("x") },
            { path: "INSTRUCTIONS.md", bytes: strToU8("mine") },
            { path: "ok.md", bytes: strToU8("ok") },
          ],
        }),
      ]);

      expect(
        Object.keys(written.files)
          .filter((path) => path.includes("/files/"))
          .sort(),
      ).toEqual(["agents/ada/files/INSTRUCTIONS.md", "agents/ada/files/ok.md"]);
      expect(written.items.skipped.map(({ field }) => field)).toEqual([
        "file:.env",
        "file:keys/private-key.pem",
        "file:../up.md",
        "file:INSTRUCTIONS.md",
      ]);
      expect(
        strFromU8(written.files["agents/ada/files/INSTRUCTIONS.md"] as Uint8Array),
      ).toHaveLength(2500);
      expectWithinImportLimits(written);
    });
  });
});

// -- Round trips -------------------------------------------------------------------------------

describe("OpenBot zip round trips", () => {
  it("reads back what it wrote for the import fixture", async () => {
    const original = await readOpenBotZip(await packed(IMPORT_DIR, "import.zip"), {
      includeFiles: true,
    });
    const written = write(original.agents.map(({ bundle }) => bundle));

    const again = await readOpenBotZip(await archiveFile(written.bytes), { includeFiles: true });

    expect(again.format).toBe("openbot-agent-import");
    expect(again.agents.map(({ key }) => key)).toEqual(["ada", "min"]);
    for (const [index, { bundle }] of original.agents.entries()) {
      const back = again.agents[index]?.bundle as Bundle;
      expect(back.routines).toEqual(bundle.routines);
      expect(back.facts).toEqual(bundle.facts);
      expect(back.skills).toEqual(bundle.skills);
      expect(back.instructions).toBe(bundle.instructions);
      expect(back.files).toEqual(bundle.files);
      expect(back.avatar).toEqual(bundle.avatar);
      expect(back.manifest.name).toBe(bundle.manifest.name);
      expect(back.manifest.title).toBe(bundle.manifest.title);
    }
    expect(written.items).toEqual({ approximated: [], skipped: [], warnings: [] });
    expectWithinImportLimits(written);
  });

  it("reads back instructions that did not fit in the description", async () => {
    const instructions = `${"A long line of instructions.\n".repeat(120)}The end.\n`;
    const written = write([bundleOf({ instructions })]);

    const { agents } = await readOpenBotZip(await archiveFile(written.bytes), {
      includeFiles: true,
    });

    expect(agents[0]?.bundle.instructions).toBe(instructions);
    expect(agents[0]?.bundle.files).toEqual([]);
  });

  it("reads back the id that was written", async () => {
    const written = write([bundleOf()]);

    const { agents } = await readOpenBotZip(await archiveFile(written.bytes));

    expect(agents[0]?.bundle.manifest.id).toBe(ADA_ID);
  });

  it("reads back each id of an archive of two agents", async () => {
    const written = write([bundleOf(), bundleOf({}, "Bo", BO_ID)]);

    const { agents } = await readOpenBotZip(await archiveFile(written.bytes));

    expect(agents.map(({ bundle }) => bundle.manifest.id)).toEqual([ADA_ID, BO_ID]);
  });

  it("carries the transfer fixture into the import format, but for the one-time routine", async () => {
    const { agents } = await readOpenBotZip(await packed(TRANSFER_DIR, "transfer.zip"));
    const ada = agents[0]?.bundle as Bundle;

    const written = write([ada]);

    expect(written.items.skipped.map(({ field }) => field)).toEqual(["routine:Launch checklist"]);
    const back = await readOpenBotZip(await archiveFile(written.bytes));
    expect(back.agents[0]?.bundle.routines).toEqual(ada.routines.slice(0, 2));
    expect(back.agents[0]?.bundle.manifest["x-openbot"]).toEqual({
      routines: { "Inbox sweep": { anchorAt: "2026-10-28T09:00:00.000Z" } },
    });
    expect(back.agents[0]?.bundle.facts).toEqual(ada.facts);
  });
});

describe("toBundleRoutine", () => {
  const routine = (patch: Partial<OpenBotRoutine> = {}): OpenBotRoutine => ({
    name: "Weekly review",
    instruction: "Summarise the week.",
    active: true,
    timezone: WARSAW,
    schedule: { kind: "weekly", weekday: 1, time: "09:30" },
    ...patch,
  });

  it("gives the routine a bundle holds, and no extra when there is none", () => {
    expect(toBundleRoutine(routine())).toEqual({
      routine: {
        name: "Weekly review",
        instruction: "Summarise the week.",
        enabled: true,
        timezone: WARSAW,
        schedule: { kind: "cron", expression: "30 9 * * 1" },
      },
    });
  });

  it("carries the active flag over as enabled", () => {
    const carried = toBundleRoutine(routine({ active: false }));

    expect("routine" in carried && carried.routine.enabled).toBe(false);
  });

  it("keeps the start of an interval and the two policies as extra", () => {
    const carried = toBundleRoutine(
      routine({
        schedule: { kind: "interval", amount: 2, unit: "hours", anchorAt: "2026-10-27T08:00:00.000Z" },
        limitPolicy: "wait",
        missedPolicy: "run-once",
      }),
    );

    expect(carried).toMatchObject({
      routine: { schedule: { kind: "every", every: "2h" } },
      extra: { anchorAt: "2026-10-27T08:00:00.000Z", limitPolicy: "wait", missedPolicy: "run-once" },
    });
  });

  it("ignores a policy OpenBot does not know, or one that is not text", () => {
    const carried = toBundleRoutine(routine({ limitPolicy: "queue", missedPolicy: 3 }));

    expect(carried).not.toHaveProperty("extra");
  });

  it.each([
    ["has no time zone", { timezone: "" }, "it has no time zone"],
    ["has a zone that does not exist", { timezone: "Mars/Olympus" }, '"Mars/Olympus" is not a time zone'],
    ["has no schedule", { schedule: undefined }, "it has no schedule"],
    ["has a schedule that is not an object", { schedule: "daily" }, "its schedule cannot be carried over"],
    ["has a schedule out of range", { schedule: { kind: "hourly", minute: 99 } }, "its schedule cannot be carried over"],
    ["has a custom schedule that is not cron", { schedule: { kind: "custom", expression: "soon" } }, "its schedule cannot be carried over"],
  ])("says why a routine that %s cannot be carried", (_what, patch, problem) => {
    expect(toBundleRoutine(routine(patch))).toEqual({ problem });
  });

  it("looks at the time zone before the schedule", () => {
    expect(toBundleRoutine(routine({ timezone: "", schedule: undefined }))).toEqual({
      problem: "it has no time zone",
    });
  });
});
