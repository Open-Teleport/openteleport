import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lettaAdapter } from "../../../src/adapters/letta/index.js";
import { readMemFs } from "../../../src/adapters/letta/memfs.js";
import { renderCommands, routineSlugs, writeLettaAgent } from "../../../src/adapters/letta/write.js";
import { readMarker } from "../../../src/adapters/marker.js";
import type { Ctx, WriteOpts } from "../../../src/adapters/types.js";
import { move } from "../../../src/core/engine.js";
import { splitFrontmatter } from "../../../src/core/frontmatter.js";
import type { Bundle } from "../../../src/core/schema.js";
import { proseToFacts } from "../../../src/core/text.js";
import { ADA_ID, OTHER_ID, adaBundle, bytes } from "./ada.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/letta/home/.letta", import.meta.url));

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

const ENABLE: WriteOpts = { enableRoutines: true, includeFiles: false, onConflict: "update" };
const DEFAULT: WriteOpts = { ...ENABLE, enableRoutines: false };
const COPY: WriteOpts = { ...ENABLE, onConflict: "copy" };
const REPLACE: WriteOpts = { ...ENABLE, onConflict: "replace" };
const BOM_BYTES = [0xef, 0xbb, 0xbf];

/** Whether this machine lets the tests create directory symbolic links. */
const canSymlink = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "openteleport-symlink-"));
  try {
    await mkdir(join(dir, "target"));
    await symlink(join(dir, "target"), join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

let root: string;
let home: string;
let cwd: string;
let ctx: Ctx;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-letta-write-"));
  home = join(root, "home");
  cwd = join(root, "cwd");
  await mkdir(home);
  await mkdir(cwd);
  ctx = { home, cwd, env: {}, exec: noExec, logger: () => {} };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const text = (path: string): Promise<string> => readFile(path, "utf8");
/** A path as the scripts spell it. */
const inScript = (path: string): string => (sep === "\\" ? path.replaceAll("\\", "/") : path);
const lines = (script: string): string[] => script.split("\n");

/** Every file below `dir` as a sorted list of `/`-separated paths. */
async function listing(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      found.push(join(entry.parentPath, entry.name).slice(dir.length + 1).split(sep).join("/"));
    }
  }
  return found.sort();
}

const ADA_DIR = (): string => join(cwd, "ada-letta-memory");

