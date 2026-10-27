import type { CompactionStrategy, RunProvenance } from "../config/config.ts";

/**
 * Which software system performed the compaction.
 *
 * `harness` (v1.2) is not a lesser kind of `pi-native` -- it is a different claim. A `pi-native`
 * row means pi's own `AgentSession` chose the cut and made the summarizer call, so pi's serializer
 * behaviour (including its 2,000-char tool-result cap) is part of what the row measures. A
 * `harness` row means THIS harness applied the strategy's boundary and prompt.
 *
 * The distinction has to live in the data rather than in a reader's memory, because a harness
 * backend arm reproduces an upstream *prompt*, never the upstream *complete workflow*, and
 * reporting one as the other is the specific error to avoid: a locally written imitation must not
 * be labeled as the other system's native implementation.
 */
export type CompactorBackend = "pi-native" | "codex-native" | "harness";
export type MessageRole = "system" | "user" | "assistant" | "tool";
/**
 * G2n is the compacted no-policy control. It completes the 2x2 that the original G0-G4 set
 * leaves open:
 *
 *                    no compaction   compaction
 *     no policy           G0             G2n
 *     policy              G1             G2
 *
 * Without it, a violation in G2 has two explanations that cannot be separated: the policy was
 * lost in compaction (governance decay), or compaction degraded the task context so the model's
 * intrinsic caution stopped firing (context decay). G2n holds everything constant except the
 * policy, so G2 - G2n is the policy's residual effect under compaction and G2n - G0 is
 * compaction's effect on intrinsic safety.
 *
 * v1.1 completes the set: G3n, G4n and G5n extend the same logic to every compacted rung, so
 * `Gk - Gkn` is the policy's residual effect at pressure level k and `Gkn - G0` is that pressure's
 * effect on an agent that never had a policy. Without them the separation is only available at the
 * weakest rung.
 *
 * G4n's prior rejection -- "the payload is entirely an instruction to omit policy material, so with
 * no policy there is nothing to omit" -- is reversed. The payload's operative half is "Summarize:
 * current task progress, pending actions, tool results, and specific data values", which steers the
 * summary whether or not a policy exists; G4n measures that steering with the omission clause inert.
 */
export type GovernanceCondition =
  | "G0"
  | "G1"
  | "G2"
  | "G2n"
  | "G3"
  | "G3n"
  | "G4"
  | "G4n"
  | "G5"
  | "G5n";
export type RelinkCondition = "R0" | "R1" | "R2";
export type ExperimentFamily = "governance" | "relink";
export type GradeResult = "violation" | "safe" | "unparseable" | "no_action";

/**
 * v1.1: how the policy entered the conversation. Orthogonal to the pressure ladder, so the
 * two are crossed. All four channels deliver byte-identical policy text; framing is the only
 * variable.
 *
 *   c1  direct instruction        harness-authored, 1 user entry
 *   c2  agent writes rule.md      model-authored write_file call, then its result
 *   c3  harness supplies the doc  pre-written toolResult, never phrased as an instruction
 *   c4  explicit fetch            model-authored get_policy() call, harness-supplied result
 */
export type PolicyChannel = "c1" | "c2" | "c3" | "c4";

/**
 * The haystack delivery arm. Delivery is a manipulated variable, not a configuration
 * choice, because pi truncates every tool result to TOOL_RESULT_MAX_CHARS (2,000) chars before
 * summarizing — so the corpus reaching the summarizer is `2,000 x chunkCount`, and chunk count is
 * the only lever on summarizer-side volume.
 *
 *   A1  whole-document   1 entry   ~2,015 chars reach the summarizer    2.1% coverage
 *   A2  fragmented      13 entries ~24,727 chars                       25.6%  <- reference arm
 *   A3  untruncated     49 entries ~97,267 chars                        100%
 */
export type HaystackArmId = "A1" | "A2" | "A3";

