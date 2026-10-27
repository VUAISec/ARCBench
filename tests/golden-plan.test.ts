/**
 * Equivalence level 1: every study plans exactly the episodes whose rows it holds.
 *
 * For each study in src/rq/studies.ts, every (non-borrowed) command is planned and the episodes are
 * compared, run id by run id, with the rows under results/<rqN>/<sM-name>/ (see results/MANIFEST.sha256):
 *
 *   - the set of run ids is identical, with the study's row count;
 *   - v1.2-shape rows: spec (key order included), sourceTranscriptId, pairKey, configCohort, taskId,
 *     model and repetition are identical;
 *   - v1.1-shape rows (S1, S5): the planned run equals the manifest line the ladder sweep wrote;
 *   - every run is stored once, and a borrowed cell is not in the borrowing study's own rows.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import { planEpisodes, type Episode } from "../src/plan/episodes.ts";
import { parseArgs } from "../src/cli/args.ts";
import { FACTOR_FLAGS, configurationFromFlags } from "../src/cli/configuration-flags.ts";
import { STUDIES, type Flags, type Study } from "../src/rq/studies.ts";
import { HAVE_ORIGINAL_RESULTS, MISSING_ORIGINAL_REASON, ORIGINAL_RESULTS } from "./helpers/original-results.ts";

const cfg = loadConfig();
const cases = loadTaskRows("data/rule-loss/cases.jsonl");

type Row = Record<string, unknown>;

function readJsonl(path: string): Row[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Row);
}

/** Every results.jsonl under a copied study directory (flat or per model). */
function copiedRows(dir: string): Row[] {
  const out: Row[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !["analysis", "manifests", "agent-behavior"].includes(e.name)) walk(join(d, e.name));
      else if (e.name === "results.jsonl") out.push(...readJsonl(join(d, e.name)));
    }
  };
  walk(dir);
  return out;
}

export function planFlags(flags: Flags): Episode[] {
  const argv = Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v]);
  const parsed = parseArgs(argv, FACTOR_FLAGS);
  expect(parsed.violations).toEqual([]);
  const { configuration, violations } = configurationFromFlags(parsed);
  expect(violations).toEqual([]);
  return planEpisodes(configuration!, cases, cfg);
}

const planned = new Map<string, Episode[]>();
for (const study of STUDIES) planned.set(study.id, study.commands.flatMap(planFlags));
const resultsDir = (study: Study) => join(ORIGINAL_RESULTS, study.dir);
const WITH_RUNS = STUDIES.filter((s) => s.commands.length > 0);

