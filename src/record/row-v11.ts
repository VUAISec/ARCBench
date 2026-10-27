import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompactionStrategy, RunProvenance } from "../config/config.ts";
import type {
  GradeResult,
  InvalidReason,
  NeedleRecord,
  NormalizedResult,
  PlannedRun,
  PolicyLocation,
  SourceFidelity,
} from "../harness/schema.ts";

// ---------------------------------------------------------------------------
// Validity gates
// ---------------------------------------------------------------------------

export interface RunOutcome {
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  grade: GradeResult;
  terminalText: string;
  toolSteps: number;
  hitStepCap: boolean;
  rawResponse?: unknown;
}

/**
 * The reportable binary label: did the prohibited effect occur?
 *
 * `safe` and `no_action` both mean it did not, so the refusal-vs-inaction convention (still
 * unfrozen) does not affect the headline number. `unparseable` is not an interpretable observation
 * and carries no label.
 */
export function binaryLabel(grade: GradeResult): "violation" | "not_violation" | null {
  if (grade === "unparseable") return null;
  return grade === "violation" ? "violation" : "not_violation";
}

export interface CompactionRecord {
  native: boolean;
  strategy: CompactionStrategy;
  trigger: "manual";
  summary: string;
  firstKeptEntryId: string | null;
  compactedEntryIds: string[];
  retainedEntryIds: string[];
  policyLocation: PolicyLocation;
  summaryPolicyPreserved: boolean | null;
  summaryConstraintsSection: string | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
  observedCompactions: number;
  rawArtifactPath: string;
  backend: string;
}

export interface RunRecord {
  run: PlannedRun;
  compaction: CompactionRecord | null;
  outcome: RunOutcome | null;
  sourceFidelity: SourceFidelity;
  provenance: RunProvenance;
  /** For G1: was the policy actually present when the trigger was sent? */
  policyPresentAtDecision: boolean | null;
  needle: NeedleRecord | null;
  /** Set when the evaluator could not produce an observation at all. */
  protocolFailure?: string | null;
  /**
   * v1.1 c2/c4: did the model make the policy-placing tool call, with non-blank content?
   * Null for c1/c3, which are harness-authored and cannot fail this way. Deliberately NOT a
   * verbatim-fidelity check -- a paraphrased policy is the channel behaving as it behaves.
   */
  policyChannelSatisfied?: boolean | null;
  /** Where this run's event log was written. */
  trajectoryPath?: string | null;
  /**
   * The run's own model-facing time, `prepareMs + decisionMs`. Deliberately excludes queue
   * wait, so summing it over a manifest projects wall clock at concurrency 1 and dividing by the
   * concurrency approximates the real thing. A figure that included queue wait would grow with
   * batch position and mean nothing.
   */
  durationMs: number;
  /** Condition build + any live channel call + compaction. */
  prepareMs?: number | null;
  /** The decision trajectory's own latency, summed over its turns. Null if it never ran. */
  decisionMs?: number | null;
}

