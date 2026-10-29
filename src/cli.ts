import { Command, CommanderError, Option } from "commander";
import { registerBuiltinAdapters } from "./adapters/index.js";
import { adaptersCommand } from "./commands/adapters.js";
import { type ExportOptions, exportCommand } from "./commands/export.js";
import { type ImportOptions, importCommand } from "./commands/import.js";
import { inspectCommand } from "./commands/inspect.js";
import { type ListOptions, listCommand } from "./commands/list.js";
import { type MoveOptions, moveCommand } from "./commands/move.js";
import {
  type CommonOptions,
  UsageError,
  exitOnBrokenPipe,
  hasTerminal,
  loadExtraAdapter,
  reportFailure,
  writeJson,
} from "./commands/shared.js";
import { validateCommand } from "./commands/validate.js";
import { clackPrompter, runWizard } from "./commands/wizard.js";
import { VERSION } from "./version.js";

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

// -- Help -----------------------------------------------------------------------------------
//
// `--help` shows what most people need; `--help-all` (also after a command, as in
// `move --help-all`) shows everything. Both are printed by one program, built with `showAll` set
// or not: what only the full help shows is registered as hidden, and works when typed all the same.

const HELP_ALL = "--help-all";

type Row = readonly [term: string, description: string];

/** The flags `openteleport --help` lists, once for all the commands. */
const BASIC_FLAGS: readonly Row[] = [
  ["--from <app>", "the app an agent comes from"],
  ["--to <app>", "the app an agent goes to"],
  ["--agent <id|name>", "which agent (a terminal asks if you leave it out)"],
  ["--out <file.jetpack>", "where export writes the file"],
  ["--include-files", "carry the agent's files/ too"],
  ["--no-memory", "omit structured facts and notes (not anonymization)"],
  ["--json", "print the result as JSON on stdout"],
];

/** What `openteleport --help-all` lists on top of those. */
const ADVANCED_FLAGS: readonly Row[] = [
  ["--source-dir <path>", "read the source app from this folder"],
  ["--target-dir <path>", "write into this folder"],
  ["--copy", "write a copy next to an agent of the same name"],
  ["--replace", "overwrite an agent of the same name"],
  ["--yes", "replace without asking"],
  ["--enable-routines", "keep imported routines enabled (by default they are disabled)"],
  ["--keep <file.jetpack>", "move also saves the agent as a file"],
  ["--no-overwrite", "export refuses an existing archive and saves a separate report"],
  ["--quiet", "print only the result"],
];

const ENVIRONMENT: readonly Row[] = [
  ["OPENTELEPORT_HOME", "where reports and agent ids are kept (default: your home folder)"],
  ["OPENTELEPORT_EXTRA_ADAPTER", "a module whose default export adds an app"],
];

/** A titled list of `term  description` lines, the descriptions in one column. */
function section(title: string, rows: readonly Row[]): string {
  const width = Math.max(...rows.map(([term]) => term.length));
  return [`${title}:`, ...rows.map(([term, text]) => `  ${term.padEnd(width)}  ${text}`)].join(
    "\n",
  );
}

/** What `openteleport --help` and `--help-all` print below the list of commands. */
function rootHelpFooter(showAll: boolean): string {
  if (showAll) {
    return `\n${section("Flags", [...BASIC_FLAGS, ...ADVANCED_FLAGS])}\n\n${section("Environment", ENVIRONMENT)}`;
  }
  return `\n${section("Flags", BASIC_FLAGS)}\n\nMore: \`openteleport ${HELP_ALL}\` lists every command and flag.`;
}

// -- The commands ---------------------------------------------------------------------------

