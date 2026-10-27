/**
 * How the v1.4 budget reaches the summarizer.
 *
 * ## The instruction is content-neutral, on purpose
 *
 * It states a LENGTH and never a preference about what to keep. "Prefer operating rules over
 * narrative detail" would be a policy-preserving nudge, and every constrained arm would then carry
 * a weakened form of the intervention `pi-native-policy-preserving` exists to isolate. The budget
 * would stop being a budget and become a second treatment applied to all seven arms at once.
 * `tests/compaction-budget-prompt.test.ts` pins the absence rather than trusting review to notice
 * a later edit.
 *
 * ## Two delivery routes, recorded per row
 *
 * `prompting-h` and `acon-utco` already state a length in their published prompts. Appending a
 * second, different number would put two contradictory budgets in one prompt, so those arms get
 * the allowance through their OWN slot. The other arms carry no length instruction, so the
 * sentence is appended.
 *
 * That is a difference in delivery across arms, and it is recorded (`BUDGET_DELIVERY`) rather than
 * hidden -- a within-Group-B comparison at a given rung differs in this as well as in prompt.
 */
import type { StrategyId } from "./strategy-ids.ts";

export class PromptV14Error extends Error {}

/**
 * Frozen. Revising the wording starts a new configCohort; `tests/compaction-budget-prompt.test.ts`
 * pins it.
 */
export const V14_BUDGET_INSTRUCTION =
  "Your entire response must be at most {allowance} tokens. Do not exceed it.";

export function renderBudgetInstruction(allowanceTokens: number): string {
  if (!Number.isInteger(allowanceTokens) || allowanceTokens <= 0) {
    throw new PromptV14Error(`allowance must be a positive integer, got ${allowanceTokens}`);
  }
  return V14_BUDGET_INSTRUCTION.replace("{allowance}", String(allowanceTokens));
}

export type BudgetDelivery = "native-slot" | "appended";

export const BUDGET_DELIVERY: Record<StrategyId, BudgetDelivery> = {
  // pi owns its prompt; the budget arrives as customInstructions ("Additional focus: ...").
  "pi-native-cut": "appended",
  "pi-native-policy-preserving": "appended",
  "baseline-structured-summary": "appended",
  // Hermes binds {summary_budget}; ACON-utco binds {{ max_chars }}.
  "prompting-h": "native-slot",
  "acon-ut": "appended",
  "acon-utco": "native-slot",
  "trace-optimized": "appended",
  // Group C is out of scope for v1.4. Declared so the record is total and a later task adding
  // them has to choose deliberately rather than inherit a default.
  fifo: "appended",
  "lru-mechanism": "appended",
  "lru-prompting": "appended",
};
