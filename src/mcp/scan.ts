import { secretScanExclusions } from "../core/secrets.js";
import type { Bundle } from "../core/schema.js";

/** Coverage metadata is not a certificate that a bundle is safe to share. */
export function scanDisclosure(bundle: Bundle) {
  const unscanned = secretScanExclusions(bundle);
  const count = unscanned.oversizedFiles + unscanned.binaryFiles + unscanned.avatars;
  return {
    method: "heuristic-text" as const,
    unscanned,
    limitations: "The scanner checks supported text for known credential patterns. File/path names and some metadata fields are outside its scan scope; personal information is not anonymized.",
    warnings: count > 0 ? [
      `${count} payload(s) were not scanned for secrets: ${unscanned.oversizedFiles} oversized file(s), ${unscanned.binaryFiles} binary file(s), ${unscanned.avatars} avatar(s). Review them locally before sharing.`,
    ] : [],
  };
}
