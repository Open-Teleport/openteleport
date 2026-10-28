import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, AdapterCapabilities, Ctx } from "../types.js";
import { CRONS_FILE, cloudAgentsDir, lettaDir, localBackendDir } from "./paths.js";
import { listLettaAgents, lettaCacheIdentity, readLettaAgent } from "./read.js";
import { writeLettaAgent } from "./write.js";

const CAPABILITIES: AdapterCapabilities = {
  persona: true,
  instructions: true,
  skills: true,
  routines: true,
  facts: true,
  notes: true,
  files: false,
  avatar: false,
  models: true,
  schedules: ["cron", "every", "at"],
};

const HINT = "Install Letta Code (npm i -g @letta-ai/letta-code) or pass --source-dir <~/.letta>";

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Found when Letta's directory holds agents (either backend) or scheduled tasks. Runs nothing. */
async function detect(ctx: Ctx): Promise<Awaited<ReturnType<Adapter["detect"]>>> {
  const letta = lettaDir(ctx);
  const places = [cloudAgentsDir(letta), localBackendDir(ctx, letta), join(letta, CRONS_FILE)];
  const found = (await Promise.all(places.map(exists))).some(Boolean);
  return { found, location: letta, ...(found ? {} : { hint: HINT }) };
}

/**
 * Letta Code: agents of the local backend and Letta Cloud agents' local memory, read from
 * `~/.letta` (MemFS folders and `crons.json`). The write side is a handoff: a folder with the
 * memory in MemFS layout and the `letta` commands that load it, so no Letta install is needed
 * to write it (`createsOnWrite`). Avatars and `files/` have no place in Letta.
 */
export const lettaAdapter: Adapter = {
  name: "letta",
  displayName: "Letta Code",
  capabilities: CAPABILITIES,
  createsOnWrite: true,
  detect,
  list: listLettaAgents,
  read: readLettaAgent,
  cacheIdentity: lettaCacheIdentity,
  write: writeLettaAgent,
};

export default lettaAdapter;
