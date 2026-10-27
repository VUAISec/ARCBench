/**
 * Equivalence level 2 as a regression test.
 *
 * tests/golden/replay.jsonl holds, for 1,819 sampled episodes (repetition 0) of the seven studies,
 * the sha256 of every model request the reference capture sent against the fake OpenRouter, and the
 * digest of the row it wrote. It was captured from the code that produced the released rows, and
 * covers every study with runs of its own (S2 has none: it is S1's runs grouped by channel).
 *
 * This test replays episodes through the benchmark's pipeline and requires identical requests and
 * rows. By default it checks a stratified subset (every 7th episode); set ARCBENCH_GOLDEN_FULL=1 to
 * check all 1,819.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import { planEpisodes, type Episode } from "../src/plan/episodes.ts";
import { parseArgs } from "../src/cli/args.ts";
import { FACTOR_FLAGS, configurationFromFlags } from "../src/cli/configuration-flags.ts";
import { executeEpisodes } from "../src/engine/pipeline.ts";
import { makeSummarizerCall } from "../src/compaction/registry.ts";
import { installFakeOpenRouter, type FakeOpenRouter } from "../src/harness/fake-openrouter.ts";
import { STUDIES, type Flags } from "../src/rq/studies.ts";
import { normalizeRow, sha } from "./helpers/digest.ts";

interface Golden {
  study: string;
  runId: string;
  requests: string[];
  rowDigest: string;
  valid: boolean;
  grade: string | null;
}

const cfg = { ...loadConfig(), trajectoryRecording: false };
const cases = loadTaskRows("data/rule-loss/cases.jsonl");
const caseMap = new Map(cases.map((r) => [r.id, r]));
const golden: Golden[] = readFileSync("tests/golden/replay.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Golden);
const FULL = process.env["ARCBENCH_GOLDEN_FULL"] === "1";

function planFlags(flags: Flags): Episode[] {
  const argv = Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v]);
  const { configuration } = configurationFromFlags(parseArgs(argv, FACTOR_FLAGS));
  return planEpisodes(configuration!, cases, cfg);
}
const episodes = new Map<string, Episode>();
for (const study of STUDIES) for (const e of study.commands.flatMap(planFlags)) episodes.set(e.runId, e);

let fake: FakeOpenRouter;
beforeAll(() => {
  fake = installFakeOpenRouter();
});
afterAll(() => fake.restore());

const selected = golden.filter((_, i) => FULL || i % 7 === 0);

describe("replay against the original code's golden requests and rows", () => {
  it("covers every study", () => {
    expect(new Set(golden.map((g) => g.study))).toEqual(new Set(STUDIES.filter((s) => s.commands.length > 0).map((s) => s.id)));
    expect(golden.length).toBe(1819);
  });

  it(`sends byte-identical requests and records identical rows (${FULL ? "all" : "stratified subset of"} ${selected.length} episodes)`, async () => {
    const problems: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "arcbench-golden-"));
    for (const g of selected) {
      const episode = episodes.get(g.runId);
      if (!episode) {
        problems.push(`${g.runId}: not planned`);
        continue;
      }
      const resultsDir = join(root, g.study);
      const start = fake.requests.length;
      const [row] = await executeEpisodes([episode], {
        cfg,
        apiKey: "fake",
        resultsDir,
        rows: caseMap,
        deps: { summarizerCall: makeSummarizerCall(cfg, "fake") },
        batchSize: 1,
      });
      const requests = fake.requests.slice(start).map((q) => q.sha256);
      if (JSON.stringify(requests) !== JSON.stringify(g.requests)) problems.push(`${g.runId}: requests differ`);
      if (sha(JSON.stringify(normalizeRow(row, resultsDir))) !== g.rowDigest) problems.push(`${g.runId}: row differs`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
  }, 900_000);
});
