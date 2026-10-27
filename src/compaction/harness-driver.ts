/**
 * The harness compaction path, and the parity contract every strategy on it obeys.
 *
 * ## Why a driver instead of ten adapters
 *
 * Each strategy needs comparable records. The v1.1 way of meeting that would be to write the same
 * bookkeeping into every adapter and rely on review to keep them aligned -- which is exactly how
 * `legacy-fixed-cut` ended up estimating its prefix while the native path measured the entire
 * context, so a comparison between them differed in measurement method rather than in strategy.
 *
 * So the boundary, the assembly, the retention floor and the recording all live here, once. A
 * strategy supplies only `compress`: given the compressible history, what replaces it? Parity is
 * then structural. A new arm cannot forget to record something, because it never had the chance.
 *
 * ## The two shapes a strategy can take
 *
 * `text`   — generated prose stands in for the removed history (Group B).
 * `select` — no text at all; a subset of the history survives verbatim (fifo, lru-*).
 *
 * The `select` shape is why `empty_native_summary` cannot be applied blindly: for a mechanism arm
 * an empty summary is the correct output, and treating it as a fault would invalidate every row at
 * the moment it succeeded.
 */
import type {
  CanonicalMessage,
  CompactionArtifact,
  PolicyLocation,
  PolicySelectionOutcome,
  RankerDiagnostics,
  SelectionDiagnostics,
} from "../harness/schema.ts";
import {
  assertRetentionFloor,
  estimateTokens,
  findHarnessCut,
  splitAtCut,
  type HarnessCut,
} from "./boundary.ts";
import { PROMPT_PROVENANCE } from "./prompts.ts";
import { resolveBudget, truncateToBudget, type BudgetBinding } from "./budget.ts";
import { producesReplacementText, type StrategyId } from "./strategy-ids.ts";
import type { DefenseId } from "../defenses/defenses.ts";

export class HarnessCompactionError extends Error {
  constructor(
    readonly reason:
      | "summarizer_refused"
      | "summarizer_rate_limited"
      | "missing_native_compaction"
      | "empty_native_summary",
    message: string,
  ) {
    super(message);
  }
}

/** A model call a strategy made, recorded identically whatever made it. */
export interface CallRecord {
  kind: "summarizer" | "ranker";
  model: string | null;
  latencyMs: number;
  usage: unknown;
  /** The exact text sent, so a summarizer input is auditable without rerunning anything. */
  requestText: string;
  responseText: string;
  /**
   * v1.4: the provider's `finish_reason`, or null when the transport reported none.
   *
   * `"length"` means the `max_tokens` cap fired. Optional so every existing construction site
   * keeps compiling; null rather than `false`-by-default, because "the transport said nothing"
   * and "the model stopped on its own" are different facts.
   */
  finishReason?: string | null;
}

export interface CompressInput {
  /** Everything before the cut. This is what the strategy may remove or rewrite. */
  compressible: CanonicalMessage[];
  /** Everything from the cut onward. Retained verbatim by every strategy. */
  retained: CanonicalMessage[];
  /**
   * The SELECTION ALLOWANCE: how many estimated tokens of prefix a `select` arm may keep.
   *
   * Two properties, both load-bearing:
   *
   * 1. **It is not the cut.** Until the v1.2-update this was `retainedTailTokens`, the boundary
   *    budget, reused as a selection allowance because the two happened to share a number. They
   *    are different quantities: the cut decides what is REMOVED and is calibrated against pi's
   *    own cut index; the allowance decides what a select arm may put BACK. Conflating them made
   *    the allowance 50 tokens against policies of 71-99, so no ranking could ever retain one.
   *    `retainedTailTokens` stays pinned; this moves independently.
   *
   * 2. **It is configured, never realized.** Sizing against the realized tail would make an arm's
   *    allowance depend on how lumpy that transcript's final turns happen to be, so the same
   *    strategy would get a different budget per task and the cross-task comparison would quietly
   *    stop being a comparison of the strategy.
   *
   * 0 reproduces "keep nothing from the prefix", which is what every v1.2 `fifo` row measured.
   *
   * Named distinctly from `replacementBudgetTokens` on purpose. One field called `budgetTokens`
   * previously served both, so redefining it silently retargeted `prompting-h`'s summary length.
   * Two names mean an arm cannot read the wrong one by accident --
   * the same reasoning `boundary.ts` gives for keeping `retainedTailTokens` and pi's
   * `keepRecentTokens` apart.
   */
  selectionBudgetTokens: number;

