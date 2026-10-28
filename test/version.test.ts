import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { VERSION as fromIndex } from "../src/index.js";
import { VERSION } from "../src/version.js";

it("is the version in package.json, also from the package entry point", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  expect(VERSION).toBe(pkg.version);
  expect(fromIndex).toBe(VERSION);
});
