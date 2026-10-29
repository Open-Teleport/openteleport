import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execaNode } from "execa";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));

it("prints the version from package.json", async () => {
  const { version } = JSON.parse(await readFile(packageJson, "utf8")) as { version: string };
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  const { stdout } = await execaNode(cli, ["--version"]);
  expect(stdout).toBe(version);
});