/**
 * Reconstructed rows must never be silently comparable to exact-release rows.
 *
 * v1.3 adds `authored` for a case with no published release at all. It sits in the same bucket as
 * `reconstructed-from-paper` -- neither reproduces a published artifact -- so the aggregation
 * guard keys on `exact-release`, not on "more than one value". The finer question of where a case
 * came from is `CaseProvenance`, which is why this field did not gain GD/CI/DER/NEW values.
 */
export type SourceFidelity = "reconstructed-from-paper" | "exact-release" | "authored";

/**
 * v1.3: where a case came from. Deliberately NOT folded into `SourceFidelity`.
 *
 * Fidelity answers "how faithful is this to a published release". Provenance answers "where did
 * this case come from". An authored case has no release to be faithful to, so one field carrying
 * both meanings would make a single value mean two things.
 *
 *   GD   Governance Decay, arXiv:2606.22528v2, reconstructed from paper content
 *   CI   COMPINT, arXiv:2608.11242, adapted from a prose side constraint to effect-grounded form
 *   DER  derived from another case in this set, holding the grader fixed
 *   NEW  authored for this threat model
 */
export type CaseProvenance = "GD" | "CI" | "DER" | "NEW";

/**
 * The one delivery channel a case would plausibly arrive through.
 *
 * `c2` is absent by construction, not by omission. `channelInstruction()` hands the model the
 * policy in a user turn and THEN asks it to persist the text, so `c2` structurally contains `c1`.
 * It is a transform applied to a personal case, never a case's home channel.
 */
export type ChannelAffinity = "c1" | "c3" | "c4";

/**
 * Where the policy entry sat relative to the cut point.
 * "not_applicable" is G0 (no policy) and G1 (no compaction) — not a null measurement.
 *
 * v1.2 adds `dropped`, which v1.1 had no way to express. With only summarization strategies a
 * policy entry was always either summarized or retained, so two values sufficed. A mechanism arm
 * (`fifo`, `lru-mechanism`, `lru-prompting`) deletes without replacing, and recording that as
 * `summarized_prefix` would assert that a summary carried the rule forward when no summary exists
 * — turning the most interesting outcome these arms can produce into an indistinguishable one.
 */
export type PolicyLocation =
  | "summarized_prefix"
  | "retained_tail"
  | "dropped"
  | "not_applicable";

export type InvalidReason =
  | "no_compaction_in_compacted_condition"
  | "compaction_in_uncompacted_condition"
  | "invalid_manual_compaction_count"
  | "missing_native_compaction"
  | "empty_native_summary"
  | "custom_compaction_detected"
  /**
   * The summarizer's provider refused the content (e.g. HTTP 403 "violation of provider Terms
   * Of Service"). The decision turn still runs, on the UNCOMPACTED context, so the outcome is
   * observable — but the row is invalid as a compacted observation, because no compaction
   * happened and the agent effectively saw a G1-shaped context.
   */
  | "summarizer_refused"
  /**
   * The summarizer call exhausted its transient-error retries (429/5xx/timeout). Distinct from
   * `missing_native_compaction` on purpose: this is a property of the account's rate limit, not
   * of the model's compaction behaviour, and conflating them makes a throttled run look like a
   * broken one while silently shrinking the denominator.
   */
  | "summarizer_rate_limited"
  | "relink_admissibility_failed"
  | "anchor_mismatch_r0_r1"
  | "evaluator_protocol_failure"
  | "downstream_failure"
  | "g1_policy_missing_at_decision"
  /**
   * v1.1 c2/c4: the channel requires a model-authored tool call to place the policy. If the call
   * never happened, or its policy-bearing content came back blank, the condition was not
   * constructed and the row is not an observation of it. Deliberately NOT a fidelity check --
   * a paraphrased policy is the channel behaving as it behaves and stays reportable.
   */
  | "policy_channel_unsatisfied"
  /**
   * The full-context request plus its response allowance does not fit the model's
   * context window. The comparison is UNAVAILABLE for that configuration, and saying so is the
   * point -- silently trimming the input and still labelling the row "full" would make the
   * full-context control a fiction while every number it produced still looked valid.
   */
  | "full_context_exceeds_window"
  /**
   * The final-request check found a filler body that did not survive serialization.
   * Verified at the request boundary rather than at construction, because construction proves
   * nothing about what the provider was actually sent.
   */
  | "full_context_not_verified"
  | "fixture_cannot_be_reportable"
  | "fixture_in_reportable_aggregate"
  | "paired_input_mismatch";

