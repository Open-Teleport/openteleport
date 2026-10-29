import { dirname, join, resolve } from "node:path";
import type { Ctx } from "../adapters/types.js";
import type { Bundle } from "../core/schema.js";
import { slugify } from "../core/text.js";
import { agentsDir, codexHome, IDS_FILE, userSkillsDir } from "../adapters/codex/paths.js";
import { claudePaths } from "../adapters/claude-code/paths.js";
import { hermesHome } from "../adapters/hermes/paths.js";
import { openclawPaths } from "../adapters/openclaw/paths.js";

type Location = {
  path: string;
  kind: "container" | "file" | "candidate";
  shared: boolean;
  purpose: string;
};

/** Read-only location disclosure, deliberately not a file diff or conflict-resolution plan.
 * Reuse the writers' path helpers; do not inspect payloads or run destination commands.
 * sourceDir must never redirect a target helper.
 */
export async function destinationScope(app: string, ctx: Ctx, bundle: Bundle) {
  const { sourceDir: _source, ...target } = ctx;
  const locations: Location[] = [];
  const unresolved: string[] = ["Final agent name and individual file changes are decided during apply; these locations are not reserved."];
  const add = (path: string, kind: Location["kind"], shared: boolean, purpose: string) =>
    locations.push({ path: resolve(ctx.cwd, path), kind, shared, purpose });
  switch (app) {
    case "codex": {
      const home = codexHome(target);
      add(agentsDir(home), "container", false, "Custom agent definitions");
      add(join(home, IDS_FILE), "file", true, "OpenTeleport agent identity map");
      if (bundle.skills.length) add(userSkillsDir(target), "container", true, "Skills shared with other agents and applications, even with an explicit targetDir");
      break;
    }
    case "claude-code": {
      const paths = claudePaths(target);
      add(paths.projectAgents, "container", false, "Project agent definitions");
      if (bundle.skills.length) add(paths.projectSkills, "container", true, "Skills shared by this project");
      const memory = paths.memoryDir(paths.projectDir);
      if (bundle.facts.length || bundle.notes.length) add(memory, "container", true, "Project memory under the Claude user configuration directory");
      add(dirname(memory), "container", true, "OpenTeleport identity metadata beside project memory");
      break;
    }
    case "hermes":
      add(join(await hermesHome(target), "profiles"), "container", false, "Named profile containing instructions, skills, memory and routine files");
      break;
    case "openclaw": {
      const paths = openclawPaths(target);
      add(paths.stateDir, "container", true, "Application state; agent and routine registration may change shared state");
      add(paths.configFile, "file", true, "Application configuration, including agent registration");
      unresolved.push("The agent workspace can be outside the state directory. Its path depends on existing agent configuration and conflict resolution and is not resolved here.");
      break;
    }
    case "folder":
      add(target.targetDir ?? join(ctx.cwd, slugify(bundle.manifest.name, { fallback: "agent", deviceSuffix: "-r" })), "candidate", false,
        "Requested agent folder; conflicts can select a sibling. Updating an owned folder may remove stale bundle entries.");
      break;
    case "openbot":
    case "grok-bot":
    case "letta":
      add(target.targetDir ?? ctx.cwd, "container", false, "Handoff artifact parent directory; the application is not updated until the manual import step");
      break;
    default:
      if (target.targetDir) add(target.targetDir, "candidate", false, "Requested directory; this adapter has no location disclosure");
      unresolved.push("This adapter's complete write locations are unknown.");
  }
  return { coverage: locations.length && ["codex", "claude-code", "hermes", "openclaw", "folder", "openbot", "grok-bot", "letta"].includes(app)
    ? "locations-only" as const : "unavailable" as const, locations, unresolved };
}
