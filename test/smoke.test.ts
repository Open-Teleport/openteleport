import { fileURLToPath } from "node:url";
import { execaNode } from "execa";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

it("prints version", async () => {
  const { stdout } = await execaNode(cli, ["--version"]);
  expect(stdout).toMatch(/^0\.1\.0$/);
});
