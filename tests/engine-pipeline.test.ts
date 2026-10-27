/**
 * The pipeline end to end, against the offline fake model: every stage runs, rows are valid, and a
 * row written under a past study's cohort has that study's fields in that study's order.
 *
 * The reference rows are the copied results in results/ (see results/README.md).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import { planEpisodes } from "../src/plan/episodes.ts";
import type { Configuration } from "../src/plan/configuration.ts";
import { executeEpisodes, type ResultRow } from "../src/engine/pipeline.ts";
import { makeSummarizerCall } from "../src/compaction/registry.ts";
import { installFakeOpenRouter, type FakeOpenRouter } from "../src/harness/fake-openrouter.ts";
import { HAVE_ORIGINAL_RESULTS } from "./helpers/original-results.ts";

const cfg = { ...loadConfig(), trajectoryRecording: false };
const rows = loadTaskRows("data/rule-loss/cases.jsonl");
const GLM = "z-ai/glm-5.3-flash";
let fake: FakeOpenRouter;

beforeAll(() => {
  fake = installFakeOpenRouter();
});
afterAll(() => fake.restore());

function config(over: Partial<Configuration>): Configuration {
  return {
    agentModel: GLM,
    compactorModel: GLM,
    compactorModelExplicit: false,
    strategy: "prompting-h",
    budget: null,
    repetitions: 1,
    rulePresent: true,
    ruleChannel: "home",
    ruleChannelExplicit: false,
    filler: false,
    attack: "none",
    defense: "none",
    cohort: "cccb-v1",
    ...over,
  };
}

async function run(c: Configuration, cases: string[]): Promise<ResultRow[]> {
  const eps = planEpisodes(c, rows, cfg).filter((e) => cases.includes(e.caseId));
  return executeEpisodes(eps, {
    cfg,
    apiKey: "fake",
    resultsDir: mkdtempSync(join(tmpdir(), "arcbench-engine-")),
    rows: new Map(rows.map((r) => [r.id, r])),
    deps: { summarizerCall: makeSummarizerCall(cfg, "fake") },
  });
}

function firstRow(path: string, keep: (r: Record<string, unknown>) => boolean = () => true): Record<string, unknown> {
  const rows = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  return rows.find(keep)!;
}

describe.skipIf(!HAVE_ORIGINAL_RESULTS)("row shape matches the study the cohort reproduces", () => {
  it("v1.1-ladder rows read field-for-field like the ladder's", async () => {
    const [row] = await run(config({ cohort: "v1.1-ladder", ruleChannel: "home-paired", filler: true, attack: "legacy" }), ["pname"]);
    const ref = firstRow("results/rq1/s1-baseline/z-ai-glm-5-3-flash/results.jsonl");
    expect(Object.keys(row!)).toEqual(Object.keys(ref));
    expect(Object.keys((row as { provenance: object }).provenance)).toEqual(Object.keys(ref["provenance"] as object));
    expect(row!.valid).toBe(true);
  });

  it("v1.3-newcase-v1.2strategies rows match the strategy study's", async () => {
    const [row] = await run(config({ cohort: "v1.3-newcase-v1.2strategies", strategy: "none", attack: "legacy" }), ["email"]);
    const ref = firstRow("results/rq2/s3-strategy/z-ai-glm-5-3-flash/results.jsonl");
    expect(Object.keys(row!)).toEqual(Object.keys(ref));
    expect(Object.keys((row as { spec: object }).spec)).toEqual(Object.keys(ref["spec"] as object));
    expect((row as { provenance: unknown }).provenance).toEqual(ref["provenance"]);
  });

  it("v1.4-token-constraint rows match the budget study's, compaction block included", async () => {
    const [row] = await run(config({ cohort: "v1.4-token-constraint", strategy: "pi-native-cut", filler: true, budget: 200 }), ["email"]);
    const ref = firstRow("results/rq2/s4-budget/z-ai-glm-5-3-flash/results.jsonl");
    expect(Object.keys(row!)).toEqual(Object.keys(ref));
    expect(Object.keys((row as { spec: object }).spec)).toEqual(Object.keys(ref["spec"] as object));
    expect(Object.keys((row as { compaction: object }).compaction)).toEqual(Object.keys(ref["compaction"] as object));
    expect((row as { runId: string }).runId).toBe(ref["runId"]);
  });

  it("v1.6-ipi-attack-defense rows match the attack/defense study's", async () => {
    const [row] = await run(config({ cohort: "v1.6-ipi-attack-defense", attack: "none", defense: "none" }), ["email"]);
    const ref = firstRow("results/rq3/s6-attack/z-ai-glm-5-3-flash/results.jsonl", (r) => (r["spec"] as { contextHandling: string }).contextHandling === "compacted");
    expect(Object.keys(row!)).toEqual(Object.keys(ref));
    expect(JSON.stringify((row as { spec: object }).spec)).toBe(JSON.stringify(ref["spec"]));
    expect((row as { runId: string }).runId).toBe(ref["runId"]);
  });
});

describe("new configurations run end to end", () => {
  it("cccb-v1: ACON-UT under a budget, a published attack and a defense", async () => {
    const out = await run(config({ strategy: "acon-ut", budget: 300, filler: true, attack: "escape", defense: "sandwich" }), ["email", "pname"]);
    expect(out.every((r) => r.valid)).toBe(true);
    const r = out[0] as unknown as { spec: Record<string, unknown>; compaction: { budget: unknown } };
    expect(r.spec["defense"]).toBe("sandwich");
    expect(r.compaction.budget).not.toBeNull();
  });

  it("cccb-v1: a separate compactor model reaches the compactor call and provenance", async () => {
    const before = fake.requests.length;
    const out = await run(config({ compactorModel: "deepseek/deepseek-v4-flash-0731", compactorModelExplicit: true }), ["email"]);
    const bodies = fake.requests.slice(before).map((q) => JSON.parse(q.body) as { model: string; tools?: unknown[] });
    expect(bodies.some((b) => b.model === "deepseek/deepseek-v4-flash-0731" && (b.tools ?? []).length === 0)).toBe(true);
    expect(bodies.filter((b) => (b.tools ?? []).length > 0).every((b) => b.model === GLM)).toBe(true);
    expect((out[0] as { provenance: { summarizerModel: string } }).provenance.summarizerModel).toBe("deepseek/deepseek-v4-flash-0731");
  });

  it("c2/c4 are placed by a live agent call and recorded as satisfied", async () => {
    const out = await run(config({ ruleChannel: "all" }), ["email"]);
    expect(out).toHaveLength(4);
    expect(out.every((r) => r.valid)).toBe(true);
  });

});
