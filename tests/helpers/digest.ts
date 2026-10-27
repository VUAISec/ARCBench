/**
 * Shared by the golden capture scripts and the replay test, so each side digests rows alike.
 *
 * A row is compared after removing only what cannot match between two runs: wall-clock timings,
 * and the temporary results directory each side wrote under. Everything else -- every field, its
 * value and its key order -- goes into the digest.
 */
import { createHash } from "node:crypto";

export const VOLATILE_KEYS = new Set(["prepareMs", "decisionMs", "durationMs", "latencyMs"]);

export function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function normalizeRow(row: unknown, resultsDir: string): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.split(resultsDir).join("<RESULTS>");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (VOLATILE_KEYS.has(k)) continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(row);
}

export interface Capture {
  study: string;
  runId: string;
  requests: string[];
  rowDigest: string;
  valid: boolean;
  invalidReason: string | null;
  grade: string | null;
  /** The normalized row, for diagnosing a mismatch. */
  row: unknown;
  /** Normalized request bodies, for diagnosing a mismatch. */
  bodies: string[];
}
