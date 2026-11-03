// The SSH transport end to end, against the fake `ssh` of `test/helpers/fake-ssh.ts`: the
// "remote" is the same built CLI run in another home and working folder of the sandbox, so a
// move to `folder@server` really writes a folder there, the archive really crosses stdin or
// stdout, and the remote's report really comes back as JSON. No server is ever contacted.
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBundle } from "../../src/core/bundle.js";
import type { MoveReport } from "../../src/core/report.js";
import {
  ADA_DIR,
  FAKE_KEY,
  STACK_LINE,
  type Sandbox,
  json,
  run,
  sandbox,
} from "../helpers/cli.js";
import { type FakeSsh, type FakeSshMode, installFakeSsh } from "../helpers/fake-ssh.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

let box: Sandbox;
let ssh: FakeSsh;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

const withSsh = async (mode: FakeSshMode = "ok") => {
  ssh = await installFakeSsh(box, mode);
};

/** A local folder agent in the sandbox working directory. */
async function localAgent(name: string, instructions = `# ${name}\n\nBe brief.\n`): Promise<void> {
  await mkdir(join(box.cwd, name), { recursive: true });
  await writeFile(join(box.cwd, name, "AGENTS.md"), instructions);
}

/** Ada's fixture as a folder agent on the fake remote. */
async function remoteAda(): Promise<void> {
  const bundle = await readBundle(ADA_DIR);
  const { writeBundle } = await import("../../src/core/bundle.js");
  await writeBundle(bundle, join(ssh.remoteCwd, "ada"), { asDirectory: true });
}

describe("move --to <adapter>@<host>", () => {
  it("writes the agent on the remote and prints the remote's report, relabelled", async () => {
    await withSsh();
    await localAgent("bob");
    const result = await run(box, ["move", "--from", "folder", "--agent", "bob", "--to", "folder@me@server", "--json"], { env: ssh.env });
    expect(result.stderr).not.toMatch(STACK_LINE);
    expect(result.exitCode).toBe(0);
    const report = json<MoveReport>(result);
    expect(report).toMatchObject({
      source: { app: "folder", agent: "bob" },
      target: { app: "folder@me@server", agent: join(ssh.remoteCwd, "bob") },
      outcome: "done",
    });
    expect(report.moved.map((item) => item.field)).toContain("instructions");
    expect(await readFile(join(ssh.remoteCwd, "bob", "AGENTS.md"), "utf8")).toBe("# bob\n\nBe brief.\n");
    // Nothing of the agent was written here: only the report.
    expect(await readdir(box.cwd)).toEqual(["bob"]);
    expect(await readdir(join(box.home, ".openteleport", "reports"))).toHaveLength(1);

    const [call, ...more] = await ssh.calls();
    expect(more).toEqual([]);
    expect(call?.host).toBe("me@server");
    expect(call?.command).toBe(`npx -y openteleport@${version} import --to folder --json --quiet -`);
  });

  it("prints the terminal report with the remote target", async () => {
    await withSsh();
    await localAgent("bob");
    const result = await run(box, ["move", "--from", "folder", "--agent", "bob", "--to", "folder@server"], { env: ssh.env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Move report\nSource: folder \/ bob\nTarget: folder@server \/ /);
    expect(result.stdout).toContain("Report written to ");
  });

  it("passes the write flags on, with --replace confirmed here", async () => {
    await withSsh();
    await localAgent("bob");
    const result = await run(box, [
      "move", "--from", "folder", "--agent", "bob", "--to", "folder@server",
      "--replace", "--yes", "--enable-routines", "--include-files", "--no-memory", "--json",
    ], { env: ssh.env });
    expect(result.exitCode).toBe(0);
    const [call] = await ssh.calls();
    expect(call?.command).toBe(
      `npx -y openteleport@${version} import --to folder --replace --yes --enable-routines --include-files --no-memory --json --quiet -`,
    );
  });

  it("refuses --replace without --yes before anything is sent", async () => {
    await withSsh();
    await localAgent("bob");
    const result = await run(box, ["move", "--from", "folder", "--agent", "bob", "--to", "folder@server", "--replace"], { env: ssh.env });
    expect(result.exitCode).toBe(2);
    expect(await ssh.calls()).toEqual([]);
  });

  it("stops on a secret before ssh starts", async () => {
    await withSsh();
    await localAgent("bob", `# Bob\n\nUse ${FAKE_KEY} for the API.\n`);
    const result = await run(box, ["move", "--from", "folder", "--agent", "bob", "--to", "folder@server"], { env: ssh.env });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^error: Found 1 possible secret/);
    expect(await ssh.calls()).toEqual([]);
  });

  it("also keeps the bundle with --keep", async () => {
    await withSsh();
    await localAgent("bob");
    const result = await run(box, ["move", "--from", "folder", "--agent", "bob", "--to", "folder@server", "--keep", "out/bob.jetpack"], { env: ssh.env });
    expect(result.exitCode).toBe(0);
    expect((await readBundle(join(box.cwd, "out", "bob.jetpack"))).instructions).toContain("Be brief.");
  });

  it("relays the remote's failure with its exit code: a target that is not there", async () => {
    await withSsh();
    await localAgent("bob");
    // The remote's OpenClaw adapter finds no install in the remote home.
    const result = await run(box, ["move", "--from", "folder", "--agent", "bob", "--to", "openclaw@server"], { env: ssh.env });
    expect(result.exitCode).toBe(3);
    // The remote's own stderr is forwarded first; the local verdict is the last line.
    expect(result.stderr).toMatch(/^error: server: OpenClaw was not detected/m);
    expect(result.stderr).not.toMatch(STACK_LINE);
  });

  it("is exit code 3 when the remote has no npx", async () => {
    await withSsh("no-npx");
    await localAgent("bob");
    const result = await run(box, ["move", "--from", "folder", "--agent", "bob", "--to", "folder@server"], { env: ssh.env });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toMatch(/^error: npx was not found on server; install Node\.js 24/m);
  });

  it("is exit code 1 when the host cannot be reached", async () => {
    await withSsh("unreachable");
    await localAgent("bob");
    const result = await run(box, ["move", "--from", "folder", "--agent", "bob", "--to", "folder@server"], { env: ssh.env });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^error: ssh server failed: ssh: connect to host server port 22: Connection refused/m);
  });

  it("names a banner that gets in the way of the JSON", async () => {
    await withSsh("banner");
    await localAgent("bob");
    const result = await run(box, ["move", "--from", "folder", "--agent", "bob", "--to", "folder@server"], { env: ssh.env });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not JSON: "Welcome to server"/);
  });

  it("is exit code 2 for an unknown adapter or a bad host, without a call", async () => {
    await withSsh();
    await localAgent("bob");
    const unknown = await run(box, ["move", "--from", "folder", "--agent", "bob", "--to", "nosuch@server"], { env: ssh.env });
    expect(unknown.exitCode).toBe(2);
    const option = await run(box, ["move", "--from", "folder", "--agent", "bob", "--to", "folder@-oProxyCommand=x"], { env: ssh.env });
    expect(option.exitCode).toBe(2);
    expect(option.stderr).toContain("must not start with '-'");
    const both = await run(box, ["move", "--from", "folder@a", "--agent", "bob", "--to", "folder@b"], { env: ssh.env });
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain("cannot both be remote");
    expect(await ssh.calls()).toEqual([]);
  });
});

