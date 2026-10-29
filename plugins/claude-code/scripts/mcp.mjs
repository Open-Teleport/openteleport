// Use a deliberately configured local build. No downloads or shell command interpolation.
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
const cli = process.env.OPENTELEPORT_CLI;
if (!cli || !isAbsolute(cli)) {
  process.stderr.write("Set OPENTELEPORT_CLI to the absolute path of the installed dist/cli.js (Node >=24).\n");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [cli, "mcp"], { stdio: "inherit", shell: false });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", () => { process.stderr.write("Cannot start the configured OpenTeleport CLI.\n"); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
}
