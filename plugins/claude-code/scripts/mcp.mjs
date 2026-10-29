// Use a deliberately configured local build. No downloads or shell command interpolation.
import { isAbsolute } from "node:path";
import { accessSync, constants, statSync } from "node:fs";
import { spawn } from "node:child_process";

function configurationError() {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    return "OpenTeleport requires Node >=24. Configure the plugin MCP command with a supported Node executable.";
  }
  const cli = process.env.OPENTELEPORT_CLI;
  if (!cli || !isAbsolute(cli)) {
    return "Set OPENTELEPORT_CLI to the absolute path of the installed dist/cli.js, then restart the MCP connection.";
  }
  try {
    if (!statSync(cli).isFile()) throw new Error("not a file");
    accessSync(cli, constants.R_OK);
  } catch {
    return "OPENTELEPORT_CLI must point to a readable CLI file. Build OpenTeleport with npm ci and npm run build, check the dist/cli.js path, then restart the MCP connection.";
  }
}

const error = configurationError();
if (error) {
  process.stderr.write(error + "\n");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [process.env.OPENTELEPORT_CLI, "mcp"], { stdio: "inherit", shell: false });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", () => { process.stderr.write("Cannot start the configured OpenTeleport CLI.\n"); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
}