function buildProgram(showAll: boolean): Command {
  /** An option that only the full help lists. */
  const advanced = (flags: string, description: string): Option =>
    new Option(flags, description).hideHelp(!showAll);

  /** `--source-dir` and `--target-dir`, for the commands that use adapters. */
  const withDirs = (command: Command): Command =>
    command
      .addOption(advanced("--source-dir <path>", "read the source app from this folder"))
      .addOption(advanced("--target-dir <path>", "write into this folder"));

  /** How a command that writes an agent into an app treats it. */
  const withWriteFlags = (command: Command): Command =>
    command
      .addOption(
        advanced("--enable-routines", "keep imported routines enabled (by default they are disabled)"),
      )
      .option("--no-memory", "omit facts and notes; updates may remove existing imported memory")
      .option("--include-files", "carry the agent's files/ too")
      .addOption(advanced("--copy", "write a copy next to an agent of the same name"))
      .addOption(advanced("--replace", "overwrite an agent of the same name"))
      .addOption(advanced("--yes", "replace without asking"));

  /** `--json` and `--quiet`, which every command takes. */
  const withOutput = (command: Command): Command =>
    command
      .option("--json", "print the result as JSON on stdout")
      .addOption(advanced("--quiet", "print only the result"));

  const program = new Command("openteleport")
    .version(VERSION)
    .description("Move your AI agent between apps in one command.")
    .addHelpText("after", rootHelpFooter(showAll))
    .exitOverride();

  const moving = program
    .command("move")
    .description("move an agent from one app to another")
    .requiredOption("--from <adapter>", "the app to move from")
    .requiredOption("--to <adapter>", "the app to move to")
    .option("--agent <id|name>", "the agent to move")
    .addOption(advanced("--keep <file.jetpack>", "also save the agent as a .jetpack file"));
  withOutput(withWriteFlags(withDirs(moving))).action(
    act((opts: MoveOptions) => moveCommand(opts)),
  );

  const exporting = program
    .command("export")
    .description("save an agent as a .jetpack file")
    .option("--from <adapter>", "the app to export from (default: the agent folder you are in)")
    .option("--agent <id|name>", "the agent to export")
    .option("--out <file.jetpack>", "where to write the file (default: <name>.jetpack)")
    .addOption(advanced("--no-overwrite", "refuse existing archives and save a separate report"))
    .option("--no-memory", "omit facts and notes; updates may remove existing imported memory")
      .option("--include-files", "carry the agent's files/ too");
  withOutput(withDirs(exporting)).action(act((opts: ExportOptions) => exportCommand(opts)));

  const importing = program
    .command("import")
    .description("write a .jetpack file or an agent folder into an app")
    .argument("<file.jetpack|folder>", "the bundle to import")
    .option("--to <adapter>", "the app to import into (default: a folder named after the agent)");
  withOutput(withWriteFlags(withDirs(importing))).action(
    act((source: string, opts: ImportOptions) => importCommand(source, opts)),
  );

  const listing = program
    .command("list")
    .description("list the agents of an app")
    .requiredOption("--from <adapter>", "the app to list");
  withOutput(withDirs(listing)).action(act((opts: ListOptions) => listCommand(opts)));

  const inspecting = program
    .command("inspect")
    .description("show what a .jetpack file or an agent folder holds")
    .argument("<file|folder>", "the bundle to inspect");
  withOutput(inspecting).action(
    act((source: string, opts: CommonOptions) => inspectCommand(source, opts)),
  );

  const validating = program
    .command("validate", { hidden: !showAll })
    .description("check a .jetpack file or folder against the format and for secrets")
    .argument("<file|folder>", "the bundle to check");
  withOutput(validating).action(
    act((source: string, opts: CommonOptions) => validateCommand(source, opts)),
  );

  const adapters = program
    .command("adapters", { hidden: !showAll })
    .description("list the supported apps and whether they are installed");
  withOutput(withDirs(adapters)).action(act((opts: CommonOptions) => adaptersCommand(opts)));

  program.command("mcp", { hidden: !showAll }).description("serve local MCP tools over stdio").action(act(async () => { const { startMcpServer } = await import("./mcp/server.js"); await startMcpServer(); }));

  return program;
}

/** True for `openteleport` alone, or with nothing but `--json` or `--quiet`. */
const givesNoCommand = (args: readonly string[]): boolean =>
  args.every((arg) => arg === "--json" || arg === "--quiet");

async function main(): Promise<void> {
  registerBuiltinAdapters();
  const extra = process.env.OPENTELEPORT_EXTRA_ADAPTER;
  if (extra !== undefined && extra !== "") await loadExtraAdapter(extra);

  const args = process.argv.slice(2);
  const program = buildProgram(args.includes(HELP_ALL));

  if (givesNoCommand(args)) {
    if (args.length === 0 && hasTerminal()) {
      // The wizard ends with 0 whether it moved an agent or the user backed out.
      await runWizard(clackPrompter(), {}).catch((error: unknown) => reportFailure(error, false));
    } else if (args.includes("--json")) {
      reportFailure(new UsageError("No command given"), true);
    } else {
      program.outputHelp();
      process.exitCode = 2;
    }
    return;
  }

  try {
    // `--help-all` is `--help` of the program that was built with everything shown.
    const given = args.map((arg) => (arg === HELP_ALL ? "--help" : arg));
    await program.parseAsync(given, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    // Commander has printed its own message; help and --version end with 0, any misuse with 2.
    process.exitCode = error.exitCode === 0 ? 0 : 2;
    if (process.exitCode !== 0 && argvWantsJson()) {
      writeJson({ error: { code: 2, message: error.message.replace(/^error: /, "") } });
    }
  }
}

// `openteleport list ... | head` closes the pipe early: that ends the program, it is no error.
process.stdout.on("error", exitOnBrokenPipe);
process.stderr.on("error", exitOnBrokenPipe);

// Last resort: whatever escapes is still one `error:` line, never a stack trace.
process.on("unhandledRejection", (reason) => {
  reportFailure(reason, argvWantsJson());
  process.exit();
});

main().catch((error: unknown) => reportFailure(error, argvWantsJson()));
