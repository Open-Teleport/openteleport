// The pieces of the SSH transport that need no ssh at all: the `<adapter>@<host>` parser, the
// quoting of the remote command, the version pin, and how what `ssh` returns becomes a result
// or an error. `ctx.exec` is a stub that records the call and answers as execa would.
import { createRequire } from "node:module";
import type { execa } from "execa";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../../src/adapters/types.js";
import {
  REMOTE_PACKAGE,
  parseTarget,
  runRemote,
  runRemoteJson,
  shellQuote,
  sshArgs,
  targetLabel,
} from "../../src/commands/remote.js";
import { NotDetectedError, RemoteError, UsageError, exitCodeOf } from "../../src/commands/shared.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

type Call = { file: string; args: string[]; options: Record<string, unknown> };
type Reply = { exitCode?: number; stdout?: string | Uint8Array; stderr?: string; code?: string };

/** An `execa` that answers `reply` to every call and keeps the calls. */
function stubExec(reply: Reply): { ctx: Ctx; calls: Call[] } {
  const calls: Call[] = [];
  const exec = async (file: string, args: readonly string[] = [], options = {}) => {
    calls.push({ file, args: [...args], options: { ...options } });
    const stdout = reply.stdout ?? "";
    return {
      exitCode: reply.exitCode ?? 0,
      stdout: typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout,
      stderr: new TextEncoder().encode(reply.stderr ?? ""),
      ...(reply.code === undefined ? {} : { code: reply.code, failed: true }),
    };
  };
  const ctx: Ctx = {
    home: "/home/me",
    cwd: "/home/me",
    env: { PATH: "/usr/bin" },
    exec: exec as unknown as typeof execa,
    logger: () => {},
  };
  return { ctx, calls };
}

describe("parseTarget", () => {
  it("takes a bare adapter name as local", () => {
    expect(parseTarget("openclaw")).toEqual({ adapter: "openclaw" });
  });

  it("splits at the first @, so the host may hold a user", () => {
    expect(parseTarget("openclaw@server")).toEqual({ adapter: "openclaw", host: "server" });
    expect(parseTarget("openclaw@deploy@10.0.0.4")).toEqual({
      adapter: "openclaw",
      host: "deploy@10.0.0.4",
    });
    expect(parseTarget("folder@ssh://me@box:2222")).toEqual({
      adapter: "folder",
      host: "ssh://me@box:2222",
    });
  });

  it.each([
    ["@server", /Missing adapter before '@'/],
    ["openclaw@", /Missing host after '@'/],
    ["openclaw@-oProxyCommand=x", /must not start with '-'/],
    ["openclaw@ser ver", /whitespace or control/],
    ["openclaw@server\n", /whitespace or control/],
  ])("refuses %j with exit code 2", (text, message) => {
    expect(() => parseTarget(text)).toThrow(message);
    expect(() => parseTarget(text)).toThrow(UsageError);
  });

  it("labels a remote target as adapter@host", () => {
    expect(targetLabel({ adapter: "openclaw" })).toBe("openclaw");
    expect(targetLabel({ adapter: "openclaw", host: "me@server" })).toBe("openclaw@me@server");
  });
});

