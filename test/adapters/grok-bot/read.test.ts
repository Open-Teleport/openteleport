import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectGrokBot,
  grokBotCacheIdentity,
  listGrokBots,
  readGrokBot,
} from "../../../src/adapters/grok-bot/read.js";
import type { Ctx } from "../../../src/adapters/types.js";
import { parseManifest } from "../../../src/core/schema.js";
import { zipDirectoryToFile } from "../../helpers/zip.js";

const IMPORT_DIR = fileURLToPath(new URL("../../fixtures/openbot/import-v1", import.meta.url));
const TRANSFER_DIR = fileURLToPath(new URL("../../fixtures/openbot/transfer-v1", import.meta.url));

const HINT =
  "Grok Bot keeps agents in the cloud. Ask your Bot to run the OpenBot export skill, then pass --source-dir <openbot-export-*.zip>";
const CLOUD = /^Grok Bot keeps agents in the cloud\. /;

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

let root: string;
let ctx: Ctx;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-grok-bot-read-"));
  await mkdir(join(root, "home"));
  ctx = { home: join(root, "home"), cwd: root, env: {}, exec: noExec, logger: () => {} };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const withZip = (file: string): Ctx => ({ ...ctx, sourceDir: file });

/** The import fixture, zipped to a file of the temp folder. */
const importZip = (name = "openbot-export-2026-10-28.zip"): Promise<string> =>
  zipDirectoryToFile(IMPORT_DIR, join(root, name));

/** A copy of a fixture folder whose manifest `change` edits, zipped to a file of the temp folder. */
async function patchedZip(
  dir: string,
  manifestName: string,
  change: (manifest: Record<string, unknown>) => void,
  name = "patched.zip",
): Promise<string> {
  const copy = await mkdtemp(join(root, "copy-"));
  await cp(dir, copy, { recursive: true });
  const path = join(copy, manifestName);
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  change(manifest);
  await writeFile(path, JSON.stringify(manifest, null, 2));
  return zipDirectoryToFile(copy, join(root, name));
}

describe("detectGrokBot", () => {
  it("finds nothing without --source-dir, and says where Grok Bot keeps its Bots", async () => {
    expect(await detectGrokBot(ctx)).toEqual({ found: false, hint: HINT });
  });

  it("is found with a zip, whose path is the location", async () => {
    const zip = await importZip();
    expect(await detectGrokBot(withZip(zip))).toEqual({ found: true, location: zip });
  });

  it("takes a zip in any case of the extension", async () => {
    const zip = await zipDirectoryToFile(IMPORT_DIR, join(root, "EXPORT.ZIP"));
    expect(await detectGrokBot(withZip(zip))).toEqual({ found: true, location: zip });
  });

  it("is not found with a folder, a file that is not a zip or a path that is not there", async () => {
    await writeFile(join(root, "notes.txt"), "x");
    for (const path of [root, join(root, "notes.txt"), join(root, "missing.zip")]) {
      expect(await detectGrokBot(withZip(path))).toEqual({
        found: false,
        location: path,
        hint: HINT,
      });
    }
  });

  it("does not look at the target directory", async () => {
    const zip = await importZip();
    expect(await detectGrokBot({ ...ctx, targetDir: zip })).toEqual({ found: false, hint: HINT });
  });

  it("resolves a relative --source-dir against the working directory", async () => {
    await importZip("relative.zip");
    expect(await detectGrokBot(withZip("relative.zip"))).toEqual({
      found: true,
      location: join(root, "relative.zip"),
    });
  });
});

describe("listGrokBots", () => {
  it("lists the Bots of an agent import zip: key as id, name, title, and the zip with the key as location", async () => {
    const zip = await importZip();
    expect(await listGrokBots(withZip(zip))).toEqual([
      { id: "ada", name: "Ada", title: "Release manager", location: `${zip}#ada` },
      { id: "min", name: "Min", title: "Minimal agent", location: `${zip}#min` },
    ]);
  });

  it("lists the agents of an instance transfer zip as well", async () => {
    const zip = await zipDirectoryToFile(TRANSFER_DIR, join(root, "transfer.zip"));
    expect(await listGrokBots(withZip(zip))).toEqual([
      { id: "ada", name: "Ada", title: "Release manager", location: `${zip}#ada` },
    ]);
  });

  it("explains that Grok Bot keeps its Bots in the cloud when there is no --source-dir", async () => {
    await expect(listGrokBots(ctx)).rejects.toThrow(HINT);
  });

  it("explains it for a folder too, and names the folder", async () => {
    const error = await listGrokBots(withZip(root)).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(CLOUD);
    expect((error as Error).message).toContain(`${root} is a folder, not a zip file`);
  });

  it("says when the zip is not there or is not a zip by name", async () => {
    await writeFile(join(root, "notes.txt"), "x");
    await expect(listGrokBots(withZip(join(root, "missing.zip")))).rejects.toThrow(
      `${join(root, "missing.zip")} does not exist`,
    );
    await expect(listGrokBots(withZip(join(root, "notes.txt")))).rejects.toThrow(
      `${join(root, "notes.txt")} is not a .zip file`,
    );
  });

  it("passes on what the zip reader says about a file that is not an OpenBot archive", async () => {
    const zip = join(root, "plain.zip");
    await writeFile(zip, zipSync({ "readme.txt": new TextEncoder().encode("hello") }));
    await expect(listGrokBots(withZip(zip))).rejects.toThrow(/not an OpenBot archive/);
  });
});

