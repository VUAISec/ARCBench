/**
 * Rule state judge: label each compacted run of a study as retained / partially retained / absent.
 *
 * The panel, rubric and aggregation are the benchmark's (`src/judge/`): GPT-6-Luna-Pro,
 * Qwen3.8-Flash and Claude Sonnet 4.6 at temperature 0 with reasoning disabled; the final label is
 * the panel median plus the keyword check. Selective compactors (FIFO, LRU) write no summary and are
 * labeled deterministically from the recorded selection, without a model call.
 *
 *   npx tsx scripts/judges/rule-state/judge.ts --study runs/rq1/s1-baseline [--strategies a,b] [--attacks a,b] [--limit N]
 *
 * --study is a study directory with <model>/results.jsonl (a re-run under runs/, or results/).
 * Compacted, valid, rule-present runs are staged in a temporary directory (ladder rows of S1/S5 use
 * the older v1.1 row shape and are mapped onto the fields the judge reads), judged there, and the
 * labels are merged into <study>/<model>/judgments.jsonl (judgments-deterministic.jsonl for the
 * selective compactors). Labels already in those files are reused, not re-billed. The paper labels
 * S4's Hermes and Pi runs (--strategies prompting-h,pi-native-cut) and S6's no-attack and escape runs
 * (--attacks none,escape).
 *
 * Needs OPENROUTER_API_KEY.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../../src/config/config.ts";
import { runJudgePass } from "../../../src/judge/run.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CASES = join(REPO_ROOT, "data/rule-loss/cases.jsonl");
const LADDER_COMPACTED = ["G2", "G3", "G4", "G5"];

type Row = Record<string, any>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJsonl(path: string): Array<{ line: string; row: Row }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((line) => ({ line, row: JSON.parse(line) as Row }));
}

/** The study's compacted runs to judge, as lines in the shape the judge reads, by model directory. */
function select(study: string): Map<string, string[]> {
  const strategies = arg("strategies") === undefined ? null : new Set(arg("strategies")!.split(","));
  const attacks = arg("attacks") === undefined ? null : new Set(arg("attacks")!.split(","));
  const out = new Map<string, string[]>();
  for (const dir of readdirSync(study, { withFileTypes: true })) {
    const path = join(study, dir.name, "results.jsonl");
    if (!dir.isDirectory() || !existsSync(path)) continue;
    const lines: string[] = [];
    for (const { line, row } of readJsonl(path)) {
      if (row["valid"] !== true) continue;
      if ("condition" in row) {
        // v1.1 ladder row (S1, S5): rule-present compacted conditions only.
        if (!LADDER_COMPACTED.includes(String(row["condition"])) || !row["compaction"]?.["summary"]) continue;
        lines.push(JSON.stringify({
          runId: row["runId"],
          model: row["provenance"]["agentModel"],
          taskId: row["taskOrSampleId"],
          valid: true,
          spec: { compactionStrategy: row["compaction"]["strategy"], condition: row["condition"], policyChannel: row["policyChannel"] },
          compaction: { ...row["compaction"], selection: null },
          ladder: row,
        }));
        continue;
      }
      const spec = row["spec"] ?? {};
      if (spec["contextHandling"] !== "compacted" || spec["policyPresent"] === false) continue;
      if (strategies && !strategies.has(String(spec["compactionStrategy"]))) continue;
      if (attacks && !attacks.has(String(spec["attackTechnique"] ?? "none"))) continue;
      lines.push(line);
    }
    if (lines.length > 0) out.set(dir.name, lines);
  }
  return out;
}

const studyArg = arg("study");
if (!studyArg) throw new Error("give --study <study directory>, e.g. --study runs/rq1/s1-baseline");
const study = isAbsolute(studyArg) ? studyArg : resolve(process.cwd(), studyArg);
const key = process.env["OPENROUTER_API_KEY"];
if (!key) throw new Error("OPENROUTER_API_KEY is not set.");
const limit = arg("limit") === undefined ? undefined : Number(arg("limit"));

const staging = mkdtempSync(join(tmpdir(), "arcbench-rule-state-"));
const selected = select(study);
let staged = 0;
for (const [modelDir, lines] of selected) {
  mkdirSync(join(staging, modelDir), { recursive: true });
  writeFileSync(join(staging, modelDir, "results.jsonl"), lines.join("\n") + "\n", "utf8");
  // Seed the cache with the study's existing labels, so they are reused rather than re-billed.
  const cached = join(study, modelDir, "judgments.jsonl");
  if (existsSync(cached)) writeFileSync(join(staging, modelDir, "judgments.jsonl"), readFileSync(cached, "utf8"), "utf8");
  staged += lines.length;
}
console.log(`staged ${staged} compacted runs of ${study}`);

const cfg = loadConfig();
const res = await runJudgePass({
  sweepDir: staging,
  casesPath: CASES,
  opts: {
    apiKey: key,
    baseUrl: cfg.openrouterBaseUrl,
    requestTimeoutMs: cfg.requestTimeoutMs,
    maxTransientRetries: 3,
    retryBaseDelayMs: cfg.retryBaseDelayMs,
    maxParseRetries: 1,
  },
  concurrency: 6,
  ...(limit === undefined ? {} : { limit }),
  onProgress: (done, total, cost) => {
    if (done % 100 === 0 || done === total) console.log(`  ${done}/${total}  $${cost.toFixed(2)}`);
  },
});
console.log(`written=${res.written} reused=${res.reused} not_measured=${res.failed} cost=$${res.costUsd.toFixed(2)}`);

// Merge the staged labels back: one line per run id, the newest label winning.
for (const modelDir of selected.keys()) {
  for (const name of ["judgments.jsonl", "judgments-deterministic.jsonl"]) {
    const fresh = readJsonl(join(staging, modelDir, name));
    if (fresh.length === 0) continue;
    const target = join(study, modelDir, name);
    const byRun = new Map<string, string>();
    for (const { line, row } of [...readJsonl(target), ...fresh]) byRun.set(String(row["runId"]), line);
    writeFileSync(target, [...byRun.values()].join("\n") + "\n", "utf8");
    console.log(`  ${target}: ${byRun.size} labels`);
  }
}