  /**
   * How long a `text` arm's REPLACEMENT should be, for the arms whose prompt takes a target.
   *
   * `prompting-h` binds it to `{summary_budget}`. Bound to `retainedTailTokens`, which is what
   * these arms have always received.
   */
  replacementBudgetTokens: number;
  /** What the tail actually came to, for recording. Never a budget. */
  realizedTailTokens: number;
  /**
   * v1.4: the output-token budget, or null for the unconstrained condition.
   *
   * Optional and null-defaulting so every v1.2 and v1.3 caller keeps compiling AND behaving
   * identically -- an unconstrained v1.4 row has to stay comparable with a v1.2 row, which it
   * cannot if the mere presence of this field changes the request.
   *
   * An arm reads `summaryAllowanceTokens`, never `budgetTokens`: the budget caps the whole
   * post-compaction context, of which the retention floor is already spent.
   */
  outputBudget?: BudgetBinding | null;
  /**
   * v1.6: the defense applied to this arm's prompt, or null/absent for none.
   *
   * Optional and null-defaulting for the same reason `outputBudget` is: a v1.6 row at
   * `defense: "none"` has to stay byte-comparable with a v1.3 row, which it cannot if the mere
   * presence of the field changes the request.
   */
  defense?: DefenseId | null;
  /** The fixture's benign task instruction, for arms whose prompts take it as a binding. */
  taskInstruction: string;
  runId: string;
  model: string;
}

export type CompressResult =
  | { kind: "text"; text: string; call: CallRecord | null }
  | {
      kind: "select";
      kept: CanonicalMessage[];
      call: CallRecord | null;
      /** Only arms that consult a model to rank set this; the driver records it verbatim. */
      ranker?: RankerDiagnostics;
    };

export interface HarnessStrategy {
  readonly id: StrategyId;
  compress(input: CompressInput): Promise<CompressResult>;
}

export interface DriveOptions {
  runId: string;
  messages: CanonicalMessage[];
  policyEntryId: string | null;
  /** Entry id of the fixture's benign task instruction, for the retention floor. */
  taskInstructionEntryId: string;
  taskInstruction: string;
  /** Where the cut goes. Calibrated against pi; never used as a selection allowance. */
  retainedTailTokens: number;
  /**
   * How much prefix a `select` arm may keep. Independent of the cut.
   *
   * Optional so the existing tests and any caller that only exercises `text` arms keep compiling;
   * defaults to 0, which is the v1.2 `fifo` behaviour and the safest possible default -- a missing
   * allowance shrinks context rather than silently granting one.
   */
  selectionBudgetTokens?: number;
  /**
   * v1.4: the budget rung, or null/absent for the unconstrained condition.
   *
   * The DRIVER -- not the caller and not the arm -- derives the floor and resolves the binding,
   * for the same reason the boundary and the retention floor live here: a per-arm derivation is a
   * per-arm opportunity to get it wrong, and the first arm that does produces a plausible number
   * rather than an error.
   */
  outputBudgetTokens?: number | null;
  /** v1.5: the rungs the calling protocol declared. Defaults to v1.4's ladder. */
  outputBudgetLadder?: readonly number[];
  /** v1.6: the defense level, threaded to the arm. Absent means none. */
  defense?: DefenseId | null;
  model: string;
  trajectory?: { record(event: unknown): void } | null;
  rawArtifactPath?: string;
}

/**
 * Where the policy entry ended up.
 *
 * v1.2 adds `dropped`, which v1.1 had no way to express: with only summarization strategies, a
 * policy entry was always either summarized or retained. A mechanism arm can simply delete it, and
 * recording that as `summarized_prefix` would claim a summary carried it forward when none exists.
 */