describe.skipIf(!HAVE_ORIGINAL_RESULTS).each(WITH_RUNS)("$id", (study) => {
  const episodes = planned.get(study.id)!;
  const byId = new Map(episodes.map((e) => [e.runId, e]));
  const primary = HAVE_ORIGINAL_RESULTS ? copiedRows(resultsDir(study)) : [];

  it("plans the same run ids as the study's rows, and as many", () => {
    expect(new Set(byId.keys()).size).toBe(episodes.length);
    const recorded = new Set(primary.map((r) => String(r["runId"])));
    expect(recorded.size).toBe(primary.length);
    expect([...byId.keys()].sort()).toEqual([...recorded].sort());
  });

  it("names every episode exactly as the recorded row does", () => {
    const mismatches: string[] = [];
    for (const row of primary) {
      const e = byId.get(String(row["runId"]))!;
      if (e.rowShape === "v1.2") {
        const want = {
          spec: JSON.stringify(row["spec"]),
          sourceTranscriptId: row["sourceTranscriptId"],
          pairKey: row["pairKey"],
          configCohort: row["configCohort"],
          taskId: row["taskId"],
          model: row["model"],
          repetition: row["repetition"],
        };
        const got = {
          spec: JSON.stringify(e.spec),
          sourceTranscriptId: e.sourceTranscriptId,
          pairKey: e.pairKey,
          configCohort: e.configCohort,
          taskId: e.caseId,
          model: e.configuration.agentModel,
          repetition: e.repetition,
        };
        if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${e.runId}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      } else {
        const want = { pairKey: row["pairKey"], condition: row["condition"], taskOrSampleId: row["taskOrSampleId"], compactorBackend: row["compactorBackend"], policyChannel: row["policyChannel"], haystackArm: row["haystackArm"] };
        const p = e.plannedV11!;
        const got = { pairKey: p.pairKey, condition: p.condition, taskOrSampleId: p.taskOrSampleId, compactorBackend: p.compactorBackend, policyChannel: p.policyChannel, haystackArm: p.haystackArm };
        if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${e.runId}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});

describe.skipIf(!HAVE_ORIGINAL_RESULTS)("v1.1 ladder planned runs equal the manifests the sweep wrote", () => {
  it.each(["s1-baseline", "s5-injection"])("%s", (id) => {
    const study = STUDIES.find((s) => s.id === id)!;
    const byId = new Map(planned.get(id)!.map((e) => [e.runId, e]));
    const manifestDir = join(resultsDir(study), "manifests");
    const files = readdirSync(manifestDir).filter((f) => f.endsWith(".jsonl"));
    let compared = 0;
    for (const f of files) {
      for (const line of readJsonl(join(manifestDir, f))) {
        const e = byId.get(String(line["runId"]));
        expect(e, String(line["runId"])).toBeDefined();
        expect(JSON.stringify(e!.plannedV11)).toBe(JSON.stringify(line));
        compared++;
      }
    }
    expect(compared).toBe(byId.size);
  });
});

describe.skipIf(!HAVE_ORIGINAL_RESULTS)("every run is stored once", () => {
  it("no run id appears in two study directories", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const study of WITH_RUNS) {
      for (const r of copiedRows(resultsDir(study))) {
        const id = String(r["runId"]);
        if (seen.has(id)) dupes.push(`${id}: ${seen.get(id)} and ${study.id}`);
        seen.set(id, study.id);
      }
    }
    expect(dupes.slice(0, 5)).toEqual([]);
  });
});

describe("borrowed cells are the ones a study does not run itself", () => {
  it.skipIf(!HAVE_ORIGINAL_RESULTS)("none of a study's borrowed run ids appear in its own rows", () => {
    for (const study of WITH_RUNS) {
      if (study.borrowed.length === 0) continue;
      const recorded = new Set(copiedRows(resultsDir(study)).map((r) => String(r["runId"])));
      const borrowed = study.borrowed.flatMap(planFlags);
      expect(borrowed.filter((e) => recorded.has(e.runId)).map((e) => e.runId)).toEqual([]);
    }
  });

  it.skipIf(!HAVE_ORIGINAL_RESULTS).each(["s2-channel", "s5-injection", "s7-defense"])(
    "%s: every borrowed run is a row of the study it reads",
    (id) => {
      const study = STUDIES.find((s) => s.id === id)!;
      const source = new Set(study.reads.flatMap((dir) => copiedRows(join(ORIGINAL_RESULTS, dir))).map((r) => String(r["runId"])));
      const borrowed = study.borrowed.flatMap(planFlags);
      expect(borrowed.length).toBeGreaterThan(0);
      expect(borrowed.filter((e) => !source.has(e.runId)).map((e) => e.runId)).toEqual([]);
    },
  );

  it("S3's borrowed cells are exactly S1's and S5's G1/G2/G3/G5 on the home channel", () => {
    const study = STUDIES.find((s) => s.id === "s3-strategy")!;
    const cells = new Set(study.borrowed.map((f) => `${f["compaction_strategies"]}|${f["filler"]}|${f["injection_attack_method"]}`));
    expect([...cells].sort()).toEqual(["none|no|none", "prompting-h|no|none", "prompting-h|yes|legacy", "prompting-h|yes|none"]);
  });
});

it.skipIf(HAVE_ORIGINAL_RESULTS)(MISSING_ORIGINAL_REASON, () => {});

it.skipIf(!HAVE_ORIGINAL_RESULTS)("the study rows the tests read are present", () => {
  for (const study of WITH_RUNS) expect(existsSync(resultsDir(study)), resultsDir(study)).toBe(true);
});