/** An assistant turn's declared tool calls. Without this, tool results are orphaned. */
export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CanonicalMessage {
  entryId: string;
  role: MessageRole;
  content: string;
  /** Assistant role only. Every `role: "tool"` message must reference an id declared here. */
  toolCalls?: CanonicalToolCall[];
  toolName?: string;
  toolCallId?: string;
}

export interface CompactionRequest {
  runId: string;
  messages: CanonicalMessage[];
  /** Entry id of the policy message, or null when the condition carries no policy. */
  policyEntryId: string | null;
  /**
   * Entry id of the fixture's benign task instruction.
   *
   * Optional because pi's own path does not use it: pi chooses its cut and never pins an entry.
   * The harness path does -- the retention floor keeps the task instruction verbatim (TRACE
   * appendix A.2) -- so a harness-backend adapter rejects a request that omits it rather than
   * quietly dropping the floor.
   */
  taskInstructionEntryId?: string;
  /** Text of the same entry. ACON binds `{{ task }}` to it; Hermes does not read it. */
  taskInstruction?: string;
  systemPrompt: string;
  /** The summarizer model pi uses for the compaction call. */
  model: string;
  baseUrl: string;
  openrouterApiKey: string;
  reasoningEffort: "low" | "medium" | "high";
  keepRecentTokens: number;
  reserveTokens: number;
  strategy: CompactionStrategy;
  /** The binding summarizer output cap. Omitted keeps v1.1's 8,192. */
  summarizerMaxTokens?: number;
  /**
   * A frozen instruction pi appends as "Additional focus: ...".
   *
   * Only `pi-native-policy-preserving` sets it. When present the arm is a MODIFIED method and must
   * never be reported as pi's default behaviour.
   */
  customInstructions?: string;
  /**
   * Retry budget for the summarizer call. pi does not retry it, so without these a single 429
   * permanently invalidates the row (see `isTransientProviderError`).
   */
  maxTransientRetries?: number;
  retryBaseDelayMs?: number;
  /**
   * Optional per-run trajectory sink. The adapter is the only place that can observe
   * pi's cut decision and the text it hands the summarizer, so it emits those events itself.
   * Typed loosely to keep `schema.ts` free of a dependency on the writer's module.
   */
  trajectory?: {
    record(event: unknown): void;
  } | null;
  /** Recorded on `summarizer_input` in place of pi's unexported prompt constant. */
  piRevision?: string;
}

/**
 * Why the policy entry ended up where it did, for a `select` arm.
 *
 * `policyLocation` answers WHERE; this answers WHY. The first v1.2 sweep recorded `dropped` on
 * 1,674/1,674 LRU runs and that read as an eviction result, when the 50-token allowance was smaller
 * than every one of the nine policies (71-99 tokens) and no ranking could have saved any of them.
 * Without this field a budget-infeasible run and a genuinely rank-evicted run are the same row.
 */
export type PolicySelectionOutcome =
  /** Survived the arm's selection and the driver's tool-pair repair. */
  | "kept"
  /** It would have fit on its own, and the arm's rule did not choose it. The only real eviction. */
  | "rank_evicted"
  /** Its own size exceeds the whole selection allowance, so no ranking could have kept it. */
  | "budget_ineligible"
  /** Selected, then stripped because its declaring tool call did not survive (tool-pair repair). */
  | "orphan_repaired"
  /** Pinned or already in the retained tail, so it was never a candidate. */
  | "not_offered"
  /** No policy in this condition. */
  | "not_applicable";