describe("readGrokBot", () => {
  it("reads a Bot of an agent import by its key", async () => {
    const zip = await importZip();
    const { bundle, warnings } = await readGrokBot(withZip(zip), "ada");
    const { manifest } = bundle;
    expect(manifest.name).toBe("Ada");
    expect(manifest.title).toBe("Release manager");
    expect(manifest.origin).toEqual({ app: "grok-bot", exportedAt: "2026-10-28T10:00:00.000Z" });
    expect(bundle.routines).toHaveLength(8);
    expect(bundle.skills.map((skill) => skill.name)).toEqual(["release-notes", "triage"]);
    expect(bundle.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md", "template.md"]);
    expect(bundle.facts).toEqual([
      "The user reports in EUR.",
      "Releases freeze on the last Thursday of the month.",
      "Bug reports tagged security go to the user first.",
    ]);
    expect(bundle.avatar?.name).toBe("avatar.png");
    expect(bundle.instructions).toContain("Ada keeps releases on track");
    // The id is the engine's to give: this zip was not made by OpenTeleport.
    expect(manifest.id).toBe("");
    expect(() => parseManifest({ ...manifest, id: "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T" })).not.toThrow();
    // The channel of the archive is not moved, and the reader says so.
    expect(warnings).toEqual([expect.stringContaining("channel")]);
  });

  it("reads the minimal Bot, and by its name in any case", async () => {
    const zip = await importZip();
    const byKey = await readGrokBot(withZip(zip), "min");
    expect(byKey.bundle.manifest.name).toBe("Min");
    expect(byKey.bundle.routines).toEqual([]);
    expect(byKey.bundle.skills).toEqual([]);
    expect(byKey.bundle.facts).toEqual([]);
    for (const wanted of ["Min", "min", "MIN"]) {
      expect((await readGrokBot(withZip(zip), wanted)).bundle).toEqual(byKey.bundle);
    }
    expect((await readGrokBot(withZip(zip), "Ada")).bundle.manifest.name).toBe("Ada");
  });

  it("takes a key before a name, and refuses a name that two Bots share", async () => {
    const zip = await patchedZip(IMPORT_DIR, "openbot-import.json", (manifest) => {
      const agents = manifest.agents as { key: string; name: string }[];
      (agents[1] as { name: string }).name = "ADA";
      agents.push({ ...(agents[1] as object), key: "third", name: "Third" } as never);
    });
    expect((await readGrokBot(withZip(zip), "ada")).bundle.manifest.name).toBe("Ada");
    expect((await readGrokBot(withZip(zip), "Third")).bundle.manifest.name).toBe("Third");
    await expect(readGrokBot(withZip(zip), "Ada")).rejects.toThrow(
      `Several Bots in ${zip} are called "Ada": ada, min. Pass the key.`,
    );
  });

  it("names the Bots there are when the one asked for is not in the zip", async () => {
    const zip = await importZip();
    await expect(readGrokBot(withZip(zip), "nobody")).rejects.toThrow(
      `${zip} has no Bot "nobody". Available: ada, min`,
    );
  });

  it("keeps the id that a zip made by OpenTeleport carries", async () => {
    const id = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
    const zip = await patchedZip(IMPORT_DIR, "openbot-import.json", (manifest) => {
      (manifest.agents as Record<string, unknown>[])[0]!["x-openteleport"] = { id };
    });
    expect((await readGrokBot(withZip(zip), "ada")).bundle.manifest.id).toBe(id);
    expect((await readGrokBot(withZip(zip), "min")).bundle.manifest.id).toBe("");
  });

  it("warns, and does not fail, when the archive was made by another app", async () => {
    const zip = await patchedZip(IMPORT_DIR, "openbot-import.json", (manifest) => {
      (manifest.source as Record<string, unknown>).app = "openbot";
    });
    const { bundle, warnings } = await readGrokBot(withZip(zip), "ada");
    expect(warnings).toContain(
      'The archive says it was made by "openbot", not by Grok Bot; it is read the same way.',
    );
    // The Bot is still a Grok Bot as far as the bundle is concerned.
    expect(bundle.manifest.origin?.app).toBe("grok-bot");
  });

  it("does not warn about the app when the archive says grok-bot", async () => {
    const { warnings } = await readGrokBot(withZip(await importZip()), "ada");
    expect(warnings.some((warning) => warning.includes("made by"))).toBe(false);
  });

  it("reads an instance transfer with a warning, not an error, and does not pass OpenBot's version off as Grok Bot's", async () => {
    const zip = await zipDirectoryToFile(TRANSFER_DIR, join(root, "transfer.zip"));
    const { bundle, warnings } = await readGrokBot(withZip(zip), "ada");
    expect(warnings).toContain(
      'The archive says it was made by "openbot", not by Grok Bot; it is read the same way.',
    );
    expect(warnings.some((warning) => warning.includes("settings"))).toBe(true);
    expect(bundle.manifest.origin).toEqual({
      app: "grok-bot",
      exportedAt: "2026-10-28T10:00:00.000Z",
    });
    expect(bundle.routines.map((routine) => routine.name)).toEqual([
      "Quarterly review",
      "Inbox sweep",
      "Launch checklist",
    ]);
    // What OpenBot knows and Grok Bot does not stays in the manifest, for a move back.
    expect(bundle.manifest["x-openbot"]).toBeDefined();
  });

  it("shows an app name that holds control characters as an escaped string", async () => {
    const zip = await patchedZip(IMPORT_DIR, "openbot-import.json", (manifest) => {
      (manifest.source as Record<string, unknown>).app = "evil\u001b[2J\nline";
    });
    const { warnings } = await readGrokBot(withZip(zip), "ada");
    const warning = warnings.find((text) => text.includes("made by")) as string;
    expect(warning).not.toMatch(/[\u0000-\u001f]/);
    expect(warning).toContain("\\u001b[2J\\nline");
  });

  it("explains that Grok Bot keeps its Bots in the cloud for a folder and for no --source-dir", async () => {
    await expect(readGrokBot(withZip(root), "ada")).rejects.toThrow(CLOUD);
    await expect(readGrokBot(ctx, "ada")).rejects.toThrow(HINT);
  });

  it("never changes the zip it reads", async () => {
    const zip = await importZip();
    const before = await readFile(zip);
    await listGrokBots(withZip(zip));
    await readGrokBot(withZip(zip), "ada");
    await grokBotCacheIdentity(withZip(zip), "ada");
    expect((await readFile(zip)).equals(before)).toBe(true);
  });
});

describe("grokBotCacheIdentity", () => {
  it("names the format and the key, not the date of the export or the path", async () => {
    const first = await importZip("openbot-export-2026-10-28.zip");
    const later = await patchedZip(
      IMPORT_DIR,
      "openbot-import.json",
      (manifest) => {
        (manifest.source as Record<string, unknown>).exportedAt = "2026-11-02T08:00:00.000Z";
      },
      "openbot-export-2026-11-02.zip",
    );
    expect(await grokBotCacheIdentity(withZip(first), "ada")).toBe("zip:openbot-agent-import:ada");
    expect(await grokBotCacheIdentity(withZip(later), "ada")).toBe("zip:openbot-agent-import:ada");
    expect(await grokBotCacheIdentity(withZip(first), "min")).toBe("zip:openbot-agent-import:min");
  });

  it("gives the key when the Bot is asked for by name", async () => {
    const zip = await importZip();
    expect(await grokBotCacheIdentity(withZip(zip), "Ada")).toBe("zip:openbot-agent-import:ada");
  });

  it("names the other format for an instance transfer", async () => {
    const zip = await zipDirectoryToFile(TRANSFER_DIR, join(root, "transfer.zip"));
    expect(await grokBotCacheIdentity(withZip(zip), "ada")).toBe(
      "zip:openbot-instance-transfer:ada",
    );
  });

  it("fails for a Bot that is not in the zip", async () => {
    const zip = await importZip();
    await expect(grokBotCacheIdentity(withZip(zip), "nobody")).rejects.toThrow(/no Bot "nobody"/);
  });
});