function locatePolicy(
  policyEntryId: string | null,
  compressible: CanonicalMessage[],
  retained: CanonicalMessage[],
  survivors: CanonicalMessage[],
  producedText: boolean,
): PolicyLocation {
  if (policyEntryId === null) return "not_applicable";
  if (retained.some((m) => m.entryId === policyEntryId)) return "retained_tail";
  if (survivors.some((m) => m.entryId === policyEntryId)) return "retained_tail";
  if (compressible.some((m) => m.entryId === policyEntryId)) {
    return producedText ? "summarized_prefix" : "dropped";
  }
  return "not_applicable";
}

/**
 * Why the policy did not survive a `select` arm.
 *
 * The distinction that matters is `budget_ineligible` vs `rank_evicted`. The first says the arm
 * was never allowed to keep the rule, whatever it thought of it; the second says the arm had the
 * room and chose otherwise. Only the second is evidence about an eviction policy, and the v1.2
 * sweep could not tell them apart -- every LRU row read `dropped`, and that was quoted as an
 * eviction result when the allowance (50) was below every policy's size (71-99).
 *
 * Computed here rather than per arm so a new select arm cannot omit it.
 */
export function policySelectionOutcome(args: {
  policyEntryId: string | null;
  compressible: readonly CanonicalMessage[];
  retained: readonly CanonicalMessage[];
  pinned: readonly CanonicalMessage[];
  /** What the arm returned, BEFORE the driver's tool-pair repair. */
  preRepairKept: readonly CanonicalMessage[];
  /** What survived the repair. */
  survivors: readonly CanonicalMessage[];
  budgetTokens: number;
}): PolicySelectionOutcome {
  const { policyEntryId } = args;
  if (policyEntryId === null) return "not_applicable";
  const has = (xs: readonly CanonicalMessage[]) => xs.some((m) => m.entryId === policyEntryId);
  if (has(args.retained) || has(args.pinned)) return "not_offered";
  const entry = args.compressible.find((m) => m.entryId === policyEntryId);
  if (!entry) return "not_applicable";
  if (has(args.survivors)) return "kept";
  if (has(args.preRepairKept)) return "orphan_repaired";
  // Checked against the entry ALONE: if it cannot fit an empty cache it could never have fit a
  // partly-full one, and no ordering over the other entries changes that.
  if (estimateTokens([entry]) > args.budgetTokens) return "budget_ineligible";
  return "rank_evicted";
}

/**
 * Drop any tool result in `kept` whose declaring assistant turn survives nowhere.
 *
 * `alsoDeclaredIn` covers the retained tail: a selected tool result whose call sits in the tail is
 * legitimate, because the tail is emitted after the survivors.
 */
export function dropOrphanedToolResults(
  kept: readonly CanonicalMessage[],
  alsoDeclaredIn: readonly CanonicalMessage[] = [],
): CanonicalMessage[] {
  const declared = new Set<string>();
  for (const m of [...kept, ...alsoDeclaredIn]) {
    if (m.role === "assistant") for (const c of m.toolCalls ?? []) declared.add(c.id);
  }
  return kept.filter((m) => m.role !== "tool" || (m.toolCallId !== undefined && declared.has(m.toolCallId)));
}

/**
 * Repair tool pairs in BOTH directions, so no survivor references a message that is gone.
 *
 * `dropOrphanedToolResults` covers one direction. This adds the mirror: an assistant turn that
 * declares a call whose result did not survive has that call stripped. OpenAI-shaped providers
 * reject the unrepaired shape outright --
 *
 *     No tool output found for function call tc-chan-1.  (invalid_request_error)
 *
 * -- and the providers that DON'T reject it are the reason this matters. A lenient provider accepts
 * the malformed conversation and the row is recorded valid, so the arm gets measured on a
 * transcript referencing a call with no outcome. That is a silent difference between models in
 * exactly the place the Group C pairing exists to hold fixed.
 *
 * `alsoDeclaredIn` is the retained tail, emitted after the survivors: a call answered there is
 * legitimately paired and must not be stripped.
 *
 * Order matters. Calls are stripped first, because that can empty an assistant turn which existed
 * only to carry one; those turns are dropped, and results are then re-checked against what actually
 * remains.
 */