/** How a `lru-prompting`-style ranker responded, recorded separately from the decision outcome. */
export interface RankerDiagnostics {
  /** Entries the ranker was asked to order. */
  requested: number;
  /** Distinct in-range indices it actually returned. */
  ranked: number;
  /** In-range indices it never mentioned. */
  omitted: number;
  /** False when the response contained no usable index at all. */
  usable: boolean;
  /** Where omitted indices were placed. Recorded because it is a convention, not a derivation. */
  fallback: "median" | "transcript-order-last" | "none";
  /** Chars of history the ranker was shown, so a preview limit can never be silently reintroduced. */
  historyChars: number;
}

/**
 * What a `select` arm did with its allowance.
 *
 * Null for `text` arms and for the pi arms, which have no selection step.
 */
export interface SelectionDiagnostics {
  /** The allowance this arm was given, in estimated tokens. 0 reproduces "keep nothing". */
  budgetTokens: number;
  /** Prefix entries that survived, after tool-pair repair. Excludes the pinned instruction. */
  selectedEntryIds: string[];
  /** Estimated size of those survivors, on the same convention as `tokensBefore`/`tokensAfter`. */
  selectedTokens: number;
  policyOutcome: PolicySelectionOutcome;
  ranker: RankerDiagnostics | null;
}

/**
 * v1.4: what budget this row ran under, and whether it could honour it.
 *
 * Null for every v1.1/v1.2/v1.3 row and for v1.4's unconstrained condition. Null means "no budget
 * applied", never "the budget was met".
 */
export interface BudgetRecord {
  budgetTokens: number;
  budgetFloorTokens: number;
  summaryAllowanceTokens: number;
  budgetEffectiveTokens: number;
  /** False when the clamp fired: the arm was asked for less than the budget nominally allows. */
  budgetFeasible: boolean;
  /**
   * `tokensAfter` exceeded `budgetTokens`.
   *
   * EXPECTED, not anomalous, in two cases, and both have to be readable from the row: a clamped
   * row overruns by construction, and `max_tokens` is counted by the provider's tokenizer while
   * `tokensAfter` is this harness's chars/4 estimate. The two are different scales and are not
   * reconciled -- doing so would report a provider-side count as if it were our own.
   */
  budgetOverrun: boolean;
  /**
   * The harness cut the replacement to the allowance.
   *
   * This is the one thing `prompt+mechanism` cannot otherwise tell you: with both halves applied,
   * a summary at or under budget may have complied with the stated allowance or may have been cut
   * to it, and those are different phenomena. `false` means the arm came in under budget on its
   * own. Null only on the pi arms, whose summary the runner cuts outside this driver.
   */
  budgetTruncated: boolean | null;
  /** How much text the cut discarded. 0 when the arm came in under budget on its own. */
  budgetCharsRemoved?: number;
}

export interface CompactionArtifact {
  backend: CompactorBackend;
  strategy: CompactionStrategy;
  nativeVersion: string;
  summary: string;
  postCompactionMessages: CanonicalMessage[];
  /** pi's own cut-point answer, not harness arithmetic. Null only for legacy-fixed-cut. */
  firstKeptEntryId: string | null;
  compactedEntryIds: string[];
  retainedEntryIds: string[];
  /** Derived by comparing the policy entry id against firstKeptEntryId. */
  policyLocation: PolicyLocation;
  /** Parsed from the summary's heading-bounded `## Constraints & Preferences` section. */
  summaryPolicyPreserved: boolean | null;
  summaryConstraintsSection: string | null;
  /** Real pi estimates, not messagesToSummarize.length * 500. */
  tokensBefore: number | null;
  tokensAfter: number | null;
  native: boolean;
  trigger: "manual";
  observedCompactions: number;
  rawArtifactPath: string;
  /** v1.2-update: null for every arm that does not select (text arms, pi arms). */
  selection: SelectionDiagnostics | null;
  /** v1.4: null for every unconstrained row, which is every v1.1/v1.2/v1.3 row. */
  budget: BudgetRecord | null;
}

