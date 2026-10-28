import { readBundle } from "../core/bundle.js";
import { type SecretFinding, scanSecrets } from "../core/secrets.js";
import {
  type CommonOptions,
  NO_MANIFEST_WARNING,
  existingPath,
  findingLine,
  messageOf,
  writeJson,
  writeOut,
} from "./shared.js";

/**
 * `validate <file|folder>`: checks a `.jetpack` archive or an agent folder against the format
 * (manifest schema, paths and limits, all that reading it checks) and scans it for secrets. An
 * archive must hold `jetpack.json`; a folder may do without, as the folder adapter reads one, and
 * gets a warning instead. Exit code 1 for any error or finding; a finding is shown by where it
 * is, never by its text.
 */
export async function validateCommand(source: string, opts: CommonOptions): Promise<void> {
  const { path, isDirectory } = await existingPath(source);
  const errors: string[] = [];
  const warnings: string[] = [];
  let findings: SecretFinding[] = [];
  try {
    const bundle = await readBundle(path, { requireManifest: !isDirectory });
    // A manifest that was read always has a valid id; only a synthesized one is empty.
    if (bundle.manifest.id === "") warnings.push(NO_MANIFEST_WARNING);
    findings = scanSecrets(bundle);
  } catch (error) {
    errors.push(messageOf(error));
  }
  const ok = errors.length === 0 && findings.length === 0;
  if (!ok) process.exitCode = 1;

  if (opts.json === true) {
    writeJson({ ok, findings, errors, warnings });
    return;
  }
  const warningLines = warnings.map((warning) => `warning: ${warning}`);
  if (ok) {
    const what = warnings.includes(NO_MANIFEST_WARNING) ? "agent folder" : ".jetpack";
    writeOut([`${path} is a valid ${what}`, ...warningLines].join("\n"));
    return;
  }
  const problems = [
    ...errors,
    ...findings.map((finding) => `${findingLine(finding)} (possible secret)`),
  ];
  writeOut(
    [
      `${path} is not valid:`,
      ...problems.map((problem) => `- ${problem}`),
      `${problems.length} problem${problems.length === 1 ? "" : "s"} found.`,
      ...warningLines,
    ].join("\n"),
  );
}
