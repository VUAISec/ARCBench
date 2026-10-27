/**
 * The v1.4 budget instruction, and how it reaches each arm.
 *
 * The test that matters most is the negative one: the sentence must say how LONG and never what to
 * KEEP. A content hint would make all seven constrained arms partly policy-preserving, which is
 * the one intervention `pi-native-policy-preserving` exists to isolate.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BUDGET_DELIVERY,
  V14_BUDGET_INSTRUCTION,
  renderBudgetInstruction,
} from "../src/compaction/budget-prompt.ts";
import { STRATEGY_IDS } from "../src/compaction/strategy-ids.ts";
import {
  ACON_UTCO_GUIDELINE,
  BASELINE_SYSTEM_PROMPT,
  HERMES_TEMPLATE,
  TRACE_OPTIMIZED_UPDATE_PROMPT,
} from "../src/compaction/prompts.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("V14_BUDGET_INSTRUCTION", () => {
  it("is frozen", () => {
    // Regenerate deliberately if the wording is revised, and start a new configCohort when you do.
    expect(sha(V14_BUDGET_INSTRUCTION)).toBe(
      sha("Your entire response must be at most {allowance} tokens. Do not exceed it."),
    );
  });

  it("says how long and never what to keep", () => {
    for (const banned of ["rule", "policy", "constraint", "obligation", "prohibit", "prefer"]) {
      expect(V14_BUDGET_INSTRUCTION.toLowerCase()).not.toContain(banned);
    }
  });

  it("binds the allowance", () => {
    expect(renderBudgetInstruction(644)).toBe(
      "Your entire response must be at most 644 tokens. Do not exceed it.",
    );
    expect(renderBudgetInstruction(644)).not.toContain("{allowance}");
  });

  it("rejects a non-positive allowance", () => {
    expect(() => renderBudgetInstruction(0)).toThrow(/positive/);
  });
});

describe("BUDGET_DELIVERY", () => {
  it("covers every strategy id", () => {
    for (const id of STRATEGY_IDS) expect(BUDGET_DELIVERY[id]).toBeDefined();
  });

  it("uses a published slot where one exists and appends where none does", () => {
    // Load-bearing: prompting-h and acon-utco already state a length in their upstream prompts.
    // Appending a second, different length would put two contradictory budgets in one prompt.
    expect(HERMES_TEMPLATE).toContain("{summary_budget}");
    expect(ACON_UTCO_GUIDELINE).toContain("{{ max_chars }}");
    expect(BUDGET_DELIVERY["prompting-h"]).toBe("native-slot");
    expect(BUDGET_DELIVERY["acon-utco"]).toBe("native-slot");

    // These three carry no length instruction at all, so the sentence is appended.
    expect(BASELINE_SYSTEM_PROMPT).not.toContain("{summary_budget}");
    expect(TRACE_OPTIMIZED_UPDATE_PROMPT).not.toContain("{{ max_chars }}");
    expect(BUDGET_DELIVERY["baseline-structured-summary"]).toBe("appended");
    expect(BUDGET_DELIVERY["acon-ut"]).toBe("appended");
    expect(BUDGET_DELIVERY["trace-optimized"]).toBe("appended");

    // pi owns its prompt; the budget reaches it through customInstructions.
    expect(BUDGET_DELIVERY["pi-native-cut"]).toBe("appended");
    expect(BUDGET_DELIVERY["pi-native-policy-preserving"]).toBe("appended");
  });
});