describe("writeLettaAgent: the folder", () => {
  it("hands over a folder in the working directory", async () => {
    const result = await writeLettaAgent(ctx, adaBundle(), ENABLE);
    expect(result.outcome).toBe("handoff");
    expect(result.artifactPath).toBe(ADA_DIR());
    expect(result.targetAgentId).toBeUndefined();
    expect(result.nextStep).toBe(
      `Run ${join(ADA_DIR(), "letta-commands.sh")} (or .ps1): it creates the agent, restores its memory and adds the routines`,
    );
    expect(await listing(ADA_DIR())).toEqual([
      ".openteleport.json",
      "README.md",
      "letta-commands.ps1",
      "letta-commands.sh",
      "memory/MEMORY.md",
      "memory/human.md",
      "memory/instructions.md",
      "memory/persona.md",
      "memory/reference/MEMORY.md",
      "memory/reference/diary.md",
      "memory/reference/sources.md",
      "memory/skills/web-brief/SKILL.md",
      "memory/skills/web-brief/references/checklist.md",
      "routines/half-hourly-check.txt",
      "routines/launch-day.txt",
      "routines/morning-digest.txt",
    ]);
  });

  it("lays the memory out as MemFS: persona, instructions, facts, notes and skills", async () => {
    await writeLettaAgent(ctx, adaBundle(), ENABLE);
    const memory = join(ADA_DIR(), "memory");
    expect(splitFrontmatter(await text(join(memory, "persona.md")))).toEqual({
      data: { name: "persona", description: "Research assistant" },
      body: "Curious, precise and brief.\n",
    });
    expect(await text(join(memory, "instructions.md"))).toBe(
      "Read the papers first.\nThen summarise them.\n",
    );
    expect(proseToFacts(await text(join(memory, "human.md"))).facts).toEqual(adaBundle().facts);
    expect(await text(join(memory, "reference", "diary.md"))).toBe("# Diary\n\nWrote the first brief.\n");
    expect(await text(join(memory, "reference", "MEMORY.md"))).toContain("- sources.md: Sources");
    const index = await text(join(memory, "MEMORY.md"));
    for (const name of ["persona.md", "instructions.md", "human.md", "reference/"]) {
      expect(index).toContain(`- ${name}: `);
    }
    expect(await text(join(memory, "skills", "web-brief", "SKILL.md"))).toContain("# Web brief");
  });

  it("keeps the marker in the root of the folder, outside the memory", async () => {
    await writeLettaAgent(ctx, adaBundle(), ENABLE);
    expect((await readMarker(ADA_DIR()))?.id).toBe(ADA_ID);
    expect((await readdir(join(ADA_DIR(), "memory"), { recursive: true })).join("\n")).not.toContain(
      ".openteleport.json",
    );
  });

  it("explains the folder and the one step that is left", async () => {
    await writeLettaAgent(ctx, adaBundle(), ENABLE);
    const readme = await text(join(ADA_DIR(), "README.md"));
    expect(readme.startsWith("# Ada for Letta Code\n")).toBe(true);
    for (const needle of ["letta-commands.sh", "letta-commands.ps1", "letta memory restore", "has not been verified"]) {
      expect(readme).toContain(needle);
    }
  });

  it("reads the prompt files by literal path, so that [ and ] in the folder are not a wildcard", async () => {
    const out = join(root, "out[x]", "[1]");
    const result = await writeLettaAgent({ ...ctx, targetDir: out }, adaBundle(), ENABLE);
    const dir = result.artifactPath as string;
    const ps1 = await text(join(dir, "letta-commands.ps1"));
    const prompts = lines(ps1).filter((line) => line.includes("Get-Content"));
    expect(prompts).toHaveLength(3);
    for (const line of prompts) {
      expect(line).toContain(`(Get-Content -Raw -Encoding UTF8 -LiteralPath "${inScript(out)}/`);
    }
    // The prompt is in the folder with brackets in its name.
    expect(await text(join(dir, "routines", "launch-day.txt"))).toBe("Post the launch note.");
    // The shell script needs no such care: `cat` takes the path as it is.
    expect(await text(join(dir, "letta-commands.sh"))).toContain(`cat "${inScript(out)}/`);
  });

  it("writes each routine's prompt byte for byte", async () => {
    const bundle = adaBundle();
    const prompt = "Line one,\r\n\r\n  indented \"two\" with $HOME and `ticks`\n\nZażółć gęślą jaźń\n";
    bundle.routines[0] = { ...(bundle.routines[0] as Bundle["routines"][number]), instruction: prompt };
    await writeLettaAgent(ctx, bundle, ENABLE);
    const written = await readFile(join(ADA_DIR(), "routines", "morning-digest.txt"));
    expect(written.equals(Buffer.from(prompt, "utf8"))).toBe(true);
    expect(await text(join(ADA_DIR(), "routines", "half-hourly-check.txt"))).toBe("Check the inbox.");
  });

  it("writes into the target directory when there is one, creating it", async () => {
    const out = join(root, "out", "deeper");
    const result = await writeLettaAgent({ ...ctx, targetDir: out }, adaBundle(), ENABLE);
    expect(result.artifactPath).toBe(join(out, "ada-letta-memory"));
    expect(await text(join(out, "ada-letta-memory", "memory", "persona.md"))).toContain(
      "name: persona\n",
    );
    // A relative target directory is relative to the working directory.
    const relative = await writeLettaAgent({ ...ctx, targetDir: "rel" }, adaBundle(), ENABLE);
    expect(relative.artifactPath).toBe(join(cwd, "rel", "ada-letta-memory"));
  });

  it("names the folder after a slug of the agent's name", async () => {
    const named = (name: string): Bundle => {
      const bundle = adaBundle();
      bundle.manifest.name = name;
      return bundle;
    };
    expect((await writeLettaAgent(ctx, named("Ada Lovelace"), ENABLE)).artifactPath).toBe(
      join(cwd, "ada-lovelace-letta-memory"),
    );
    expect((await writeLettaAgent(ctx, named("***"), ENABLE)).artifactPath).toBe(
      join(cwd, "agent-letta-memory"),
    );
    expect((await writeLettaAgent(ctx, named("../../evil"), ENABLE)).artifactPath).toBe(
      join(cwd, "evil-letta-memory"),
    );
  });

  it("does not change the bundle it is given", async () => {
    const bundle = adaBundle();
    const before = JSON.stringify(bundle);
    await writeLettaAgent(ctx, bundle, ENABLE);
    expect(JSON.stringify(bundle)).toBe(before);
  });

  it.skipIf(process.platform === "win32")("makes the shell script executable", async () => {
    await writeLettaAgent(ctx, adaBundle(), ENABLE);
    expect((await stat(join(ADA_DIR(), "letta-commands.sh"))).mode & 0o111).not.toBe(0);
  });

  it("leaves out and reports a note and a skill that cannot be written, and writes nothing outside", async () => {
    const bundle: Bundle = {
      ...adaBundle(),
      notes: [{ name: "../escape", text: "x" }],
      skills: [{ name: "../evil", files: [{ path: "SKILL.md", bytes: bytes("x") }] }],
    };
    const result = await writeLettaAgent(ctx, bundle, ENABLE);
    expect(result.items.skipped.map((item) => item.field)).toEqual(["note:../escape", "skill:../evil"]);
    expect(await listing(cwd)).not.toContain("evil/SKILL.md");
    expect((await listing(ADA_DIR())).filter((path) => /evil|escape/.test(path))).toEqual([]);
  });

  it("writes a folder for an agent with nothing but a name", async () => {
    const bundle: Bundle = {
      manifest: { schemaVersion: "0.1", id: ADA_ID, name: "Bare", models: [], capabilities: [] },
      instructions: "",
      skills: [],
      routines: [],
      facts: [],
      notes: [],
      files: [],
      unknownPaths: [],
    };
    const result = await writeLettaAgent(ctx, bundle, ENABLE);
    const dir = join(cwd, "bare-letta-memory");
    expect(await listing(dir)).toEqual([
      ".openteleport.json",
      "README.md",
      "letta-commands.ps1",
      "letta-commands.sh",
      "memory/MEMORY.md",
      "memory/persona.md",
    ]);
    expect(await text(join(dir, "letta-commands.sh"))).not.toContain("cron add");
    expect(result.items.approximated).toEqual([]);
    expect(result.items.skipped).toEqual([]);
  });
});