export function repairToolPairs(
  kept: readonly CanonicalMessage[],
  alsoDeclaredIn: readonly CanonicalMessage[] = [],
): CanonicalMessage[] {
  const answered = new Set<string>();
  for (const m of [...kept, ...alsoDeclaredIn]) {
    if (m.role === "tool" && m.toolCallId !== undefined) answered.add(m.toolCallId);
  }

  const stripped: CanonicalMessage[] = [];
  for (const m of kept) {
    if (m.role !== "assistant" || !m.toolCalls?.length) {
      stripped.push(m);
      continue;
    }
    const surviving = m.toolCalls.filter((c) => answered.has(c.id));
    if (surviving.length === m.toolCalls.length) {
      stripped.push(m);
      continue;
    }
    // A turn carrying nothing but the evicted call has no content left to contribute, and a
    // contentless assistant turn is itself rejected by some providers.
    if (surviving.length === 0 && !m.content?.trim()) continue;
    stripped.push({ ...m, toolCalls: surviving });
  }

  return dropOrphanedToolResults(stripped, alsoDeclaredIn);
}

/**
 * Run one strategy end to end on the harness path.
 *
 * Deliberately not parameterised by strategy anywhere except the `compress` call: if the boundary
 * or the assembly could vary per arm, Group B would stop being a prompt comparison and nothing in
 * the output would reveal that.
 */
