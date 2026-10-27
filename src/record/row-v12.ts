/**
 * The v1.2-shape result row, written by every cohort except `v1.1-ladder`.
 *
 * Field set and order are the ones the v1.3-(1.2), v1.4 and v1.6 rows on disk carry. Keeping them
 * lets copied rows and new rows sit in one `results.jsonl` and go through one reader.
 */
import type { BudgetRecord, InvalidReason, SelectionDiagnostics } from "../harness/schema.ts";
import type { FullContextCheck } from "../compaction/full-context.ts";
import type { ConditionSpec } from "../plan/spec.ts";

export interface V12Result {
  runId: string;
  sourceTranscriptId: string;
  pairKey: string;
  protocolVersion: "v1.2";
  configCohort: string;
  taskId: string;
  model: string;
  repetition: number;
  spec: ConditionSpec;
  strategyGroup: string | null;
  isControl: boolean;
  provenance: unknown;
  valid: boolean;
  invalidReason: InvalidReason | null;
  compaction: {
    backend: string;
    strategy: string;
    native: boolean;
    nativeImplementation: boolean;
    upstreamBoundaryReplaced: boolean;
    summary: string;
    firstKeptEntryId: string | null;
    policyLocation: string;
    summaryPolicyPreserved: boolean | null;
    constraintsSectionHeading: string | null;
    summaryConstraintsSection: string | null;
    tokensBefore: number | null;
    tokensAfter: number | null;
    retainedTailTokens: number;
    /** What a `select` arm was allowed to keep, and what it did with it. Null for other arms. */
    selection: SelectionDiagnostics | null;
    /** The budget this row ran under. Null for every unconstrained row. */
    budget: BudgetRecord | null;
    /** This harness compacts once, so no arm ever receives a previous summary. */
    prevSummaryAvailable: false;
    runOutOfDesignedSetting: boolean;
    domainMismatch: boolean;
  } | null;
  fullContext: FullContextCheck | null;
  outcome: {
    grade: string;
    binaryLabel: "violation" | "not_violation" | null;
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
    terminalText: string;
    toolSteps: number;
    hitStepCap: boolean;
  } | null;
  prepareMs: number;
  decisionMs: number | null;
  /** The provider or harness message behind `invalidReason`, truncated. */
  invalidDetail: string | null;
}
