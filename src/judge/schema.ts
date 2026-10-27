/**
 * Types for the three-judge retention metric.
 *
 * The one invariant worth stating here: `not_measured` is not `absent`. Scoring a row we could not
 * measure as a retention failure is exactly the defect this metric replaces, so the tier union
 * keeps them apart and `aggregate.ts` never collapses them.
 */

export type JudgeLabel = "present" | "partially_stated" | "absent";

/**
 * `keyword_rejected` is an addition to the four-tier scheme. It exists so that
 * "the judges said present and the keyword cross-check disagreed" is distinguishable in the
 * artifact from "the judges said absent". Both are not-retained wherever a rate is computed.
 */
export type RetentionTier = "retained" | "partial" | "absent" | "keyword_rejected" | "not_measured";

/** One judge's answer on one row. `label === null` iff the call failed; `failure` says why. */
export interface JudgeCall {
  slug: string;
  label: JudgeLabel | null;
  failure: string | null;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  costUsd: number;
  latencyMs: number;
}

/** A row the judges must score. */
export interface JudgeTask {
  runId: string;
  model: string;
  /**
   * The directory this row was read from, carried rather than derived.
   *
   * Deriving it by slugifying `model` is wrong: `~openai/gpt-luna-latest` slugifies to
   * `-openai-gpt-luna-latest` while the directory is `openai-gpt-luna-latest`. The leading `~`
   * is part of the OpenRouter slug. Caught by the first live smoke.
   */
  modelDir: string;
  arm: string;
  taskId: string;
  summary: string;
  policy: string;
  /** `compaction.summaryPolicyPreserved` — the lexical metric, carried for comparison only. */
  lexical: boolean | null;
  /** False when `summaryConstraintsSection` was null, i.e. the section never parsed. */
  lexicalSectionParsed: boolean;
}

/** One scored row, as written to `judgments.jsonl`. */
export interface JudgmentRow {
  runId: string;
  model: string;
  modelDir: string;
  arm: string;
  taskId: string;
  /** How the tier was reached: judged by the panel, or decided without a model call. */
  source: "judge" | "tail_credit" | "selection";
  calls: JudgeCall[];
  median: JudgeLabel | null;
  keywordCrossCheck: boolean | null;
  tier: RetentionTier;
  lexical: boolean | null;
  lexicalSectionParsed: boolean;
  provenance: {
    promptSha256: string;
    /** The exact panel, in order. A row judged by a different panel is not comparable. */
    panel: string[];
    temperature: number;
    judgedAt: string;
  };
}
