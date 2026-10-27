/**
 * The v1.1 delivery arms, for tests that document pi's per-tool-result cap across arms.
 *
 * The benchmark configures A3 only (the arm sized so pi's 2,000-char cap never bites, used by every
 * 17-case study). A1 (one tool result) and A2 (8,000-char chunks, the v1.1 reference) exist here so
 * the tests that pin pi's truncation behaviour -- and why A3 is the arm -- keep running unchanged.
 */
import { loadConfig, type BenchmarkConfig } from "../../src/config/config.ts";

export function legacyArmsConfig(): BenchmarkConfig {
  return {
    ...loadConfig(),
    haystackArms: [
      { id: "A1", delivery: "single-tool-result", chunkChars: null, reference: false },
      { id: "A2", delivery: "chunked-tool-results", chunkChars: 8000, reference: true },
      { id: "A3", delivery: "chunked-tool-results", chunkChars: 1930, reference: false },
    ],
  };
}
