import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
it("keeps package, plugin and marketplace names/versions consistent", async () => {
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const pkg = await json("package.json");
  const plugin = await json("plugins/claude-code/.claude-plugin/plugin.json");
  const market = await json(".claude-plugin/marketplace.json");
  expect(plugin).toMatchObject({ name: pkg.name, version: pkg.version, license: "Apache-2.0" });
  expect(market.plugins[0]).toMatchObject({ name: pkg.name, version: pkg.version, source: "./plugins/claude-code" });
  const config = await json("plugins/claude-code/.mcp.json");
  expect(config.mcpServers.openteleport.command).toBe("node");
  expect(config.mcpServers.openteleport.args[0]).toBe("$" + "{CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs");
});
