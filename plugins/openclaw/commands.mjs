import { copyFile, constants } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

async function runtime() {
  // Lazy imports: registration/help do not load adapters or spawn another OpenClaw process.
  const [library, { execa }] = await Promise.all([import("openteleport"), import("execa")]);
  library.registerBuiltinAdapters();
  return {
    library,
    ctx: {
      home: resolve(process.env.OPENTELEPORT_HOME || homedir()),
      cwd: process.cwd(), env: { ...process.env }, exec: execa,
      logger: (message) => process.stderr.write(message + "\n"),
    },
  };
}

export function registerTeleportCommands(program, options = {}) {
  if (program.commands.some((command) => command.name() === "teleport")) {
    throw new Error("Cannot register OpenTeleport: the teleport command already exists.");
  }
  const load = options.load ?? runtime;
  const output = options.output ?? ((result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n"));
  const failure = options.failure ?? ((error) => {
    process.stderr.write("OpenTeleport: " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
  const action = (handler) => async (...args) => {
    try { await handler(...args); } catch (error) { failure(error); }
  };
  const root = program.command("teleport").description("Import and export portable agent profiles");
  root.command("list").description("List agents in this OpenClaw instance")
    .action(action(async () => {
      const { library, ctx } = await load();
      const adapter = library.getAdapter("openclaw");
      if (!(await adapter.detect(ctx)).found) throw new Error("OpenClaw was not detected in the selected instance.");
      output({ agents: await adapter.list(ctx) });
    }));
  root.command("export").description("Export an agent; refuses an existing output file")
    .argument("<agent>", "source agent ID").requiredOption("--out <file.jetpack>", "new archive path")
    .option("--include-files", "include files/ (may contain personal data)")
    .action(action(async (agent, flags) => {
      const { library, ctx } = await load();
      const adapter = library.getAdapter("openclaw");
      if (!(await adapter.detect(ctx)).found) throw new Error("OpenClaw was not detected in the selected instance.");
      const temporary = await mkdtemp(join(tmpdir(), "openteleport-openclaw-"));
      try {
        const archive = join(temporary, "agent.jetpack");
        const { report } = await library.exportBundle({
          from: adapter, agent, ctx, out: archive, includeFiles: flags.includeFiles === true,
        });
        const out = resolve(ctx.cwd, flags.out);
        await promisify(copyFile)(archive, out, constants.COPYFILE_EXCL);
        output({ ...report, artifactPath: out });
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }));
  root.command("import").description("Import into this instance; source bundle is retained")
    .argument("<bundle>", "archive or agent folder")
    .option("--copy", "create a copy rather than update the same agent")
    .option("--include-files", "include files/ (may contain personal data)")
    .option("--enable-routines", "explicitly enable imported routines")
    .action(action(async (path, flags) => {
      const { library, ctx } = await load();
      const adapter = library.getAdapter("openclaw");
      if (!adapter.createsOnWrite && !(await adapter.detect(ctx)).found) {
        throw new Error("OpenClaw was not detected in the selected instance.");
      }
      const absolute = resolve(ctx.cwd, path);
      const bundle = await library.readBundle(absolute, { requireManifest: !(await stat(absolute)).isDirectory() });
      output(await library.importBundle({
        to: adapter, bundle, ctx, write: {
          onConflict: flags.copy ? "copy" : "update",
          includeFiles: flags.includeFiles === true, enableRoutines: flags.enableRoutines === true,
        },
      }));
    }));
}
