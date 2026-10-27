/**
 * The v1.4 budget on pi's own session path.
 *
 * pi needs no new request field -- `summarizerMaxTokens` is already the binding cap on its
 * summarizer output and `customInstructions` is already the frozen string it appends as
 * "Additional focus: ...". The consequence is the interesting part: supplying customInstructions
 * is exactly what makes `pi-native-policy-preserving` a MODIFIED arm, so a constrained
 * `pi-native-cut` is modified on the same grounds and must stop claiming to be native.
 */
import { describe, expect, it } from "vitest";
import {
  piBudgetRequestFields,
  piNativeImplementation,
  resolveBudget,
} from "../src/compaction/budget.ts";
import { POLICY_PRESERVING_INSTRUCTION } from "../src/compaction/prompts.ts";
import { renderBudgetInstruction } from "../src/compaction/budget-prompt.ts";

describe("piBudgetRequestFields", () => {
  it("is empty when unconstrained, so pi runs exactly as v1.2 ran it", () => {
    expect(piBudgetRequestFields("pi-native-cut", null, 16384)).toEqual({
      summarizerMaxTokens: 16384,
    });
  });

  it("keeps the policy-preserving instruction alone when unconstrained", () => {
    expect(piBudgetRequestFields("pi-native-policy-preserving", null, 16384)).toEqual({
      summarizerMaxTokens: 16384,
      customInstructions: POLICY_PRESERVING_INSTRUCTION,
    });
  });

  it("states the allowance to pi and leaves its generation ceiling alone", () => {
    // summarizerMaxTokens is NOT set from the budget. On this model panel max_tokens bounds
    // reasoning plus output, and reasoning alone exceeds every rung -- pi reported
    // "generation hit the token cap and the summary is incomplete" on every constrained row.
    // The ceiling stands for constrained and unconstrained alike, so pi generates identically
    // either way, and the runner cuts the summary afterwards.
    const b = resolveBudget(750, 106); // allowance 644
    const f = piBudgetRequestFields("pi-native-cut", b, 16384);
    expect(f.summarizerMaxTokens).toBe(16384);
    expect(f.customInstructions).toBe(renderBudgetInstruction(644));
  });

  it("appends the budget after the policy-preserving instruction, not instead of it", () => {
    const b = resolveBudget(750, 106);
    const f = piBudgetRequestFields("pi-native-policy-preserving", b, 16384);
    expect(f.customInstructions).toContain(POLICY_PRESERVING_INSTRUCTION);
    expect(f.customInstructions).toContain(renderBudgetInstruction(644));
    expect(f.customInstructions!.indexOf(POLICY_PRESERVING_INSTRUCTION)).toBeLessThan(
      f.customInstructions!.indexOf(renderBudgetInstruction(644)),
    );
  });
});

describe("piNativeImplementation", () => {
  it("is true only for an unconstrained pi-native-cut", () => {
    expect(piNativeImplementation("pi-native-cut", null)).toBe(true);
  });

  it("is false once a budget adds customInstructions", () => {
    // Supplying customInstructions is exactly what makes policy-preserving a MODIFIED arm.
    // Keeping the native label here would attribute a result to pi's shipped behaviour that
    // pi's shipped behaviour did not produce.
    expect(piNativeImplementation("pi-native-cut", resolveBudget(300, 106))).toBe(false);
  });

  it("is false for the policy-preserving arm either way", () => {
    expect(piNativeImplementation("pi-native-policy-preserving", null)).toBe(false);
  });
});