describe("writeLettaAgent: the scripts", () => {
  it("makes a shell script that creates the agent, asks for its id, restores the memory and adds the routines", async () => {
    await writeLettaAgent(ctx, adaBundle(), ENABLE);
    const script = await text(join(ADA_DIR(), "letta-commands.sh"));
    const memory = inScript(join(ADA_DIR(), "memory"));
    const routines = inScript(join(ADA_DIR(), "routines"));

    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script.endsWith("\n")).toBe(true);
    expect(lines(script)).toContain('set -eu');
    expect(lines(script)).toContain(
      'letta agents create --name "Ada" --description "Research assistant" --model "anthropic/claude-opus-5-5"',
    );
    expect(script).toContain('read -r -p "Agent id printed above: " AGENT_ID');
    expect(lines(script)).toContain(
      `letta memory restore --agent "$AGENT_ID" --from "${memory}" --force`,
    );
    // Order: create, ask, restore, then the routines.
    const at = (needle: string): number => script.indexOf(needle);
    expect(at("agents create")).toBeLessThan(at("read -r -p"));
    expect(at("read -r -p")).toBeLessThan(at("memory restore"));
    expect(at("memory restore")).toBeLessThan(at("cron add"));

    expect(lines(script)).toContain(
      `letta cron add --name "Morning digest" --prompt "$(cat "${routines}/morning-digest.txt")" --cron "0 8 * * 1-5" --agent "$AGENT_ID"`,
    );
    expect(lines(script)).toContain(
      `letta cron add --name "Launch day" --prompt "$(cat "${routines}/launch-day.txt")" --at "2026-12-01T07:00:00.000Z" --agent "$AGENT_ID"`,
    );
    // The paused routine is a comment, with the reason above it; an interval becomes cron.
    const paused = lines(script).findIndex((line) => line.startsWith("# paused in the source"));
    expect(lines(script)[paused]).toBe("# paused in the source; uncomment to add it");
    expect(lines(script)[paused + 1]).toBe(
      `# letta cron add --name "Half hourly check" --prompt "$(cat "${routines}/half-hourly-check.txt")" --cron "*/30 * * * *" --agent "$AGENT_ID"`,
    );
    expect(lines(script).filter((line) => line.startsWith("letta cron add"))).toHaveLength(2);
    expect(lines(script)).toContain("# Morning digest: every weekday at 08:00 (Europe/Warsaw)");
    expect(lines(script)).toContain("# Half hourly check: every 30m (UTC)");
  });

  it("makes a PowerShell script with the same steps", async () => {
    await writeLettaAgent(ctx, adaBundle(), ENABLE);
    const raw = await readFile(join(ADA_DIR(), "letta-commands.ps1"));
    // A byte order mark, so that Windows PowerShell 5.1 reads the file as UTF-8.
    expect([...raw.subarray(0, 3)]).toEqual(BOM_BYTES);
    const script = raw.toString("utf8").slice(1);
    const memory = inScript(join(ADA_DIR(), "memory"));
    const routines = inScript(join(ADA_DIR(), "routines"));

    expect(lines(script)).toContain('$ErrorActionPreference = "Stop"');
    expect(lines(script)).toContain(
      'letta agents create --name "Ada" --description "Research assistant" --model "anthropic/claude-opus-5-5"',
    );
    expect(script).toContain('$AGENT_ID = Read-Host "Agent id printed above"');
    expect(script).toContain("IsNullOrWhiteSpace($AGENT_ID)");
    expect(lines(script)).toContain(
      `letta memory restore --agent "$AGENT_ID" --from "${memory}" --force`,
    );
    expect(lines(script)).toContain(
      `letta cron add --name "Morning digest" --prompt (Get-Content -Raw -Encoding UTF8 -LiteralPath "${routines}/morning-digest.txt") --cron "0 8 * * 1-5" --agent "$AGENT_ID"`,
    );
    expect(lines(script)).toContain(
      `# letta cron add --name "Half hourly check" --prompt (Get-Content -Raw -Encoding UTF8 -LiteralPath "${routines}/half-hourly-check.txt") --cron "*/30 * * * *" --agent "$AGENT_ID"`,
    );
    // Each command is checked, and a commented one is commented together with its check.
    expect(script.match(/\$LASTEXITCODE -ne 0/g)).toHaveLength(5);
    expect(lines(script)).toContain('# if ($LASTEXITCODE -ne 0) { throw "letta cron add failed" }');
    expect(script).not.toContain("cat ");
  });

  it("makes up for Windows PowerShell 5.1 losing the double quotes inside an argument", async () => {
    await writeLettaAgent(ctx, adaBundle(), ENABLE);
    const ps1 = await text(join(ADA_DIR(), "letta-commands.ps1"));
    // A function named like the program, ahead of the first call, that only escapes on 5.1.
    expect(ps1.indexOf("function letta {")).toBeGreaterThan(-1);
    expect(ps1.indexOf("function letta {")).toBeLessThan(ps1.indexOf("letta agents create"));
    expect(ps1).toContain("$PSVersionTable.PSVersion.Major -lt 6");
    expect(ps1).toContain("& $command.Source @arguments");
    expect(ps1).toContain("-ErrorAction SilentlyContinue");
    expect(await text(join(ADA_DIR(), "letta-commands.sh"))).not.toContain("function");
  });

  it("leaves every routine as a comment unless routines are enabled", async () => {
    await writeLettaAgent(ctx, adaBundle(), DEFAULT);
    for (const file of ["letta-commands.sh", "letta-commands.ps1"]) {
      const script = await text(join(ADA_DIR(), file));
      expect(lines(script).filter((line) => /^\s*letta cron add/.test(line))).toEqual([]);
      expect(lines(script).filter((line) => line.startsWith("# letta cron add"))).toHaveLength(3);
      expect(lines(script).filter((line) => line.startsWith("# left out because routines move disabled")))
        .toHaveLength(2);
      expect(lines(script).filter((line) => line.startsWith("# paused in the source"))).toHaveLength(1);
    }
  });

  it("creates the agent without a description or a model when there are none", async () => {
    const bundle = adaBundle();
    delete bundle.manifest.title;
    bundle.manifest.models = [];
    await writeLettaAgent(ctx, bundle, ENABLE);
    expect(lines(await text(join(ADA_DIR(), "letta-commands.sh")))).toContain(
      'letta agents create --name "Ada"',
    );
  });

  it("uses the description for the agent when there is no title", () => {
    const bundle = adaBundle();
    delete bundle.manifest.title;
    bundle.manifest.description = "Reads papers.";
    expect(renderCommands(bundle, "/x/ada-letta-memory", "sh")).toContain(
      'letta agents create --name "Ada" --description "Reads papers." --model',
    );
  });

  it("restores a task's own description, as the manifest kept it", () => {
    const bundle = adaBundle();
    bundle.manifest["x-letta"] = { routines: { "Morning digest": { description: "News, short", conversation_id: "c1" } } };
    const script = renderCommands(bundle, "/x/ada-letta-memory", "sh");
    expect(script).toContain('--name "Morning digest" --description "News, short" --prompt');
    expect(script).not.toContain("c1");
  });

  it("does not put what a name says outside its quotes or its comment", () => {
    const evil = 'x"; rm -rf ~ #\n$(reboot)\r\n`id`';
    const bundle = adaBundle();
    bundle.manifest.name = evil;
    bundle.manifest.title = evil;
    bundle.routines = [
      { ...(bundle.routines[0] as Bundle["routines"][number]), name: evil, enabled: false },
      { ...(bundle.routines[0] as Bundle["routines"][number]), name: evil, enabled: true },
    ];
    for (const shell of ["sh", "ps1"] as const) {
      const script = renderCommands(bundle, "/x/ada-letta-memory", shell);
      // Every line is one of the lines the script is made of, or a comment.
      const unexpected = lines(script).filter(
        (line) =>
          line !== "" &&
          !/^(#|letta |read |set |if |fi$|exit |function |\$|\}|  )/.test(line),
      );
      expect(unexpected).toEqual([]);
      expect(lines(script).filter((line) => line.startsWith("letta cron add"))).toHaveLength(1);
      const quoted = shell === "sh" ? 'x\\"; rm -rf ~ # \\$(reboot) \\`id\\`' : 'x`"; rm -rf ~ # `$(reboot) ``id``';
      expect(script).toContain(`letta agents create --name "${quoted}" --description "${quoted}"`);
    }
  });

  it("sets the curly quotes PowerShell takes for a quote aside", () => {
    const bundle = adaBundle();
    bundle.manifest.name = `Ada ${String.fromCharCode(0x201e)}the Second${String.fromCharCode(0x201d)}`;
    const script = renderCommands(bundle, "/x/ada-letta-memory", "ps1");
    expect(script).toContain(
      `--name "Ada \`${String.fromCharCode(0x201e)}the Second\`${String.fromCharCode(0x201d)}"`,
    );
  });
});

