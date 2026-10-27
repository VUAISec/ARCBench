/**
 * The v1.4 budget arithmetic, and the floor it runs into.
 *
 * The load-bearing case here is `channel`. Its floor (187) does NOT exceed the 200 rung, so a
 * feasibility rule keyed on `floor > budget` calls it fine -- while leaving the arm 13 tokens to
 * write a summary in. Feasibility and clampedness are different predicates, and the tests pin
 * both.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_SUMMARY_TOKENS,
  V14_BUDGET_LADDER,
  computeFloorTokens,
  resolveBudget,
  truncateToBudget,
} from "../src/compaction/budget.ts";
import type { CanonicalMessage } from "../src/harness/schema.ts";

const m = (entryId: string, role: CanonicalMessage["role"], content: string): CanonicalMessage => ({
  entryId,
  role,
  content,
});

describe("resolveBudget", () => {
  it("spends the budget down to the floor when there is room", () => {
    const b = resolveBudget(750, 106);
    expect(b.summaryAllowanceTokens).toBe(644);
    expect(b.feasible).toBe(true);
    expect(b.effectiveTokens).toBe(750);
  });

  it("clamps to MIN_SUMMARY_TOKENS when the floor exceeds the budget", () => {
    // `email`: floor 225 against the 200 rung.
    const b = resolveBudget(200, 225);
    expect(b.summaryAllowanceTokens).toBe(MIN_SUMMARY_TOKENS);
    expect(b.feasible).toBe(false);
    expect(b.effectiveTokens).toBe(225 + MIN_SUMMARY_TOKENS);
  });

  it("clamps when the floor fits but leaves too little to write with", () => {
    // `channel`: floor 187 is UNDER the 200 rung, so it is not infeasible in the
    // floor > budget sense -- but 13 tokens is not a summary. A rule keyed on
    // `floor > budget` alone misses this case.
    const b = resolveBudget(200, 187);
    expect(200 - 187).toBeLessThan(MIN_SUMMARY_TOKENS);
    expect(b.summaryAllowanceTokens).toBe(MIN_SUMMARY_TOKENS);
    expect(b.feasible).toBe(false);
  });

  it("is feasible exactly at the MIN_SUMMARY_TOKENS boundary", () => {
    const b = resolveBudget(200, 200 - MIN_SUMMARY_TOKENS);
    expect(b.summaryAllowanceTokens).toBe(MIN_SUMMARY_TOKENS);
    expect(b.feasible).toBe(true);
    expect(b.effectiveTokens).toBe(200);
  });

  it("rejects a budget that is not on the ladder", () => {
    // The message generalised when v1.5 gained its own ladder, but the guard did not move: with
    // no ladder declared, v1.4's is still the one enforced.
    expect(() => resolveBudget(999, 100)).toThrow(/not a declared budget rung/);
    expect(() => resolveBudget(999, 100)).toThrow(/200, 300, 750, 1200, 2500/);
    // A v1.5 rung is still rejected by default -- the default did not widen.
    expect(() => resolveBudget(450, 100)).toThrow(/not a declared budget rung/);
  });
});

describe("computeFloorTokens", () => {
  it("is the pinned task instruction plus the realized tail", () => {
    const messages = [
      m("policy", "user", "x".repeat(400)),
      m("task", "user", "y".repeat(80)),
      m("a1", "assistant", "z".repeat(400)),
      m("u2", "user", "w".repeat(120)),
      m("a2", "assistant", "v".repeat(120)),
    ];
    const floor = computeFloorTokens({
      messages,
      taskInstructionEntryId: "task",
      retainedTailTokens: 50,
    });
    // 80/4 = 20 for the instruction, plus whatever the tail came to.
    expect(floor).toBeGreaterThan(20);
    expect(Number.isInteger(floor)).toBe(true);
  });

  it("does not double-count an instruction that the cut already left in the tail", () => {
    const messages = [
      m("a0", "assistant", "q".repeat(400)),
      m("task", "user", "y".repeat(80)),
      m("a1", "assistant", "z".repeat(40)),
    ];
    const floor = computeFloorTokens({
      messages,
      taskInstructionEntryId: "task",
      retainedTailTokens: 500, // forces the largest tail, which contains `task`
    });
    const tailOnly = computeFloorTokens({
      messages,
      taskInstructionEntryId: "nonexistent",
      retainedTailTokens: 500,
    });
    expect(floor).toBe(tailOnly);
  });
});

describe("truncateToBudget", () => {
  it("leaves text that already fits", () => {
    const r = truncateToBudget("short summary", 64);
    expect(r.text).toBe("short summary");
    expect(r.truncated).toBe(false);
    expect(r.charsRemoved).toBe(0);
  });

  it("cuts to exactly allowance x 4 characters", () => {
    // chars/4 is `estimateTokens`' convention, so the cut text scores at the allowance in the
    // same units the budget, the floor and tokensAfter are all expressed in.
    const r = truncateToBudget("x".repeat(1000), 64);
    expect(r.text).toHaveLength(256);
    expect(r.truncated).toBe(true);
    expect(r.charsRemoved).toBe(744);
  });

  it("cuts mid-word rather than at a boundary", () => {
    // A hard cap is a hard cap. Backing off to a word boundary would make the realized size vary
    // by wherever the nearest space happened to fall, so the cap would stop being one number.
    const r = truncateToBudget("aaaa bbbb cccc dddd", 2);
    expect(r.text).toBe("aaaa bbb");
  });

  it("rejects a non-positive allowance", () => {
    expect(() => truncateToBudget("x", 0)).toThrow(/positive/);
  });
});

describe("V14_BUDGET_LADDER", () => {
  it("is the five rungs the spec fixes, ascending", () => {
    expect([...V14_BUDGET_LADDER]).toEqual([200, 300, 750, 1200, 2500]);
  });
});
