/**
 * The v1.4 output-token budget, and the floor it runs into.
 *
 * The budget caps the POST-COMPACTION CONTEXT -- everything the decision agent receives -- not the
 * summary. That is the design owner's formulation and it is the quantity a deployed harness would
 * actually bound.
 *
 * ## Why absolute tokens rather than a percentage
 *
 * The ask was 20/50/80% of the uncompressed context. That is unrunnable in the cells this sweep
 * uses, and the reason is A3 filler: the pre-compaction context is ~28,000 tokens of which ~26,400
 * is haystack every method discards by construction, so the methods already land at 1.7-3.8% of
 * input. A 20% budget binds on 0 of 2,155 cohort-b filler rows -- every rung would have produced
 * rows byte-identical to unconstrained while still carrying a budget label.
 *
 * The absolute post-compaction size, by contrast, barely moves with input size (`baseline`: 736
 * tokens without filler, 823 with), so an absolute cap binds at the same rate either way.
 */
import type { BudgetRecord, CanonicalMessage } from "../harness/schema.ts";
import { estimateTokens, findHarnessCut, splitAtCut } from "./boundary.ts";
import { POLICY_PRESERVING_INSTRUCTION } from "./prompts.ts";
import type { StrategyId } from "./strategy-ids.ts";
import { renderBudgetInstruction } from "./budget-prompt.ts";

export class BudgetError extends Error {}

/** The five rungs. Ascending, and the only values `resolveBudget` accepts. */
export const V14_BUDGET_LADDER = [200, 300, 750, 1200, 2500] as const;

export type BudgetRung = (typeof V14_BUDGET_LADDER)[number];

/**
 * The smallest replacement a text arm may be asked for.
 *
 * Below this an arm returns something `driveHarnessCompaction` rejects as `empty_native_summary`,
 * which would invalidate exactly the rows a tight budget exists to observe. Deliberately UNDER the
 * smallest policy in the corpus (71-99 estimated tokens): where it binds, the rule cannot survive
 * verbatim, and that is the phenomenon under test rather than a harness fault.
 */
export const MIN_SUMMARY_TOKENS = 64;

/**
 * One enforcement mode in v1.4: the allowance is stated in the prompt AND capped mechanically.
 *
 * A soft-only arm would separate "the model complied" from "the harness cut it off". It is scoped
 * out, not forgotten -- `budgetTruncated` is recorded so that ablation has a target.
 */
export type BudgetEnforcement = "none" | "prompt+mechanism";

export interface BudgetBinding {
  /** The nominal rung, as configured. */
  budgetTokens: number;
  /** Pinned task instruction + realized tail: the smallest reachable `tokensAfter`. */
  floorTokens: number;
  /** What the arm is actually asked for, and what `max_tokens` is set to. */
  summaryAllowanceTokens: number;
  /** False when the clamp had to fire. Distinct from `floorTokens > budgetTokens`; see below. */
  feasible: boolean;
  /** `floorTokens + summaryAllowanceTokens`. Equals `budgetTokens` iff feasible. */
  effectiveTokens: number;
}

/**
 * Turn a rung and a floor into the number handed to the arm.
 *
 * `feasible` is NOT `floorTokens <= budgetTokens`. `channel`'s floor is 187 against the 200 rung --
 * it fits, and it still leaves 13 tokens, which is not a summary. Keying feasibility on the floor
 * alone would silently mark that row as honouring a budget it could not honour.
 */
export function resolveBudget(
  budgetTokens: number,
  floorTokens: number,
  /**
   * The rungs this protocol declared. Defaults to v1.4's, so every existing caller is unchanged.
   *
   * Parameterised rather than widened: the ladder is a property of the EXPERIMENT, not of the
   * compaction mechanics, and v1.5 sites its own rungs on measured data (300/450/600/750/1000).
   * Folding both ladders into one constant would let a v1.4 sweep accept a rung v1.4 never ran
   * and still lose the typo protection this guard exists for.
   */
  allowedRungs: readonly number[] = V14_BUDGET_LADDER,
): BudgetBinding {
  if (!allowedRungs.includes(budgetTokens)) {
    throw new BudgetError(
      `${budgetTokens} is not a declared budget rung. Known: ${[...allowedRungs].join(", ")}`,
    );
  }
  if (!Number.isInteger(floorTokens) || floorTokens < 0) {
    throw new BudgetError(`floorTokens must be a non-negative integer, got ${floorTokens}`);
  }

  const raw = budgetTokens - floorTokens;
  const feasible = raw >= MIN_SUMMARY_TOKENS;
  const summaryAllowanceTokens = feasible ? raw : MIN_SUMMARY_TOKENS;
  return {
    budgetTokens,
    floorTokens,
    summaryAllowanceTokens,
    feasible,
    effectiveTokens: floorTokens + summaryAllowanceTokens,
  };
}