describe("routineSlugs", () => {
  it("makes one file stem per routine, unique and safe on every system", () => {
    const names = ["Daily", "daily!", "***", "CON", "Zażółć", "x".repeat(100)];
    const routines = names.map((name) => ({ ...(adaBundle().routines[0] as Bundle["routines"][number]), name }));
    expect(routineSlugs(routines)).toEqual(["daily", "daily-2", "routine", "con-r", "za", "x".repeat(64)]);
  });

  it("keeps two routines of one name apart on disk", async () => {
    const bundle = adaBundle();
    const first = bundle.routines[0] as Bundle["routines"][number];
    bundle.routines = [first, { ...first, instruction: "Second prompt." }];
    await writeLettaAgent(ctx, bundle, ENABLE);
    expect(await text(join(ADA_DIR(), "routines", "morning-digest-2.txt"))).toBe("Second prompt.");
    expect(await text(join(ADA_DIR(), "letta-commands.sh"))).toContain("morning-digest-2.txt");
  });
});

describe("writeLettaAgent: the report", () => {
  it("says what it approximated", async () => {
    const { items } = await writeLettaAgent(ctx, adaBundle(), ENABLE);
    expect(items.approximated).toEqual([
      {
        field: "models",
        detail: "passed as --model anthropic/claude-opus-5-5; Letta may not know this handle",
      },
      {
        field: "instructions",
        detail:
          "written to memory/instructions.md, which Letta loads on every turn like core memory; it is not the agent's system prompt",
      },
      {
        field: "routine:Morning digest",
        detail:
          "letta cron add takes no time zone, so the expression is read in Letta's own zone, not Europe/Warsaw",
      },
      { field: "routine:Half hourly check", detail: "every 30m is written as a cron expression" },
    ]);
    expect(items.skipped).toEqual([]);
  });

  it("warns that a restore replaces the whole memory and that a plain folder is unverified", async () => {
    const { items } = await writeLettaAgent(ctx, adaBundle(), ENABLE);
    expect(items.warnings).toEqual([
      "`letta memory restore` replaces the agent's whole memory directory; the script runs it on the new agent only",
      "Letta's `memory restore --from <dir>` is documented for backups made by `memory backup`; a plain memory folder is assumed to work (unverified)",
    ]);
  });

  it("says when an interval does not come out exactly", async () => {
    const bundle = adaBundle();
    const first = bundle.routines[0] as Bundle["routines"][number];
    bundle.routines = ["90m", "5h", "3d", "1d", "2h"].map((every) => ({
      ...first,
      name: `Every ${every}`,
      schedule: { kind: "every" as const, every },
    }));
    const { items } = await writeLettaAgent(ctx, bundle, ENABLE);
    const inexact = "; it fires at fixed times of the clock, not strictly that far apart";
    expect(items.approximated.filter((item) => item.field.startsWith("routine:"))).toEqual([
      { field: "routine:Every 90m", detail: `every 90m is written as a cron expression${inexact}` },
      { field: "routine:Every 5h", detail: `every 5h is written as a cron expression${inexact}` },
      { field: "routine:Every 3d", detail: `every 3d is written as a cron expression${inexact}` },
      { field: "routine:Every 1d", detail: "every 1d is written as a cron expression" },
      { field: "routine:Every 2h", detail: "every 2h is written as a cron expression" },
    ]);
  });

  it("does not mention a time zone for a cron routine in UTC", async () => {
    const bundle = adaBundle();
    bundle.routines = [{ ...(bundle.routines[0] as Bundle["routines"][number]), timezone: "UTC" }];
    const { items } = await writeLettaAgent(ctx, bundle, ENABLE);
    expect(items.approximated.map((item) => item.field)).toEqual(["models", "instructions"]);
  });

  it("passes a model that already starts with its provider as it is, and counts the rest", async () => {
    const bundle = adaBundle();
    bundle.manifest.models = [
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-5" },
      { provider: "openai", model: "gpt-5.5" },
      { runtime: "codex" },
    ];
    const { items } = await writeLettaAgent(ctx, bundle, ENABLE);
    expect(await text(join(ADA_DIR(), "letta-commands.sh"))).toContain(
      '--model "anthropic/claude-sonnet-4-5"',
    );
    expect(items.approximated[0]).toEqual({
      field: "models",
      detail:
        "passed as --model anthropic/claude-sonnet-4-5; Letta may not know this handle, and 1 other preference not used",
    });
  });

  it("says when no preference names both a provider and a model", async () => {
    const bundle = adaBundle();
    bundle.manifest.models = [{ model: "gpt-5.5" }];
    const { items } = await writeLettaAgent(ctx, bundle, ENABLE);
    expect(items.approximated[0]).toEqual({
      field: "models",
      detail: "no preference names both a provider and a model; Letta's default model applies",
    });
    expect(await text(join(ADA_DIR(), "letta-commands.sh"))).not.toContain("--model");
  });

  it("says nothing about instructions when there are none", async () => {
    const bundle = adaBundle();
    bundle.instructions = "";
    const { items } = await writeLettaAgent(ctx, bundle, ENABLE);
    expect(items.approximated.map((item) => item.field)).not.toContain("instructions");
    expect(await listing(ADA_DIR())).not.toContain("memory/instructions.md");
  });

  it("says that the long description has no place beside the title", async () => {
    const bundle = adaBundle();
    bundle.manifest.description = "Reads papers and web pages.";
    const { items } = await writeLettaAgent(ctx, bundle, ENABLE);
    expect(items.skipped).toEqual([
      { field: "description", detail: "Letta has no field for it beside the title, which is used" },
    ]);
  });
});

