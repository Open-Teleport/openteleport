import { expect, it } from "vitest";
import { publicFindings } from "../../src/mcp/findings.js";

it("returns locations and kinds without secret previews, including credentials in paths", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz";
  const findings = [
    { path: `skills/${token}/SKILL.md`, line: 3, kind: "github-token", preview: "ghp_ab…" },
    { path: "routines/ghp_ab….json", kind: "github-token", preview: "ghp_ab…" },
  ];
  expect(publicFindings(findings)).toEqual([
    { path: "skills/[redacted]/SKILL.md", line: 3, kind: "github-token" },
    { path: "routines/[redacted].json", kind: "github-token" },
  ]);
  expect(findings[0].path).toContain(token);
});

it("redacts a routine name independently of the credential found in its instruction", () => {
  const result = publicFindings([
    { path: "routines/ghp_ab….json", kind: "github-token", preview: "ghp_ab…" },
    { path: "routines/ghp_ab….json", kind: "openai-api-key", preview: "sk-xyz…" },
  ]);
  expect(result.every(finding => finding.path === "routines/[redacted].json")).toBe(true);
});
