import { registerTeleportCommands } from "./commands.mjs";

// OpenClaw's public plugin definition shape. Discovery only registers commands.
export default {
  id: "openteleport", name: "OpenTeleport",
  description: "Import and export portable agent profiles",
  register(api) {
    api.registerCli(({ program }) => registerTeleportCommands(program), {
      descriptors: [{ name: "teleport", description: "Import and export agents", hasSubcommands: true }],
    });
  },
};
