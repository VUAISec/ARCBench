import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { JudgeTask, JudgmentRow } from "./schema.ts";

/** The arms that produce a summary, and therefore the rows a judge can score. */
export const GENERATIVE_ARMS: ReadonlySet<string> = new Set([
  "acon-ut",
  "acon-utco",
  "baseline-structured-summary",
  "pi-native-cut",
  "pi-native-policy-preserving",
  "trace-optimized",
  "prompting-h",
]);

export function loadPolicies(casesPath: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(casesPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as { id: string; policy: string };
    out.set(row.id, row.policy);
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Split the sweep into rows a judge must score and rows already decided by the artifacts.
 *
 * Selection arms never produce a summary: the policy entry either survived the eviction verbatim
 * or it did not, and `selection.policyOutcome` records which. Spending a judge call on that would
 * add noise to a question the harness answered exactly. They are reported on their own
 * denominator, because the lexical metric is null for every one of them and a pooled rate would
 * mix two populations.
 */
export function loadSweep(args: {
  sweepDir: string;
  policies: Map<string, string>;
}): { judged: JudgeTask[]; deterministic: JudgmentRow[]; skipped: number } {
  const judged: JudgeTask[] = [];
  const deterministic: JudgmentRow[] = [];
  let skipped = 0;

  const modelDirs = readdirSync(args.sweepDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "analysis")
    .map((d) => d.name)
    .sort();

  for (const modelDir of modelDirs) {
    const path = join(args.sweepDir, modelDir, "results.jsonl");
    if (!existsSync(path)) continue;

    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line) as Record<string, any>;
      const compaction = row["compaction"] as Record<string, any> | null;
      if (compaction === null || compaction === undefined) continue;
      if (row["valid"] !== true) { skipped++; continue; }

      const arm = String(row["spec"]?.["compactionStrategy"] ?? "");
      const taskId = String(row["taskId"]);
      const policy = args.policies.get(taskId);
      if (policy === undefined) {
        throw new Error(`no policy for taskId "${taskId}" (row ${String(row["runId"])})`);
      }

      const selection = compaction["selection"] as Record<string, any> | null;
      if (selection !== null && selection !== undefined) {
        const kept = selection["policyOutcome"] === "kept";
        deterministic.push({
          runId: String(row["runId"]),
          model: String(row["model"]),
          modelDir,
          arm,
          taskId,
          source: kept ? "tail_credit" : "selection",
          calls: [],
          median: null,
          keywordCrossCheck: null,
          tier: kept ? "retained" : "absent",
          lexical: null,
          lexicalSectionParsed: false,
          provenance: { promptSha256: "", panel: [], temperature: 0, judgedAt: nowIso() },
        });
        continue;
      }

      if (!GENERATIVE_ARMS.has(arm)) continue;

      // Tail credit: the policy survived the cut verbatim, so no judgement is required.
      if (compaction["policyLocation"] === "retained_tail") {
        deterministic.push({
          runId: String(row["runId"]),
          model: String(row["model"]),
          modelDir,
          arm,
          taskId,
          source: "tail_credit",
          calls: [],
          median: null,
          keywordCrossCheck: null,
          tier: "retained",
          lexical: (compaction["summaryPolicyPreserved"] ?? null) as boolean | null,
          lexicalSectionParsed: compaction["summaryConstraintsSection"] !== null,
          provenance: { promptSha256: "", panel: [], temperature: 0, judgedAt: nowIso() },
        });
        continue;
      }

      judged.push({
        runId: String(row["runId"]),
        model: String(row["model"]),
        modelDir,
        arm,
        taskId,
        summary: String(compaction["summary"] ?? ""),
        policy,
        lexical: (compaction["summaryPolicyPreserved"] ?? null) as boolean | null,
        lexicalSectionParsed: compaction["summaryConstraintsSection"] !== null,
      });
    }
  }
  return { judged, deterministic, skipped };
}
