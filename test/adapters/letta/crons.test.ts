import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LettaCronTask,
  cronAddCommand,
  readCrons,
  shellQuote,
  taskToRoutine,
  taskWarnings,
} from "../../../src/adapters/letta/crons.js";
import type { Routine } from "../../../src/core/schema.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/letta/home/.letta", import.meta.url));
const BOM = String.fromCharCode(0xfeff);
/** The curly quotes PowerShell takes for a straight double quote. */
const [LEFT, RIGHT, LOW] = [0x201c, 0x201d, 0x201e].map((code) => String.fromCharCode(code));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-letta-crons-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A task as Letta writes it, with `fields` laid over it. */
function task(fields: Record<string, unknown> = {}): LettaCronTask {
  return {
    id: "cron-1",
    agent_id: "agent-1",
    conversation_id: null,
    name: "Morning review",
    description: "",
    cron: "0 9 * * 1-5",
    timezone: "Europe/Warsaw",
    recurring: true,
    prompt: "Review the open PRs.",
    status: "active",
    scheduled_for: null,
    ...fields,
  } as LettaCronTask;
}

async function crons(content: string): Promise<ReturnType<typeof readCrons>> {
  const file = join(root, "crons.json");
  await writeFile(file, content);
  return readCrons(file);
}

describe("readCrons", () => {
  it("reads the tasks of the fixture", async () => {
    const result = await readCrons(join(FIXTURE, "crons.json"));
    if ("error" in result) throw new Error(result.error);
    expect(result.tasks.map((entry) => [entry.id, entry.agent_id, entry.status])).toEqual([
      ["cron-0001", "agent-local-1111", "active"],
      ["cron-0002", "agent-local-1111", "paused"],
      ["cron-0003", "agent-local-1111", "fired"],
      ["cron-0004", "agent-local-9999", "active"],
    ]);
    // Fields this adapter has no use for stay on the task.
    expect(result.tasks[0]).toMatchObject({ fire_count: 18, last_fired_at: expect.any(String) });
  });

  it("reads a file that is not there as no tasks", async () => {
    expect(await readCrons(join(root, "crons.json"))).toEqual({ tasks: [] });
  });

  it("reports a file that is not JSON, naming it", async () => {
    const result = await crons("{ not json");
    expect(result).toEqual({
      error: expect.stringContaining(`${join(root, "crons.json")} is not valid JSON`),
    });
  });

  it("reports a file that is not an object or has no list of tasks", async () => {
    expect(await crons("[]")).toEqual({ error: expect.stringContaining("is not a JSON object") });
    expect(await crons('{ "version": 1, "tasks": {} }')).toEqual({
      error: expect.stringContaining("has no list of tasks"),
    });
  });

  it("reports a path that cannot be read as a file", async () => {
    expect(await readCrons(root)).toEqual({ error: expect.stringContaining("cannot be read") });
  });

  it("reads a file without tasks, or with a byte order mark, without trouble", async () => {
    expect(await crons('{ "version": 1 }')).toEqual({ tasks: [] });
    const result = await crons(`${BOM}{ "tasks": [{ "agent_id": "a", "name": "n" }] }`);
    expect(result).toEqual({
      tasks: [{ agent_id: "a", name: "n", id: "", prompt: "", status: "" }],
    });
  });

  it("leaves out an entry that belongs to no agent", async () => {
    const result = await crons('{ "tasks": [1, null, "x", { "name": "n" }, { "agent_id": 7 }] }');
    expect(result).toEqual({ tasks: [] });
  });
});

describe("taskToRoutine", () => {
  it("turns an active cron task into an enabled routine in its time zone", () => {
    const converted = taskToRoutine(
      task({ description: "Check the PRs", conversation_id: "conv-9", prompt: "One.\nTwo." }),
    );
    expect(converted).toEqual({
      routine: {
        name: "Morning review",
        instruction: "One.\nTwo.",
        enabled: true,
        timezone: "Europe/Warsaw",
        schedule: { kind: "cron", expression: "0 9 * * 1-5" },
      },
      extra: { description: "Check the PRs", conversation_id: "conv-9" },
    });
  });

  it("turns a paused task into a disabled routine, with nothing extra", () => {
    expect(taskToRoutine(task({ status: "paused" }))).toMatchObject({
      routine: { enabled: false },
      extra: {},
    });
  });

  it("turns a one-off task into an at routine", () => {
    const converted = taskToRoutine(
      task({
        cron: null,
        recurring: false,
        scheduled_for: "2026-12-01T07:00:00.000Z",
        timezone: "UTC",
      }),
    );
    expect(converted?.routine.schedule).toEqual({ kind: "at", at: "2026-12-01T07:00:00.000Z" });
    expect(converted?.routine.enabled).toBe(true);
  });

  it("reads a task that is not recurring by its time even when it has a cron expression", () => {
    const converted = taskToRoutine(
      task({ recurring: false, scheduled_for: "2026-12-01T07:00:00.000Z" }),
    );
    expect(converted?.routine.schedule.kind).toBe("at");
  });

  it("is null for a task that fired, was missed or cancelled, or whose status is unknown", () => {
    for (const status of ["fired", "missed", "cancelled", "exploded", ""]) {
      expect(taskToRoutine(task({ status }))).toBeNull();
    }
  });

  it("is null for a task without a usable name, prompt or schedule", () => {
    expect(taskToRoutine(task({ name: "  " }))).toBeNull();
    expect(taskToRoutine(task({ prompt: "" }))).toBeNull();
    expect(taskToRoutine(task({ cron: null }))).toBeNull();
    expect(taskToRoutine(task({ cron: null, recurring: false, scheduled_for: "tomorrow" }))).toBeNull();
  });

  it("takes UTC for a recurring task without a valid time zone", () => {
    expect(taskToRoutine(task({ timezone: "Mars/Olympus" }))?.routine.timezone).toBe("UTC");
    expect(taskToRoutine(task({ timezone: undefined }))?.routine.timezone).toBe("UTC");
  });
});

