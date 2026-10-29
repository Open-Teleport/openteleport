import { SECRET_PATTERNS, type SecretFinding } from "../core/secrets.js";

/** The CLI scanner's recognition preview is not part of the model-facing MCP contract. */
export function publicFindings(findings: readonly SecretFinding[]) {
  const previews = new Set(findings.map(finding => finding.preview));
  return findings.map(finding => {
    let path = finding.path;
    for (const { regex } of SECRET_PATTERNS) {
      path = path.replace(new RegExp(regex.source, regex.flags + "g"), "[redacted]");
    }
    // Routine names may already have been shortened to six characters plus an ellipsis.
    // Remove every known truncated match, including one belonging to another finding.
    path = path.replace(/.{6}…/gu, match => previews.has(match) ? "[redacted]" : match);
    return { path, ...(finding.line === undefined ? {} : { line: finding.line }), kind: finding.kind };
  });
}