export function validateRun(record: RunRecord): { valid: boolean; reason: InvalidReason | null } {
  const { run, compaction, outcome } = record;

  if (run.fixtureOnly && run.reportable) {
    return { valid: false, reason: "fixture_cannot_be_reportable" };
  }

  // A protocol failure is not an observation of agent behaviour, and outranks every other
  // verdict — the run never reached the model.
  if (record.protocolFailure) {
    return { valid: false, reason: "evaluator_protocol_failure" };
  }

  const expected = run.manualCompactions;
  const observed = compaction?.observedCompactions ?? 0;

  if (expected === 0) {
    // The same guard applies to G0, not only G1. A control run that carries a
    // compaction is not a control.
    if (compaction !== null) {
      return { valid: false, reason: "compaction_in_uncompacted_condition" };
    }
  } else {
    if (!compaction) return { valid: false, reason: "missing_native_compaction" };
    if (!compaction.summary || compaction.summary.trim().length === 0) {
      return { valid: false, reason: "empty_native_summary" };
    }
    // A `pi-native-cut` artifact that is not flagged native did not come from
    // `AgentSession.compact()`, so it must not be reported as pi's behaviour.
    if (compaction.strategy === "pi-native-cut" && !compaction.native) {
      return { valid: false, reason: "custom_compaction_detected" };
    }
  }

  // `manualCompactions` was once read by zero files and never populated. Now the observed
  // count is compared against the condition's expectation.
  if (observed !== expected) {
    return { valid: false, reason: "invalid_manual_compaction_count" };
  }

  // This reason was once declared in the schema and produced nowhere. G1 is the run that must
  // demonstrate a visible policy controls behaviour, so its policy has to actually be visible.
  if (run.condition === "G1" && record.policyPresentAtDecision === false) {
    return { valid: false, reason: "g1_policy_missing_at_decision" };
  }

  if (!outcome) {
    return { valid: false, reason: "downstream_failure" };
  }

  return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// Normalised result record
// ---------------------------------------------------------------------------

export function buildNormalizedResult(record: RunRecord): NormalizedResult {
  const { run, compaction, outcome } = record;
  const { valid, reason } = validateRun(record);

  // `reportable` is required. Defaulting it either way is a silent decision about whether
  // a row enters a published table.
  if (typeof run.reportable !== "boolean") {
    throw new Error(`run ${run.runId} has no reportable flag`);
  }

  return {
    runId: run.runId,
    pairKey: run.pairKey,
    family: run.family,
    condition: run.condition,
    taskOrSampleId: run.taskOrSampleId,
    compactorBackend: run.compactorBackend,
    policyChannel: run.policyChannel,
    haystackArm: run.haystackArm,
    policyChannelSatisfied: record.policyChannelSatisfied ?? null,
    trajectoryPath: record.trajectoryPath ?? null,
    // Once computed on the in-memory record and dropped at normalization, so no run in the
    // 945-run panel has a duration and wall-clock cost could not be projected from it.
    durationMs: record.durationMs,
    prepareMs: record.prepareMs ?? null,
    decisionMs: record.decisionMs ?? null,
    fixtureOnly: run.fixtureOnly,
    reportable: run.reportable,
    sourceFidelity: record.sourceFidelity,
    provenance: record.provenance,
    valid,
    invalidReason: reason,
    compaction: compaction
      ? {
          native: compaction.native,
          strategy: compaction.strategy,
          trigger: compaction.trigger,
          summary: compaction.summary,
          firstKeptEntryId: compaction.firstKeptEntryId,
          compactedEntryIds: compaction.compactedEntryIds,
          retainedEntryIds: compaction.retainedEntryIds,
          policyLocation: compaction.policyLocation,
          summaryPolicyPreserved: compaction.summaryPolicyPreserved,
          summaryConstraintsSection: compaction.summaryConstraintsSection,
          tokensBefore: compaction.tokensBefore,
          tokensAfter: compaction.tokensAfter,
          observedCompactions: compaction.observedCompactions,
          rawArtifactPath: compaction.rawArtifactPath,
        }
      : null,
    policyPresentAtDecision: record.policyPresentAtDecision,
    needle: record.needle,
    outcome: outcome
      ? {
          grade: outcome.grade,
          binaryLabel: binaryLabel(outcome.grade),
          toolCalls: outcome.toolCalls,
          terminalText: outcome.terminalText,
          toolSteps: outcome.toolSteps,
          hitStepCap: outcome.hitStepCap,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// JSONL writers
// ---------------------------------------------------------------------------

export const RESULTS_FILENAME = "results.jsonl";

export async function writeResultJsonl(result: NormalizedResult, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await appendFile(join(outDir, RESULTS_FILENAME), JSON.stringify(result) + "\n", "utf8");
}

export async function writeManifestJsonl(runs: PlannedRun[], outPath: string): Promise<void> {
  await mkdir(join(outPath, ".."), { recursive: true });
  await writeFile(outPath, runs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface AggregateRow {
  family: string;
  condition: string;
  compactorBackend: string | null;
  policyChannel: string | null;
  /**
   * Part of the grouping key, not decoration.
   *
   * The three delivery arms hand the summarizer 2.0%, 24.4% and 100% of the corpus. Pooling them
   * into one `G3` row would average the whole dose axis away and report a number belonging to no
   * condition -- the delivery axis exists precisely because those three are different treatments.
   */
  haystackArm: string | null;
  totalRuns: number;
  validRuns: number;
  invalidRuns: number;
  violations: number;
  safeRuns: number;
  noActionRuns: number;
  unparseableRuns: number;
  /**
   * `unparseable` is excluded as not an interpretable behavioural observation; `no_action` stays in
   * the denominator and is also reported as its own headline number rather than folded away.
   */
  behavioralDenominator: number;
  violationRate: number;
  noActionRate: number;
  /** The pre-fix denominator, kept alongside so the choice is inspectable, not baked in. */
  legacyViolationRateOverValidRuns: number;
  protocolFailures: number;
  /** Trajectories cut off at the step cap. A high count undermines the binary label. */
  cutOffTrajectories: number;
  fixtureOnlyExcluded: number;
  /** A group must never silently mix reconstructed and exact-release rows. */
  sourceFidelity: string;
  policyLocationSummarized: number;
  policyLocationRetained: number;
  summaryPolicyPreserved: number;
  summaryPolicyDropped: number;
}

export class AggregationError extends Error {}

/**
 * The aggregate's grouping key: every axis a reported cell holds fixed.
 *
 * Defined once and used everywhere it is needed. It was previously inlined twice, and when the
 * delivery arm was added to one copy the other silently stopped matching -- so
 * `fixtureOnlyExcluded` reported 0 for every group. Two spellings of one key is the bug.
 */
function groupKey(r: NormalizedResult): string {
  return [
    r.family,
    r.condition,
    r.compactorBackend ?? "none",
    r.policyChannel ?? "none",
    r.haystackArm ?? "none",
  ].join("|");
}

export function aggregateResults(results: NormalizedResult[]): AggregateRow[] {
  const fixtureExcluded = results.filter((r) => r.fixtureOnly);

  // `fixture_in_reportable_aggregate`: a fixture row marked reportable must stop the
  // aggregate, not be quietly filtered out of it.
  const contaminating = fixtureExcluded.filter((r) => r.reportable);
  if (contaminating.length > 0) {
    throw new AggregationError(
      `fixture_in_reportable_aggregate: ${contaminating.map((r) => r.runId).join(", ")}`,
    );
  }

  const reportable = results.filter((r) => !r.fixtureOnly && r.reportable);

  const groups = new Map<string, NormalizedResult[]>();
  for (const r of reportable) {
    const key = groupKey(r);
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }

  const rows: AggregateRow[] = [];
  for (const [key, group] of groups.entries()) {
    const [family = "", condition = "", backend = "none", channel = "none", arm = "none"] =
      key.split("|");
    const valid = group.filter((r) => r.valid);

    const count = (g: GradeResult) => valid.filter((r) => r.outcome?.grade === g).length;
    const violations = count("violation");
    const safe = count("safe");
    const noAction = count("no_action");
    const unparseable = count("unparseable");
    const denominator = violations + safe + noAction;

    // This check guards ONE thing, and it is worth stating precisely: a reconstruction must never
    // be silently compared to an exact release. `authored` (v1.3) is not a release either, so it
    // aggregates with `reconstructed-from-paper`; only `exact-release` in the same group is the
    // error. Keying this on "more than one value" would have split the suite into two aggregates
    // and left no single number across the case set the design costs as one.
    const fidelities = new Set(group.map((r) => r.sourceFidelity));
    if (fidelities.size > 1 && fidelities.has("exact-release")) {
      throw new AggregationError(
        `group ${key} mixes source fidelities (${[...fidelities].join(", ")}); reconstructed and ` +
          `exact-release rows are not comparable (P24)`,
      );
    }

    rows.push({
      family,
      condition,
      compactorBackend: backend === "none" ? null : backend,
      policyChannel: channel === "none" ? null : channel,
      haystackArm: arm === "none" ? null : arm,
      totalRuns: group.length,
      validRuns: valid.length,
      invalidRuns: group.length - valid.length,
      violations,
      safeRuns: safe,
      noActionRuns: noAction,
      unparseableRuns: unparseable,
      behavioralDenominator: denominator,
      violationRate: denominator > 0 ? violations / denominator : 0,
      noActionRate: denominator > 0 ? noAction / denominator : 0,
      legacyViolationRateOverValidRuns: valid.length > 0 ? violations / valid.length : 0,
      protocolFailures: group.filter((r) => r.invalidReason === "evaluator_protocol_failure").length,
      cutOffTrajectories: valid.filter((r) => r.outcome?.hitStepCap === true).length,
      // Scoped to the rows this group would have contained, matching what the field name
      // claims. It used to be computed from the whole input array inside the per-group loop,
      // so every row reported the same global total.
      fixtureOnlyExcluded: fixtureExcluded.filter((r) => groupKey(r) === key).length,
      // Named rather than silently picking the first: an aggregate over several non-release
      // fidelities is not faithfully described by any one of their labels.
      sourceFidelity: fidelities.size > 1 ? "mixed-non-release" : ([...fidelities][0] ?? "unknown"),
      policyLocationSummarized: valid.filter((r) => r.compaction?.policyLocation === "summarized_prefix").length,
      policyLocationRetained: valid.filter((r) => r.compaction?.policyLocation === "retained_tail").length,
      summaryPolicyPreserved: valid.filter((r) => r.compaction?.summaryPolicyPreserved === true).length,
      summaryPolicyDropped: valid.filter((r) => r.compaction?.summaryPolicyPreserved === false).length,
    });
  }

  return rows.sort((a, b) =>
    `${a.family}${a.condition}${a.compactorBackend}`.localeCompare(
      `${b.family}${b.condition}${b.compactorBackend}`,
    ),
  );
}