describe("shellQuote", () => {
  it("leaves plain words alone and single-quotes the rest", () => {
    expect(shellQuote("--agent")).toBe("--agent");
    expect(shellQuote("openteleport@0.4.6")).toBe("openteleport@0.4.6");
    expect(shellQuote("Ada Lovelace")).toBe("'Ada Lovelace'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shellQuote("two\nlines")).toBe("'two\nlines'");
  });
});

describe("sshArgs", () => {
  it("pins the remote package to this version", () => {
    expect(REMOTE_PACKAGE).toBe(`openteleport@${version}`);
  });

  it("gives ssh the host and one quoted remote command", () => {
    expect(sshArgs("me@server", ["import", "--to", "openclaw", "--agent", "Ada L", "-"])).toEqual([
      "me@server",
      `npx -y openteleport@${version} import --to openclaw --agent 'Ada L' -`,
    ]);
  });
});

describe("runRemote", () => {
  it("runs ssh by name with stdin bytes and returns stdout bytes", async () => {
    const { ctx, calls } = stubExec({ stdout: new Uint8Array([1, 2, 3]) });
    const input = new Uint8Array([9, 8]);
    const out = await runRemote(ctx, "server", ["list", "--json"], { input, quiet: true });
    expect([...out]).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("ssh");
    expect(calls[0]?.args).toEqual(["server", `npx -y openteleport@${version} list --json`]);
    expect(calls[0]?.options).toMatchObject({ input, encoding: "buffer", reject: false, stderr: "pipe" });
    expect(calls[0]?.options.timeout).toBeUndefined();
  });

  it("closes stdin when there is no input, and shows stderr unless quiet", async () => {
    const { ctx, calls } = stubExec({});
    await runRemote(ctx, "server", ["list"], { quiet: false });
    expect(calls[0]?.options).toMatchObject({ stdin: "ignore", stderr: ["pipe", "inherit"] });
  });

  it("keeps the exit code and message of a failure the remote reported as JSON", async () => {
    const { ctx } = stubExec({
      exitCode: 3,
      stdout: JSON.stringify({ error: { code: 3, message: "OpenClaw was not detected" } }),
    });
    const failure = await runRemote(ctx, "server", ["import"], { quiet: true }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RemoteError);
    expect((failure as Error).message).toBe("server: OpenClaw was not detected");
    expect(exitCodeOf(failure)).toBe(3);

    const usage = stubExec({
      exitCode: 2,
      stdout: JSON.stringify({ error: { code: 2, message: 'No agent "x" in OpenClaw' } }),
    });
    expect(exitCodeOf(await runRemote(usage.ctx, "s", [], { quiet: true }).catch((e: unknown) => e))).toBe(2);
  });

  it("is exit code 3 when the remote has no npx", async () => {
    for (const reply of [
      { exitCode: 127, stderr: "bash: line 1: npx: command not found" },
      { exitCode: 1, stderr: "sh: 1: npx: not found" },
    ]) {
      const { ctx } = stubExec(reply);
      const failure = await runRemote(ctx, "server", ["list"], { quiet: true }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(NotDetectedError);
      expect((failure as Error).message).toContain("npx was not found on server");
      expect((failure as Error).message).toContain(`npx -y openteleport@${version}`);
      expect(exitCodeOf(failure)).toBe(3);
    }
  });

  it("is exit code 3 when ssh itself is not installed here", async () => {
    const { ctx } = stubExec({ code: "ENOENT", exitCode: undefined });
    const failure = await runRemote(ctx, "server", ["list"], { quiet: true }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotDetectedError);
    expect((failure as Error).message).toContain("ssh was not found on this machine");
  });

  it("is exit code 1 with ssh's last line when ssh cannot connect", async () => {
    const { ctx } = stubExec({
      exitCode: 255,
      stderr: "ssh: connect to host server port 22: Connection refused\n",
    });
    const failure = await runRemote(ctx, "server", ["list"], { quiet: true }).catch((e: unknown) => e);
    expect(failure).not.toBeInstanceOf(RemoteError);
    expect((failure as Error).message).toBe(
      "ssh server failed: ssh: connect to host server port 22: Connection refused",
    );
    expect(exitCodeOf(failure)).toBe(1);
  });

  it("names the exit code and the last stderr line of any other failure", async () => {
    const { ctx } = stubExec({ exitCode: 9, stderr: "npm ERR! 404 Not Found\n\n" });
    await expect(runRemote(ctx, "server", ["list"], { quiet: true })).rejects.toThrow(
      "openteleport on server ended with exit code 9: npm ERR! 404 Not Found",
    );
  });
});

describe("runRemoteJson", () => {
  it("parses the remote's stdout", async () => {
    const { ctx } = stubExec({ stdout: JSON.stringify([{ id: "ada", name: "Ada" }]) });
    expect(await runRemoteJson(ctx, "server", ["list", "--json"], { quiet: true })).toEqual([
      { id: "ada", name: "Ada" },
    ]);
  });

  it("quotes the first line when stdout is not JSON", async () => {
    const { ctx } = stubExec({ stdout: "Welcome to server!\n[]" });
    await expect(runRemoteJson(ctx, "server", ["list", "--json"], { quiet: true })).rejects.toThrow(
      'openteleport on server printed something that is not JSON: "Welcome to server!"',
    );
  });
});