export async function driveHarnessCompaction(
  strategy: HarnessStrategy,
  opts: DriveOptions,
): Promise<CompactionArtifact> {
  const { messages, runId } = opts;
  if (messages.length < 2) {
    throw new HarnessCompactionError(
      "missing_native_compaction",
      `too few messages to compact (${messages.length})`,
    );
  }

  const cut: HarnessCut = findHarnessCut(messages, {
    retainedTailTokens: opts.retainedTailTokens,
  });
  const { compressible: prefix, retained } = splitAtCut(messages, cut.firstKeptIndex);

  // The retention floor is STRUCTURAL, not a check that fires afterwards.
  //
  // The compressible history excludes the original task instruction, and TRACE appendix A.2 says
  // every strategy retains it verbatim. Enforcing that by assertion instead of by
  // construction means each new arm has to remember not to evict it -- and the first one that
  // forgets produces a hard failure at the moment it otherwise succeeded. FIFO forgot on its first
  // run, which is what surfaced this.
  const pinned = prefix.filter(
    (mm) => mm.entryId === opts.taskInstructionEntryId && !retained.some((r) => r.entryId === mm.entryId),
  );
  const compressible = prefix.filter((mm) => !pinned.some((p) => p.entryId === mm.entryId));

  // Recorded BEFORE the strategy runs, so a failed or refused call still leaves the cut decision
  // and the inputs on disk. v1.1 recorded nothing in that case, which made a provider refusal
  // indistinguishable from a call that never reached the provider.
  opts.trajectory?.record({
    type: "cut_decision",
    path: "harness",
    strategy: strategy.id,
    canonicalFirstKeptEntryId: messages[cut.firstKeptIndex]?.entryId ?? null,
    canonicalFirstKeptIndex: cut.firstKeptIndex,
    nativeFirstKeptEntryId: null,
    nativeFirstKeptIndex: null,
    nonMessageEntriesSkipped: 0,
    compactedEntryIds: compressible.map((m) => m.entryId),
    retainedEntryIds: retained.map((m) => m.entryId),
    isSplitTurn: false,
    turnStartIndex: null,
    requestedTailTokens: opts.retainedTailTokens,
    realizedTailTokens: cut.realizedTailTokens,
    realizedTailEntries: cut.realizedTailEntries,
  });

  const selectionBudgetTokens = opts.selectionBudgetTokens ?? 0;

  // The floor is a property of THIS transcript and THIS cut, so it is derived from the `cut` and
  // `pinned` already in hand rather than by re-running `findHarnessCut` -- a second derivation of
  // a number we have is a second chance for the two to disagree.
  const budgetBinding: BudgetBinding | null =
    opts.outputBudgetTokens === null || opts.outputBudgetTokens === undefined
      ? null
      : resolveBudget(
          opts.outputBudgetTokens,
          estimateTokens(pinned) + cut.realizedTailTokens,
          opts.outputBudgetLadder,
        );
  if (budgetBinding) {
    opts.trajectory?.record({ type: "budget_binding", strategy: strategy.id, ...budgetBinding });
  }

  const startedAt = Date.now();
  const result = await strategy.compress({
    compressible,
    retained,
    selectionBudgetTokens,
    replacementBudgetTokens: opts.retainedTailTokens,
    realizedTailTokens: cut.realizedTailTokens,
    taskInstruction: opts.taskInstruction,
    outputBudget: budgetBinding,
    defense: opts.defense ?? null,
    runId,
    model: opts.model,
  });

  const producedText = result.kind === "text";
  if (producedText && result.text.trim().length === 0) {
    // Only meaningful for arms that are supposed to produce text. Applying it to `fifo` would
    // invalidate every row at the moment it succeeded.
    throw new HarnessCompactionError(
      "empty_native_summary",
      `${strategy.id} returned empty replacement text`,
    );
  }

  // ---- Tool-pair integrity, enforced for EVERY select arm ----
  //
  // Selection-based eviction can keep a tool result while dropping the assistant turn that
  // declared its call. The decision request then carries a `tool_call_id` appearing nowhere, which
  // OpenAI-compatible endpoints reject with HTTP 400 -- recorded as `evaluator_protocol_failure`,
  // i.e. as a provider problem rather than as the eviction bug it is.
  //
  // This was written into `lru-mechanism` and forgotten in `lru-prompting`, and the first full
  // sweep lost all 53 of that arm's rows to it. Per-strategy discipline demonstrably does not hold
  // here, so the driver enforces it: a new select arm cannot reintroduce this.
  //
  // Repair runs in BOTH directions here. The arms themselves call the one-directional
  // `dropOrphanedToolResults`, which leaves an assistant turn declaring a call whose result was
  // evicted -- a shape OpenAI-format providers reject outright and lenient ones silently accept.
  // The arms are left alone deliberately: their own `kept` feeds their selection-token accounting,
  // and the driver is the enforcement point, so completing the repair here covers every arm
  // including ones not yet written.
  const preRepairKept = result.kind === "select" ? result.kept : [];
  const survivors =
    result.kind === "select" ? repairToolPairs(result.kept, retained) : [];
  // The HARD half of `prompt+mechanism`, applied here rather than by the provider: `max_tokens`
  // bounds reasoning plus output on this model panel and returned empty summaries at every rung.
  // Cutting before `postCompactionMessages` is built means tokensAfter, the retention floor and
  // the trajectory all see the text that actually reaches the decision agent.
  const cut2 = producedText && budgetBinding
    ? truncateToBudget(result.text, budgetBinding.summaryAllowanceTokens)
    : { text: producedText ? result.text : "", truncated: false, charsRemoved: 0 };
  const replacement = cut2.text;

  // Recorded for every select arm, whatever the arm chose to report about itself. An arm that
  // overruns its allowance (`lru-prompting` did, on 253/432 rows, by charging only message
  // content) is then visible in the row rather than only in a re-derivation from the trajectory.
  const selection: SelectionDiagnostics | null =
    result.kind === "select"
      ? {
          budgetTokens: selectionBudgetTokens,
          selectedEntryIds: survivors.map((m) => m.entryId),
          selectedTokens: estimateTokens(survivors),
          policyOutcome: policySelectionOutcome({
            policyEntryId: opts.policyEntryId,
            compressible,
            retained,
            pinned,
            preRepairKept,
            survivors,
            budgetTokens: selectionBudgetTokens,
          }),
          ranker: result.ranker ?? null,
        }
      : null;

  // A `select` arm's survivors must appear in transcript order, and the pinned instruction is one
  // of them -- prepending it would put it ahead of a survivor that precedes it in the original
  // conversation, which reorders history rather than removing from it.
  //
  // For a `text` arm the summary is new content with no position of its own, so the instruction
  // sits ahead of it: original task, then what happened, then the recent turns.
  const order = new Map(messages.map((mm, i) => [mm.entryId, i]));
  const inOrder = (xs: CanonicalMessage[]) =>
    [...xs].sort((a, b) => (order.get(a.entryId) ?? 0) - (order.get(b.entryId) ?? 0));

  const postCompactionMessages: CanonicalMessage[] = producedText
    ? [...pinned, { entryId: `${runId}-summary`, role: "user", content: replacement }, ...retained]
    : [...inOrder([...pinned, ...survivors]), ...retained];

  assertRetentionFloor({
    original: messages,
    retained: postCompactionMessages,
    replacement,
    originalTaskInstructionId: opts.taskInstructionEntryId,
  });

  if (result.call) {
    opts.trajectory?.record({
      type: "summarizer_input",
      part: "history",
      strategy: strategy.id,
      entryIds: compressible.map((m) => m.entryId),
      serializedConversation: result.call.requestText,
      charsBeforeTruncation: compressible.reduce((n, m) => n + m.content.length, 0),
      charsAfterTruncation: result.call.requestText.length,
      // The harness path applies no tool-result cap unless the method specifies one, so nothing
      // is discarded here. Recorded explicitly rather than omitted: "no truncation happened" and
      // "truncation was not measured" are different facts.
      truncatedEntryIds: [],
      charsDiscardedPerEntry: {},
      reconstructed: false,
    });
    opts.trajectory?.record({
      type: "summarizer_output",
      part: "history",
      strategy: strategy.id,
      summary: result.call.responseText,
      usage: result.call.usage,
      model: result.call.model,
      latencyMs: result.call.latencyMs,
    });
  }

  if (selection) {
    opts.trajectory?.record({ type: "selection_decision", strategy: strategy.id, ...selection });
  }

  opts.trajectory?.record({
    type: "post_compaction_context",
    messages: postCompactionMessages.map((m) => ({
      entryId: m.entryId,
      role: m.role,
      chars: m.content.length,
      content: m.content,
    })),
    totalChars: postCompactionMessages.reduce((n, m) => n + m.content.length, 0),
  });

  const provenance = PROMPT_PROVENANCE[strategy.id];
  void provenance; // stamped onto the row by the caller, which owns the result schema

  return {
    backend: "harness",
    strategy: strategy.id,
    nativeVersion: "v1.2-harness",
    summary: replacement,
    postCompactionMessages,
    firstKeptEntryId: messages[cut.firstKeptIndex]?.entryId ?? null,
    compactedEntryIds: compressible
      .filter((m) => !survivors.some((s) => s.entryId === m.entryId))
      .map((m) => m.entryId),
    retainedEntryIds: postCompactionMessages
      .filter((m) => m.entryId !== `${runId}-summary`)
      .map((m) => m.entryId),
    policyLocation: locatePolicy(
      opts.policyEntryId,
      compressible,
      retained,
      survivors,
      producedText,
    ),
    // Parsed by the caller, which knows the strategy's schema. `producesReplacementText` decides
    // whether the diagnostic applies at all.
    summaryPolicyPreserved: null,
    summaryConstraintsSection: null,
    tokensBefore: estimateTokens(messages),
    tokensAfter: estimateTokens(postCompactionMessages),
    native: false,
    trigger: "manual",
    observedCompactions: 1,
    rawArtifactPath: opts.rawArtifactPath ?? "",
    selection,
    budget:
      budgetBinding === null
        ? null
        : {
            budgetTokens: budgetBinding.budgetTokens,
            budgetFloorTokens: budgetBinding.floorTokens,
            summaryAllowanceTokens: budgetBinding.summaryAllowanceTokens,
            budgetEffectiveTokens: budgetBinding.effectiveTokens,
            budgetFeasible: budgetBinding.feasible,
            budgetOverrun: estimateTokens(postCompactionMessages) > budgetBinding.budgetTokens,
            // Measured, not inferred: the harness performed the cut, so it knows. The
            // provider's finish_reason is no longer consulted -- generation is unbounded by the
            // budget now, so "length" would mean the configured ceiling fired, a different fact.
            budgetTruncated: cut2.truncated,
            budgetCharsRemoved: cut2.charsRemoved,
          },
  };
}

/** Whether the constraints diagnostic applies to this arm at all. */
export function diagnosticApplies(id: StrategyId): boolean {
  return producesReplacementText(id);
}