describe("writeLettaAgent: a folder that is already there", () => {
  it("writes over its own folder when the same agent is moved again, leaving nothing of the old version", async () => {
    await writeLettaAgent(ctx, adaBundle(), ENABLE);
    await writeFile(join(ADA_DIR(), "my-own-notes.txt"), "mine");

    const next = adaBundle();
    next.notes = [next.notes[0] as Bundle["notes"][number]];
    next.routines = [next.routines[2] as Bundle["routines"][number]];
    next.facts = ["Only one now"];
    next.skills = [];
    const result = await writeLettaAgent(ctx, next, ENABLE);

    expect(result.artifactPath).toBe(ADA_DIR());
    expect(result.items.warnings).toHaveLength(2); // the two fixed ones, no conflict warning
    expect(await listing(ADA_DIR())).toEqual([
      ".openteleport.json",
      "README.md",
      "letta-commands.ps1",
      "letta-commands.sh",
      "memory/MEMORY.md",
      "memory/human.md",
      "memory/instructions.md",
      "memory/persona.md",
      "memory/reference/MEMORY.md",
      "memory/reference/diary.md",
      "my-own-notes.txt",
      "routines/launch-day.txt",
    ]);
    expect(await text(join(ADA_DIR(), "memory", "human.md"))).toBe("- Only one now\n");
    expect(await text(join(ADA_DIR(), "my-own-notes.txt"))).toBe("mine");
    expect(await text(join(ADA_DIR(), "letta-commands.sh"))).not.toContain("Morning digest");
    expect(await readdir(cwd)).toEqual(["ada-letta-memory"]);
  });

  it("writes another agent of the same name next to a folder with no marker, and says so", async () => {
    await mkdir(ADA_DIR());
    await writeFile(join(ADA_DIR(), "theirs.txt"), "theirs");
    const result = await writeLettaAgent(ctx, adaBundle(), ENABLE);

    const second = join(cwd, "ada-letta-memory-2");
    expect(result.artifactPath).toBe(second);
    expect(result.items.warnings[0]).toBe(
      `${ADA_DIR()} holds no .openteleport.json of this agent; written as ${second}`,
    );
    expect(await listing(ADA_DIR())).toEqual(["theirs.txt"]);
    expect((await readMarker(second))?.id).toBe(ADA_ID);
    // The script names the folder it is in.
    expect(await text(join(second, "letta-commands.sh"))).toContain(inScript(join(second, "memory")));
  });

  it("writes another agent of the same name next to a folder that carries a different marker", async () => {
    await writeLettaAgent(ctx, { ...adaBundle(), manifest: { ...adaBundle().manifest, id: OTHER_ID } }, ENABLE);
    const result = await writeLettaAgent(ctx, adaBundle(), ENABLE);
    expect(result.artifactPath).toBe(join(cwd, "ada-letta-memory-2"));
    expect(result.items.warnings[0]).toBe(
      `${ADA_DIR()} holds a different agent; written as ${join(cwd, "ada-letta-memory-2")}`,
    );
    expect((await readMarker(ADA_DIR()))?.id).toBe(OTHER_ID);
  });

  it("finds the -N folder that already holds this agent and updates that one", async () => {
    await mkdir(ADA_DIR());
    await writeFile(join(ADA_DIR(), "theirs.txt"), "theirs");
    const first = await writeLettaAgent(ctx, adaBundle(), ENABLE);
    const again = await writeLettaAgent(ctx, adaBundle(), ENABLE);
    expect(first.artifactPath).toBe(join(cwd, "ada-letta-memory-2"));
    expect(again.artifactPath).toBe(join(cwd, "ada-letta-memory-2"));
    expect(again.items.warnings).toHaveLength(2);
    expect((await readdir(cwd)).sort()).toEqual(["ada-letta-memory", "ada-letta-memory-2"]);
  });

  it("looks past a -N folder of yet another agent, and stops at the first free number", async () => {
    const other = { ...adaBundle(), manifest: { ...adaBundle().manifest, id: OTHER_ID } };
    await writeLettaAgent(ctx, other, ENABLE);
    await writeLettaAgent(ctx, other, COPY); // ada-letta-memory-2
    await mkdir(join(cwd, "ada-letta-memory-4"));
    await writeFile(join(cwd, "ada-letta-memory-4", "x"), "x");
    const result = await writeLettaAgent(ctx, adaBundle(), ENABLE);
    expect(result.artifactPath).toBe(join(cwd, "ada-letta-memory-3"));
  });

  it("uses an empty folder of the name", async () => {
    await mkdir(ADA_DIR());
    const result = await writeLettaAgent(ctx, adaBundle(), ENABLE);
    expect(result.artifactPath).toBe(ADA_DIR());
    expect(result.items.warnings).toHaveLength(2);
  });

  it("always writes a copy next to the folder with copy, with no warning", async () => {
    await writeLettaAgent(ctx, adaBundle(), ENABLE);
    const first = await writeLettaAgent(ctx, adaBundle(), COPY);
    const second = await writeLettaAgent(ctx, adaBundle(), COPY);
    expect(first.artifactPath).toBe(join(cwd, "ada-letta-memory-2"));
    expect(second.artifactPath).toBe(join(cwd, "ada-letta-memory-3"));
    expect(first.items.warnings).toHaveLength(2);
  });

  it("refuses to replace a folder with no marker, and leaves it as it is", async () => {
    await mkdir(ADA_DIR());
    await writeFile(join(ADA_DIR(), "theirs.txt"), "theirs");
    await expect(writeLettaAgent(ctx, adaBundle(), REPLACE)).rejects.toThrow(
      `Refusing to replace ${ADA_DIR()}: it holds no .openteleport.json, so it is not a folder ` +
        "OpenTeleport wrote. Delete it yourself if you mean it.",
    );
    expect(await listing(ADA_DIR())).toEqual(["theirs.txt"]);
    expect(await readdir(cwd)).toEqual(["ada-letta-memory"]);
  });

  it("refuses to replace something that is not a folder", async () => {
    await writeFile(ADA_DIR(), "a file");
    await expect(writeLettaAgent(ctx, adaBundle(), REPLACE)).rejects.toThrow(
      /^Refusing to replace .*: it is not a folder\. Delete it yourself if you mean it\.$/,
    );
    expect(await text(ADA_DIR())).toBe("a file");
  });

  it("replaces a folder that carries a marker, whichever agent's", async () => {
    await writeLettaAgent(ctx, { ...adaBundle(), manifest: { ...adaBundle().manifest, id: OTHER_ID } }, ENABLE);
    const result = await writeLettaAgent(ctx, adaBundle(), REPLACE);
    expect(result.artifactPath).toBe(ADA_DIR());
    expect((await readMarker(ADA_DIR()))?.id).toBe(ADA_ID);
    expect(await readdir(cwd)).toEqual(["ada-letta-memory"]);
  });

  it("updates a folder written without an id only by writing next to it", async () => {
    const bundle = adaBundle();
    bundle.manifest.id = "";
    await writeLettaAgent(ctx, bundle, ENABLE);
    const result = await writeLettaAgent(ctx, bundle, ENABLE);
    expect(result.artifactPath).toBe(join(cwd, "ada-letta-memory-2"));
  });

  it.skipIf(!canSymlink)("never writes through a link that is in the way", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "keep.txt"), "keep");
    await symlink(elsewhere, ADA_DIR(), "dir");

    const result = await writeLettaAgent(ctx, adaBundle(), ENABLE);
    expect(result.artifactPath).toBe(join(cwd, "ada-letta-memory-2"));
    expect(result.items.warnings[0]).toBe(
      `${ADA_DIR()} is a symbolic link, which is not written through; written as ${join(cwd, "ada-letta-memory-2")}`,
    );
    expect(await readdir(elsewhere)).toEqual(["keep.txt"]);

    await expect(writeLettaAgent(ctx, adaBundle(), REPLACE)).rejects.toThrow(
      /^Refusing to replace .*: it is a symbolic link\. Delete it yourself if you mean it\.$/,
    );
    expect(await readdir(elsewhere)).toEqual(["keep.txt"]);
  });

  it.skipIf(!canSymlink)("removes a link in place of memory/ or a script without following it", async () => {
    await writeLettaAgent(ctx, adaBundle(), ENABLE);
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "keep.txt"), "keep");
    await writeFile(join(elsewhere, "script.sh"), "original");
    await rm(join(ADA_DIR(), "memory"), { recursive: true });
    await symlink(elsewhere, join(ADA_DIR(), "memory"), "dir");
    await rm(join(ADA_DIR(), "letta-commands.sh"));
    await symlink(join(elsewhere, "script.sh"), join(ADA_DIR(), "letta-commands.sh"), "file").catch(() => {});

    await writeLettaAgent(ctx, adaBundle(), ENABLE);
    expect((await readdir(elsewhere)).sort()).toEqual(["keep.txt", "script.sh"]);
    expect(await text(join(elsewhere, "script.sh"))).toBe("original");
    expect((await stat(join(ADA_DIR(), "memory", "persona.md"))).isFile()).toBe(true);
    expect(await text(join(ADA_DIR(), "letta-commands.sh"))).toContain("letta agents create");
  });
});

