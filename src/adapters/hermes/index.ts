import type { Adapter, AdapterCapabilities, Ctx } from "../types.js";
import { hermesHome, isProfile } from "./paths.js";
import { hermesCacheIdentity, listHermesProfiles, readHermesProfile } from "./read.js";
import { writeHermesProfile } from "./write.js";

const CAPABILITIES: AdapterCapabilities = {
  persona: true,
  instructions: true,
  skills: true,
  routines: true,
  facts: true,
  notes: false,
  files: false,
  avatar: false,
  models: true,
  schedules: ["cron", "every", "at"],
};

const HINT = "Install Hermes Agent or pass --source-dir <HERMES_HOME>";

/** Found when the Hermes home holds one of the files that make a directory a profile. */
async function detect(ctx: Ctx): Promise<Awaited<ReturnType<Adapter["detect"]>>> {
  const location = hermesHome(ctx);
  if (await isProfile(location)) return { found: true, location };
  return { found: false, location, hint: HINT };
}

/**
 * Hermes Agent (Nous Research), through its files only: a profile is the Hermes home itself
 * (`default`) or a directory below `profiles/`. Nothing runs `hermes`, so `version` is not known.
 * Writing needs the Hermes home to exist, hence no `createsOnWrite`.
 */
export const hermesAdapter: Adapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  capabilities: CAPABILITIES,
  createsOnWrite: false,
  detect,
  list: listHermesProfiles,
  read: readHermesProfile,
  cacheIdentity: hermesCacheIdentity,
  write: writeHermesProfile,
};

export default hermesAdapter;