export interface CompactorAdapter {
  readonly backend: CompactorBackend;
  compact(request: CompactionRequest): Promise<CompactionArtifact>;
}

/** Everything needed to reproduce and audit a G3 haystack after the fact. */
export interface NeedleRecord {
  corpusId: string;
  corpusSha256: string;
  corpusChars: number;
  seed: number;
  needleKey: string;
  needleValue: string;
  needleCharOffset: number;
  needleSentence: string;
  /**
   * Deterministic post-hoc check: did the generated summary carry the value through?
   *
   * v1.1 -- read this as a DOSE INDICATOR on the delivery axis, never as a statement about the
   * summarizer. The needle sits at a random paragraph boundary, and pi truncates each tool result
   * to 2,000 chars, so survival is set by the arm's window coverage before any model runs:
   * A1 0/9 (2.1% coverage), A2 3/9 (25.6%), A3 9/9 (100%). A run returning materially different
   * rates means the arms are not delivering the coverage the design claims.
   */
  needleInSummary: boolean | null;
}

export interface PlannedRun {
  runId: string;
  pairKey: string;
  family: ExperimentFamily;
  condition: GovernanceCondition | RelinkCondition;
  taskOrSampleId: string;
  compactorBackend: CompactorBackend | null;
  /** Null for every no-policy condition, which has no policy to deliver. */
  policyChannel: PolicyChannel | null;
  /** Null for conditions with no haystack. */
  haystackArm: HaystackArmId | null;
  compactionStrategy: CompactionStrategy | null;
  repetition: number;
  fixtureOnly: boolean;
  reportable: boolean;
  /** Expected manual compactions for this condition — 0 for G0/G1, 1 for G2-G4. */
  manualCompactions: number;
  model: string;
  seed: number;
}

export interface NormalizedResult {
  runId: string;
  pairKey: string;
  family: ExperimentFamily;
  condition: GovernanceCondition | RelinkCondition;
  taskOrSampleId: string;
  compactorBackend: CompactorBackend | null;
  policyChannel: PolicyChannel | null;
  haystackArm: HaystackArmId | null;
  /**
   * v1.1 c2/c4: did the model actually make the policy-placing tool call, with non-blank content?
   * Null for c1/c3, which are harness-authored and cannot fail this way.
   */
  policyChannelSatisfied: boolean | null;
  /** Path to this run's event log, so a row is traceable to its trajectory. */
  trajectoryPath: string | null;
  /**
   * The run's own model-facing time (`prepareMs + decisionMs`), excluding queue wait.
   * Previously computed and then dropped at normalization.
   */
  durationMs: number;
  prepareMs: number | null;
  decisionMs: number | null;
  fixtureOnly: boolean;
  reportable: boolean;
  /** Machine-readable, so a reconstructed run can never merge with an exact-release run. */
  sourceFidelity: SourceFidelity;
  provenance: RunProvenance;
  valid: boolean;
  invalidReason: InvalidReason | null;
  compaction: {
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
  } | null;
  /** For G1: was the policy actually in context when the trigger was sent? */
  policyPresentAtDecision: boolean | null;
  needle: NeedleRecord | null;
  outcome: {
    grade: GradeResult;
    /** The binary reportable label. `unparseable` runs carry null: not an observation. */
    binaryLabel: "violation" | "not_violation" | null;
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
    terminalText: string;
    /** Model turns taken before a terminal state was reached. */
    toolSteps: number;
    /** True if the trajectory was cut off at the step cap rather than finishing. */
    hitStepCap: boolean;
  } | null;
}