describe("taskWarnings", () => {
  it("says why a task was not exported", () => {
    expect(taskWarnings(task({ status: "fired" }))).toEqual([
      "routine 'Morning review' was not exported: its status is fired, a one-off task that already ran",
    ]);
    expect(taskWarnings(task({ status: "cancelled" }))[0]).toContain("a task that was cancelled");
    expect(taskWarnings(task({ status: "exploded" }))[0]).toContain('its status "exploded" is not known');
    expect(taskWarnings(task({ prompt: "" }))[0]).toContain("it has no prompt");
    expect(taskWarnings(task({ cron: null }))[0]).toContain("neither a cron expression nor");
    expect(
      taskWarnings(task({ cron: null, recurring: false, scheduled_for: "tomorrow" }))[0],
    ).toContain("not an ISO 8601 instant");
    expect(taskWarnings(task({ name: "", id: "cron-7" }))[0]).toMatch(/^routine 'cron-7' /);
  });

  it("says when UTC was assumed, and says nothing about a task that came across as it was", () => {
    expect(taskWarnings(task({ timezone: "Mars/Olympus" }))).toEqual([
      "routine 'Morning review' names no valid time zone; UTC was assumed",
    ]);
    expect(taskWarnings(task())).toEqual([]);
    expect(
      taskWarnings(task({ cron: null, recurring: false, scheduled_for: "2026-12-01T07:00:00Z", timezone: null })),
    ).toEqual([]);
  });
});

describe("shellQuote", () => {
  it("escapes what sh would expand inside double quotes", () => {
    expect(shellQuote("sh", 'say "hi" to $USER `now` \\ done')).toBe(
      '"say \\"hi\\" to \\$USER \\`now\\` \\\\ done"',
    );
  });

  it("escapes what PowerShell would expand, and the curly quotes it takes for a quote", () => {
    expect(shellQuote("ps1", 'say "hi" to $USER `now`')).toBe(
      '"say `"hi`" to `$USER ``now``"',
    );
    expect(shellQuote("ps1", `${LEFT}a${RIGHT} ${LOW}b${RIGHT}`)).toBe(
      `"\`${LEFT}a\`${RIGHT} \`${LOW}b\`${RIGHT}"`,
    );
  });

  it("leaves everything else as it is", () => {
    expect(shellQuote("sh", "*/30 * * * *")).toBe('"*/30 * * * *"');
    expect(shellQuote("ps1", "C:/Users/Ada Lovelace/x.txt")).toBe('"C:/Users/Ada Lovelace/x.txt"');
  });
});

describe("cronAddCommand", () => {
  const cron: Routine = {
    name: "Morning review",
    instruction: "x",
    enabled: true,
    timezone: "UTC",
    schedule: { kind: "cron", expression: "0 9 * * 1-5" },
  };
  const file = "/home/ada/ada-letta-memory/routines/morning-review.txt";

  it("is one line for sh that reads the prompt from its file", () => {
    expect(cronAddCommand(cron, file, "sh")).toBe(
      `letta cron add --name "Morning review" --prompt "$(cat "${file}")" --cron "0 9 * * 1-5" --agent "$AGENT_ID"`,
    );
  });

  it("is one line for PowerShell that reads the prompt from its file", () => {
    expect(cronAddCommand(cron, file, "ps1")).toBe(
      `letta cron add --name "Morning review" --prompt (Get-Content -Raw -Encoding UTF8 "${file}") --cron "0 9 * * 1-5" --agent "$AGENT_ID"`,
    );
  });

  it("quotes a name with a double quote and a dollar sign for each shell", () => {
    const named = { ...cron, name: 'Say "hi" to $USER' };
    expect(cronAddCommand(named, file, "sh")).toContain('--name "Say \\"hi\\" to \\$USER" ');
    expect(cronAddCommand(named, file, "ps1")).toContain('--name "Say `"hi`" to `$USER" ');
  });

  it("keeps a name with line breaks on one line and inside its quotes", () => {
    const named = { ...cron, name: 'x"\nrm -rf ~\r\n"y' };
    for (const shell of ["sh", "ps1"] as const) {
      const command = cronAddCommand(named, file, shell);
      expect(command).not.toMatch(/[\r\n]/);
      expect(command).toContain(shell === "sh" ? '--name "x\\" rm -rf ~ \\"y"' : '--name "x`" rm -rf ~ `"y"');
    }
  });

  it("writes an every schedule as a cron expression", () => {
    const every: Routine = { ...cron, schedule: { kind: "every", every: "30m" } };
    expect(cronAddCommand(every, file, "sh")).toContain('--cron "*/30 * * * *"');
    const hours: Routine = { ...cron, schedule: { kind: "every", every: "2h" } };
    expect(cronAddCommand(hours, file, "ps1")).toContain('--cron "0 */2 * * *"');
  });

  it("writes an at schedule as --at with the instant", () => {
    const at: Routine = { ...cron, schedule: { kind: "at", at: "2026-12-01T07:00:00.000Z" } };
    expect(cronAddCommand(at, file, "sh")).toContain('--at "2026-12-01T07:00:00.000Z" --agent');
    expect(cronAddCommand(at, file, "sh")).not.toContain("--cron");
  });

  it("adds the task's own description when there is one", () => {
    expect(cronAddCommand(cron, file, "sh", "Check the $PRs")).toContain(
      '--name "Morning review" --description "Check the \\$PRs" --prompt',
    );
    expect(cronAddCommand(cron, file, "sh", "  ")).not.toContain("--description");
  });
});
