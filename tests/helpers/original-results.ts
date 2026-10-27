/**
 * Whether the released study rows are present under results/ (results/MANIFEST.sha256).
 *
 * A checkout without them (for example a code-only copy) still runs every other test. Tests that
 * compare against those rows skip -- visibly, with this reason -- rather than pass vacuously.
 */
import { existsSync } from "node:fs";

export const ORIGINAL_RESULTS = "results";
export const HAVE_ORIGINAL_RESULTS = existsSync(`${ORIGINAL_RESULTS}/MANIFEST.sha256`);
export const MISSING_ORIGINAL_REASON =
  "results/MANIFEST.sha256 is absent; comparisons with the released study rows are skipped";
