import { Command, CommanderError } from "commander";
import { registerBuiltinAdapters } from "./adapters/index.js";
import { adaptersCommand } from "./commands/adapters.js";
import { type ExportOptions, exportCommand } from "./commands/export.js";
import { type ImportOptions, importCommand } from "./commands/import.js";
import { inspectCommand } from "./commands/inspect.js";
import { type ListOptions, listCommand } from "./commands/list.js";
import { type MoveOptions, moveCommand } from "./commands/move.js";
import {
  type CommonOptions,
  loadExtraAdapter,
  reportFailure,
  writeJson,
} from "./commands/shared.js";
import { validateCommand } from "./commands/validate.js";
import { VERSION } from "./index.js";

/** For failures that happen before commander has parsed the options. */
const argvWantsJson = (): boolean => process.argv.slice(2).includes("--json");

/** A command action whose failure is printed as `error: <message>` with its exit code. */
function act<A extends unknown[]>(handler: (...args: A) => Promise<void>) {
  return async function (this: Command, ...args: A): Promise<void> {
    try {
      await handler(...args);
    } catch (error) {
      reportFailure(error, this.opts<CommonOptions>().json === true);
    }
  };
}

/** `--source-dir` and `--target-dir`, for the commands that use adapters. */
function withDirs(command: Command): Command {
  return command
    .option("--source-dir <path>", "read the source app from this folder")
    .option("--target-dir <path>", "write into this folder");
}

/** How a command that writes an agent into an app treats it. */
function withWriteFlags(command: Command): Command {
  return command
    .option("--enable-routines", "keep imported routines enabled (by default they are disabled)")
    .option("--include-files", "carry the agent's files/ too")
    .option("--copy", "write a copy next to an agent of the same name")
    .option("--replace", "overwrite an agent of the same name")
    .option("--yes", "replace without asking");
}

/** `--json` and `--quiet`, which every command takes. */
function withOutput(command: Command): Command {
  return command
    .option("--json", "print the result as JSON on stdout")
    .option("--quiet", "print only the result");
}

function buildProgram(): Command {
  const program = new Command("openteleport")
    .version(VERSION)
    .description("Move your AI agent between apps in one command.")
    .exitOverride();

  const list = program
    .command("list")
    .description("list the agents of an app")
    .requiredOption("--from <adapter>", "the app to list");
  withOutput(withDirs(list)).action(act((opts: ListOptions) => listCommand(opts)));

  const exporting = program
    .command("export")
    .description("save an agent as a .jetpack file")
    .requiredOption("--from <adapter>", "the app to export from")
    .option("--agent <id|name>", "the agent to export")
    .option("--out <file.jetpack>", "where to write the file (default: <name>.jetpack)")
    .option("--include-files", "carry the agent's files/ too");
  withOutput(withDirs(exporting)).action(act((opts: ExportOptions) => exportCommand(opts)));

  const importing = program
    .command("import")
    .description("write a .jetpack file or an agent folder into an app")
    .argument("<file.jetpack|folder>", "the bundle to import")
    .requiredOption("--to <adapter>", "the app to import into");
  withOutput(withWriteFlags(withDirs(importing))).action(
    act((source: string, opts: ImportOptions) => importCommand(source, opts)),
  );

  const moving = program
    .command("move")
    .description("move an agent from one app to another")
    .requiredOption("--from <adapter>", "the app to move from")
    .requiredOption("--to <adapter>", "the app to move to")
    .option("--agent <id|name>", "the agent to move")
    .option("--keep <file.jetpack>", "also save the agent as a .jetpack file");
  withOutput(withWriteFlags(withDirs(moving))).action(
    act((opts: MoveOptions) => moveCommand(opts)),
  );

  const inspecting = program
    .command("inspect")
    .description("show what a .jetpack file or an agent folder holds")
    .argument("<file|folder>", "the bundle to inspect");
  withOutput(inspecting).action(
    act((source: string, opts: CommonOptions) => inspectCommand(source, opts)),
  );

  const validating = program
    .command("validate")
    .description("check a .jetpack file or folder against the format and for secrets")
    .argument("<file|folder>", "the bundle to check");
  withOutput(validating).action(
    act((source: string, opts: CommonOptions) => validateCommand(source, opts)),
  );

  const adapters = program
    .command("adapters")
    .description("list the supported apps and whether they are installed");
  withOutput(withDirs(adapters)).action(act((opts: CommonOptions) => adaptersCommand(opts)));

  return program;
}

async function main(): Promise<void> {
  registerBuiltinAdapters();
  const extra = process.env.OPENTELEPORT_EXTRA_ADAPTER;
  if (extra !== undefined && extra !== "") await loadExtraAdapter(extra);

  try {
    await buildProgram().parseAsync();
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    // Commander has printed its own message; help and --version end with 0, any misuse with 2.
    process.exitCode = error.exitCode === 0 ? 0 : 2;
    if (process.exitCode !== 0 && argvWantsJson()) {
      writeJson({ error: { code: 2, message: error.message.replace(/^error: /, "") } });
    }
  }
}

// Last resort: whatever escapes is still one `error:` line, never a stack trace.
process.on("unhandledRejection", (reason) => {
  reportFailure(reason, argvWantsJson());
  process.exit();
});

main().catch((error: unknown) => reportFailure(error, argvWantsJson()));
