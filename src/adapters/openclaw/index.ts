import { stat } from "node:fs/promises";
import type { Adapter, AdapterCapabilities, Ctx } from "../types.js";
import { OpenClawCli } from "./cli.js";
import { openclawPaths } from "./paths.js";
import { listOpenClawAgents, readOpenClawAgent } from "./read.js";

const CAPABILITIES: AdapterCapabilities = {
  persona: true,
  instructions: true,
  skills: true,
  routines: true,
  facts: true,
  notes: true,
  files: false,
  avatar: true,
  models: true,
  schedules: ["cron", "every", "at"],
};

const HINT = "Install OpenClaw or pass --source-dir <state dir>";

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

/** Found when the config file exists; the CLI version is added when `openclaw` runs. */
async function detect(ctx: Ctx): Promise<Awaited<ReturnType<Adapter["detect"]>>> {
  const { stateDir, configFile } = openclawPaths(ctx);
  const found = await isFile(configFile);
  const version = await new OpenClawCli(ctx, stateDir).version();
  return {
    found,
    location: stateDir,
    ...(version === undefined ? {} : { version }),
    ...(found ? {} : { hint: HINT }),
  };
}

/** OpenClaw: the state directory (`openclaw.json`, workspaces) plus the `openclaw` CLI. */
export const openclawAdapter: Adapter = {
  name: "openclaw",
  displayName: "OpenClaw",
  capabilities: CAPABILITIES,
  detect,
  list: listOpenClawAgents,
  read: readOpenClawAgent,
  async write() {
    throw new Error("OpenClaw write is implemented in a later task");
  },
};

export default openclawAdapter;