describe("a move from Letta to Letta", () => {
  it("carries the agent across: the reference note, the model, the task's description", async () => {
    const out = join(root, "out");
    const report = await move({
      from: lettaAdapter,
      to: lettaAdapter,
      agent: "agent-local-1111",
      ctx: { ...ctx, sourceDir: FIXTURE, targetDir: out },
      write: DEFAULT,
    });

    const dir = join(out, "reviewer-letta-memory");
    expect(report.outcome).toBe("handoff");
    expect(report.target).toEqual({ app: "letta" });
    expect(report.nextStep).toBe(
      `Run ${join(dir, "letta-commands.sh")} (or .ps1): it creates the agent, restores its memory and adds the routines`,
    );
    expect(await listing(join(dir, "memory"))).toEqual([
      "MEMORY.md",
      "human.md",
      "instructions.md",
      "persona.md",
      "reference/MEMORY.md",
      "reference/human.md",
      "reference/notes.md",
      "reference/style.md",
      "skills/triage/SKILL.md",
    ]);
    const memfs = await readMemFs(join(dir, "memory"));
    expect(memfs.persona).toMatchObject({ name: "persona", description: "Reviews pull requests" });
    expect(memfs.instructions).toBe("You review PRs.\n");
    expect(memfs.referenceNotes.map((note) => note.name).sort()).toEqual(["human", "notes", "style"]);

    const script = await text(join(dir, "letta-commands.sh"));
    expect(script).toContain(
      'letta agents create --name "Reviewer" --description "Reviews pull requests" --model "anthropic/claude-sonnet-4-5"',
    );
    expect(script).toContain(
      '# letta cron add --name "Morning review" --description "Check the open pull requests" --prompt',
    );
    expect(report.moved.map((item) => item.field)).toEqual([
      "instructions",
      "persona",
      "skills",
      "routines",
      "memory.facts",
      "memory.notes",
      "models",
    ]);
    // The source is only read.
    expect(await text(join(FIXTURE, "lc-local-backend", "agents", "agent-local-1111.json"))).toContain(
      "You review PRs.",
    );
  });

  it("reads back, from the fixture's memory, what the handoff folder holds", async () => {
    const out = join(root, "out");
    await move({
      from: lettaAdapter,
      to: lettaAdapter,
      agent: "agent-cloud-2222",
      ctx: { ...ctx, sourceDir: FIXTURE, targetDir: out },
      write: ENABLE,
    });
    const dir = join(out, "agent-cloud-2222-letta-memory");
    const memfs = await readMemFs(join(dir, "memory"));
    expect(memfs.persona?.body).toBe("A helpful assistant that keeps answers short.\n");
    expect(await text(join(dir, "letta-commands.sh"))).toContain(
      'letta agents create --name "agent-cloud-2222"\n',
    );
  });
});