describe("move --from <adapter>@<host>", () => {
  it("fetches the agent over stdout and writes it here", async () => {
    await withSsh();
    await remoteAda();
    const result = await run(box, ["move", "--from", "folder@server", "--agent", "ada", "--to", "folder", "--json"], { env: ssh.env });
    expect(result.stderr).not.toMatch(STACK_LINE);
    expect(result.exitCode).toBe(0);
    const report = json<MoveReport>(result);
    expect(report).toMatchObject({
      source: { app: "folder@server", agent: "ada" },
      target: { app: "folder", agent: join(box.cwd, "ada") },
      outcome: "done",
    });
    expect(report.moved.map((item) => item.field)).toEqual(
      expect.arrayContaining(["instructions", "persona", "skills", "memory.facts"]),
    );
    const here = await readBundle(join(box.cwd, "ada"));
    const there = await readBundle(join(ssh.remoteCwd, "ada"));
    expect(here.manifest.id).toBe(there.manifest.id);
    expect(here.instructions).toBe(there.instructions);
    const [call] = await ssh.calls();
    expect(call?.command).toBe(`npx -y openteleport@${version} export --from folder --agent ada --out - --json --quiet`);
  });

  it("requires --agent", async () => {
    await withSsh();
    const result = await run(box, ["move", "--from", "folder@server", "--to", "folder"], { env: ssh.env });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/^error: Missing --agent/);
    expect(await ssh.calls()).toEqual([]);
  });

  it("relays the remote's usage error for an unknown agent", async () => {
    await withSsh();
    await remoteAda();
    const result = await run(box, ["move", "--from", "folder@server", "--agent", "nobody", "--to", "folder"], { env: ssh.env });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/^error: server: No agent "nobody"/m);
  });
});

describe("export and import with a remote side", () => {
  it("export --from <adapter>@<host> saves the fetched agent as a file here", async () => {
    await withSsh();
    await remoteAda();
    const result = await run(box, ["export", "--from", "memory@server", "--agent", "ada", "--out", "ada.jetpack", "--json"], { env: ssh.env });
    expect(result.exitCode).toBe(0);
    expect(json<MoveReport>(result)).toMatchObject({ source: { app: "memory@server", agent: "ada" }, outcome: "exported" });
    const bundle = await readBundle(join(box.cwd, "ada.jetpack"));
    expect(bundle.persona).toBe("Calm and curious.");
    const [call] = await ssh.calls();
    expect(call?.command).toBe(`npx -y openteleport@${version} export --from memory --agent ada --out - --json --quiet`);
  });

  it("import --to <adapter>@<host> streams the file to the remote", async () => {
    await withSsh();
    const { writeBundle } = await import("../../src/core/bundle.js");
    await writeBundle(await readBundle(ADA_DIR), join(box.cwd, "ada.jetpack"));
    const result = await run(box, ["import", "--to", "folder@server", "ada.jetpack", "--json"], { env: ssh.env });
    expect(result.stderr).not.toMatch(STACK_LINE);
    expect(result.exitCode).toBe(0);
    expect(json<MoveReport>(result)).toMatchObject({
      source: { app: "jetpack", agent: "Ada" },
      target: { app: "folder@server", agent: join(ssh.remoteCwd, "ada") },
      outcome: "done",
    });
    expect(await readFile(join(ssh.remoteCwd, "ada", "SOUL.md"), "utf8")).toContain("Ada");
  });

  it("list --from <adapter>@<host> lists the remote's agents", async () => {
    await withSsh();
    const result = await run(box, ["list", "--from", "memory@server", "--json"], { env: ssh.env });
    expect(result.exitCode).toBe(0);
    expect(json(result)).toEqual([{ id: "ada", name: "Ada" }]);
    const table = await run(box, ["list", "--from", "memory@server"], { env: ssh.env });
    expect(table.stdout).toMatch(/^id {3}name/);
  });
});