/**
 * Cut a replacement to the allowance. This is the HARD half of `prompt+mechanism`.
 *
 * ## Why the harness truncates instead of the provider
 *
 * The first design set `max_tokens` to the allowance. Measured against `z-ai/glm-5.3-flash` that
 * does not work: `max_tokens` bounds reasoning PLUS visible output, reasoning ran 216 tokens
 * against a 200 cap and 506 against a 450 cap, and the summary came back empty both times. Whether
 * anything survives is a coin flip on how long reasoning happened to run.
 *
 * v1.1 had already fixed the compression denominator as the summary's TEXT size rather than the
 * provider's `output` count, for exactly this reason -- reasoning tokens are billed but never enter
 * the context. Truncating the text applies the same principle to enforcement.
 *
 * Cutting here also makes a constrained row differ from an unconstrained one in exactly two ways:
 * the prompt states a budget, and the text is cut to it. Generation itself is untouched, running at
 * the same configured ceiling either way, so nothing else varies between the two.
 *
 * The cut is exact and lands mid-word. Backing off to a word boundary would make the realized size
 * depend on where the nearest space fell, and the cap would stop being one number.
 */
export function truncateToBudget(
  text: string,
  allowanceTokens: number,
): { text: string; truncated: boolean; charsRemoved: number } {
  if (!Number.isInteger(allowanceTokens) || allowanceTokens <= 0) {
    throw new BudgetError(`allowance must be a positive integer, got ${allowanceTokens}`);
  }
  // chars/4, matching `estimateTokens`, so the cut text scores at the allowance in the same units
  // the budget, the floor and `tokensAfter` are all expressed in.
  const maxChars = allowanceTokens * 4;
  if (text.length <= maxChars) return { text, truncated: false, charsRemoved: 0 };
  return { text: text.slice(0, maxChars), truncated: true, charsRemoved: text.length - maxChars };
}

export interface FloorInput {
  messages: readonly CanonicalMessage[];
  taskInstructionEntryId: string;
  retainedTailTokens: number;
}

/**
 * The smallest post-compaction context this transcript admits.
 *
 * Mirrors `driveHarnessCompaction`'s own arithmetic deliberately: the instruction counts only when
 * the cut left it in the compressible prefix. When the tail already contains it, pinning it again
 * would double-count it, and the budget would be computed against a floor no arm ever pays.
 */
export function computeFloorTokens(input: FloorInput): number {
  const cut = findHarnessCut(input.messages, { retainedTailTokens: input.retainedTailTokens });
  const { compressible: prefix, retained } = splitAtCut(input.messages, cut.firstKeptIndex);
  const pinned = prefix.filter(
    (m) =>
      m.entryId === input.taskInstructionEntryId &&
      !retained.some((r) => r.entryId === m.entryId),
  );
  return estimateTokens(pinned) + cut.realizedTailTokens;
}

// ---------------------------------------------------------------------------
// pi's session path
// ---------------------------------------------------------------------------

/**
 * The two `CompactionRequest` fields a budget sets on pi's path.
 *
 * pi needs no new request field. `summarizerMaxTokens` is already the binding cap on summarizer
 * output, and `customInstructions` is already the frozen string pi appends as "Additional
 * focus: ...". The budget is the former and the sentence is appended to the latter. Adding a third
 * field would have implied pi treats a budget differently from an operating instruction, and it
 * does not.
 */
export function piBudgetRequestFields(
  strategyId: StrategyId,
  budget: BudgetBinding | null,
  summarizerMaxTokens: number,
): { summarizerMaxTokens: number; customInstructions?: string } {
  const parts: string[] = [];
  if (strategyId === "pi-native-policy-preserving") parts.push(POLICY_PRESERVING_INSTRUCTION);
  // Second, so the arm's own instruction keeps its position and the budget reads as an added
  // constraint on it rather than as a replacement for it.
  if (budget) parts.push(renderBudgetInstruction(budget.summaryAllowanceTokens));

  return {
    // NOT the allowance. `max_tokens` bounds reasoning plus output on this model panel, and
    // reasoning alone exceeds every rung -- see `truncateToBudget`. The configured ceiling stands
    // for constrained and unconstrained rows alike, so pi generates identically either way and the
    // budget is applied to the text afterwards.
    summarizerMaxTokens,
    ...(parts.length > 0 ? { customInstructions: parts.join(" ") } : {}),
  };
}

/**
 * Whether this pi row may still be attributed to pi's shipped behaviour.
 *
 * A budget reaches pi through `customInstructions`, which is precisely what makes
 * `pi-native-policy-preserving` a modified arm. A constrained `pi-native-cut` is modified by the
 * same token, and reporting it as native would attribute a result to pi's default prompt that
 * pi's default prompt did not produce.
 */
export function piNativeImplementation(
  strategyId: StrategyId,
  /**
   * Either shape of budget, or null. Only nullness is consulted, and accepting both is
   * deliberate: the runner holds a `BudgetRecord` off the artifact where the planner holds a
   * `BudgetBinding`, and making it take only one would mean restating this rule at the other
   * call site -- which is how the two would eventually disagree.
   */
  budget: BudgetBinding | BudgetRecord | null,
): boolean {
  if (strategyId !== "pi-native-cut") return false;
  return budget === null;
}
