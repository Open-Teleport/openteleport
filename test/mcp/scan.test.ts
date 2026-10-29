import { expect, it } from "vitest";
import type { Bundle } from "../../src/core/schema.js";
import { MAX_TEXT_ENTRY_BYTES } from "../../src/core/paths.js";
import { scanSecrets, secretScanExclusions } from "../../src/core/secrets.js";
import { scanDisclosure } from "../../src/mcp/scan.js";

it("discloses skipped payloads even when there are no secret findings", () => {
  const secret = new TextEncoder().encode("ghp_abcdefghijklmnopqrstuvwxyz");
  const binary = new Uint8Array(secret.length + 1); binary.set(secret, 1);
  const oversized = new Uint8Array(MAX_TEXT_ENTRY_BYTES + 1).fill(65); oversized.set(secret);
  const bundle: Bundle = {
    manifest: { schemaVersion: "0.1", id: "", name: "Sample", models: [], capabilities: [] },
    instructions: "No credentials", facts: [], notes: [], routines: [], unknownPaths: [],
    skills: [{ name: "sample", files: [{ path: "asset.bin", bytes: binary }] }],
    files: [{ path: "large.txt", bytes: oversized }], avatar: { name: "avatar.png", bytes: binary },
  };
  expect(scanSecrets(bundle)).toEqual([]);
  expect(secretScanExclusions(bundle)).toEqual({ binaryFiles: 1, oversizedFiles: 1, avatars: 1 });
  const disclosure = scanDisclosure(bundle);
  expect(disclosure.warnings[0]).toContain("3 payload(s)");
  expect(JSON.stringify(disclosure)).not.toContain("ghp_");
  expect(scanDisclosure({ ...bundle, files: [], avatar: undefined }).unscanned)
    .toEqual({ binaryFiles: 1, oversizedFiles: 0, avatars: 0 });
});
