import { readBundle } from "../core/bundle.js";
import { type SecretFinding, scanSecrets } from "../core/secrets.js";
import {
  type CommonOptions,
  existingPath,
  findingLine,
  messageOf,
  writeJson,
  writeOut,
} from "./shared.js";

/**
 * `validate <file|folder>`: checks a `.jetpack` archive or an unpacked one against the format
 * (manifest schema, paths and limits, all that reading it checks) and scans it for secrets.
 * Exit code 1 for any error or finding; a finding is shown by where it is, never by its text.
 */
export async function validateCommand(source: string, opts: CommonOptions): Promise<void> {
  const { path } = await existingPath(source);
  const errors: string[] = [];
  let findings: SecretFinding[] = [];
  try {
    findings = scanSecrets(await readBundle(path));
  } catch (error) {
    errors.push(messageOf(error));
  }
  const ok = errors.length === 0 && findings.length === 0;
  if (!ok) process.exitCode = 1;

  if (opts.json === true) {
    writeJson({ ok, findings, errors });
    return;
  }
  if (ok) {
    writeOut(`${path} is a valid .jetpack`);
    return;
  }
  const problems = [
    ...errors,
    ...findings.map((finding) => `${findingLine(finding)} (possible secret)`),
  ];
  writeOut(
    [
      `${path} is not a valid .jetpack:`,
      ...problems.map((problem) => `- ${problem}`),
      `${problems.length} problem${problems.length === 1 ? "" : "s"} found.`,
    ].join("\n"),
  );
}
