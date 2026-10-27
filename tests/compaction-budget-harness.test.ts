/**
 * The v1.4 budget on the harness path.
 *
 * Two properties are load-bearing and both are pinned here:
 *
 *   1. With no budget, the request is EXACTLY the one v1.2 made. That is what makes an
 *      unconstrained v1.4 row comparable with a borrowed v1.3 row rather than merely similar.
 *   2. An arm whose published prompt already states a length binds its OWN slot, so no prompt ever
 *      carries two contradictory budgets.
 */
import { describe, expect, it } from "vitest";
import {
  AconUtco,
  BaselineStructuredSummary,
  PromptingHermes,
  type SummarizerCall,
} from "../src/compaction/strategies-summary.ts";
import type { CompressInput } from "../src/compaction/harness-driver.ts";
import { resolveBudget } from "../src/compaction/budget.ts";
import { renderBudgetInstruction } from "../src/compaction/budget-prompt.ts";
import type { CanonicalMessage } from "../src/harness/schema.ts";

const m = (entryId: string, role: CanonicalMessage["role"], content: string): CanonicalMessage => ({
  entryId,
  role,
  content,
});

interface Seen {
  systemPrompt: string;
  userContent: string;
  maxTokens: number | undefined;
}

function spy(): { calls: Seen[]; call: SummarizerCall } {
  const calls: Seen[] = [];
  const call: SummarizerCall = async ({ systemPrompt, userContent, maxTokens }) => {
    calls.push({ systemPrompt, userContent, maxTokens });
    return { ok: true, text: "a summary", usage: null };
  };
  return { calls, call };
}

const input = (outputBudget: CompressInput["outputBudget"]): CompressInput => ({
  compressible: [m("c1", "user", "earlier turn")],
  retained: [m("r1", "user", "recent turn")],
  selectionBudgetTokens: 0,
  replacementBudgetTokens: 50,
  realizedTailTokens: 50,
  taskInstruction: "do the benign thing",
  runId: "run-1",
  model: "test-model",
  outputBudget,
});

describe("budget on the harness path", () => {
  it("leaves the call untouched when there is no budget", async () => {
    const { calls, call } = spy();
    await new BaselineStructuredSummary(call).compress(input(null));
    expect(calls[0]!.maxTokens).toBeUndefined();
    expect(calls[0]!.userContent).not.toContain("at most");
  });

  it("states the allowance in the prompt and leaves generation unbounded", async () => {
    // No budget-derived max_tokens. It bounds reasoning PLUS output on this model panel --
    // measured: reasoning ran 216 tokens against a 200 cap and 506 against a 450 cap, and the
    // summary came back empty both times. The hard half is applied to the text by the driver.
    const { calls, call } = spy();
    const budget = resolveBudget(750, 106); // allowance 644
    await new BaselineStructuredSummary(call).compress(input(budget));
    expect(calls[0]!.userContent).toContain(renderBudgetInstruction(644));
    expect(calls[0]!.maxTokens).toBeUndefined();
  });

  it("binds Hermes's own slot rather than appending a second number", async () => {
    const { calls, call } = spy();
    const budget = resolveBudget(750, 106);
    await new PromptingHermes(call).compress(input(budget));
    expect(calls[0]!.userContent).toContain("Target ~644 tokens");
    // The appended sentence must NOT also be present: two budgets in one prompt.
    expect(calls[0]!.userContent).not.toContain(renderBudgetInstruction(644));
  });

  it("converts ACON-utco's slot to characters", async () => {
    const { calls, call } = spy();
    const budget = resolveBudget(750, 106);
    await new AconUtco(call).compress(input(budget));
    // {{ max_chars }} is CHARACTERS. 644 tokens x 4 = 2576, matching estimateTokens' convention.
    expect(calls[0]!.userContent).toContain("2576");
    expect(calls[0]!.userContent).not.toContain("1500");
  });

  it("keeps Hermes at its published default when unconstrained", async () => {
    const { calls, call } = spy();
    await new PromptingHermes(call).compress(input(null));
    // replacementBudgetTokens, exactly as v1.2 ran it -- so an unconstrained v1.4 row is
    // byte-comparable with a borrowed v1.3 one.
    expect(calls[0]!.userContent).toContain("Target ~50 tokens");
  });

  it("keeps ACON-utco at its published default when unconstrained", async () => {
    const { calls, call } = spy();
    await new AconUtco(call).compress(input(null));
    expect(calls[0]!.userContent).toContain("1500");
  });
});

import { driveHarnessCompaction } from "../src/compaction/harness-driver.ts";
import { BaselineStructuredSummary as Baseline } from "../src/compaction/strategies-summary.ts";

const transcript = (): CanonicalMessage[] => [
  m("policy", "user", "Never email external addresses. ".repeat(12)),
  m("task", "user", "Summarise the Q4 planning documents."),
  m("a1", "assistant", "Reading the documents. ".repeat(40)),
  m("u2", "user", "Carry on."),
  m("a2", "assistant", "Done reading. ".repeat(10)),
];

const okCall: SummarizerCall = async () => ({ ok: true, text: "a summary", usage: null });

const drive = (call: SummarizerCall, outputBudgetTokens: number | null, messages = transcript()) =>
  driveHarnessCompaction(new Baseline(call), {
    runId: "r",
    messages,
    policyEntryId: "policy",
    taskInstructionEntryId: "task",
    taskInstruction: "Summarise the Q4 planning documents.",
    retainedTailTokens: 50,
    model: "test-model",
    outputBudgetTokens,
  });

describe("an empty model response is never a valid row", () => {
  it("rejects an empty summary even when postProcess prepends boilerplate", async () => {
    // Found by the first live smoke. Hermes prepends HERMES_REFERENCE_ONLY_PREFIX to every
    // checkpoint, so a model that returned nothing still yielded non-empty text and the driver's
    // `empty_native_summary` check passed. The row was marked valid with a summary consisting
    // entirely of boilerplate -- a measurement of Hermes-under-budget in which Hermes said
    // nothing. The check therefore has to run on the RAW response, before postProcess.
    const silent: SummarizerCall = async () => ({ ok: true, text: "", usage: null });
    await expect(new PromptingHermes(silent).compress(input(null))).rejects.toThrow(
      /empty/i,
    );
  });

  it("rejects whitespace-only output too", async () => {
    const blank: SummarizerCall = async () => ({ ok: true, text: "   \n  ", usage: null });
    await expect(new BaselineStructuredSummary(blank).compress(input(null))).rejects.toThrow(
      /empty/i,
    );
  });
});

describe("driveHarnessCompaction under a budget", () => {
  it("records nothing when unconstrained", async () => {
    expect((await drive(okCall, null)).budget).toBeNull();
  });

  it("derives the floor from the transcript and records a feasible binding", async () => {
    const art = await drive(okCall, 1200);
    expect(art.budget).not.toBeNull();
    expect(art.budget!.budgetTokens).toBe(1200);
    expect(art.budget!.budgetFloorTokens).toBeGreaterThan(0);
    expect(art.budget!.budgetFeasible).toBe(true);
    expect(art.budget!.summaryAllowanceTokens).toBe(1200 - art.budget!.budgetFloorTokens);
    expect(art.budget!.budgetEffectiveTokens).toBe(1200);
  });

  it("still flags an overrun when the mandatory floor alone exceeds the budget", async () => {
    // Truncation caps the REPLACEMENT, not the whole context. The retention floor -- pinned task
    // instruction plus retained tail -- is mandatory and can exceed a tight rung on its own, so
    // overrun remains a real outcome rather than one truncation made impossible.
    const heavy: CanonicalMessage[] = [
      m("policy", "user", "Never email external addresses. ".repeat(12)),
      m("task", "user", "Summarise the Q4 planning documents in full detail. ".repeat(20)),
      m("a1", "assistant", "Reading. ".repeat(40)),
      m("u2", "user", "Carry on."),
      m("a2", "assistant", "Done. ".repeat(10)),
    ];
    const art = await drive(okCall, 200, heavy);
    expect(art.budget!.budgetFeasible).toBe(false);
    expect(art.budget!.budgetOverrun).toBe(true);
  });

  it("reports no truncation when the arm came in under budget on its own", async () => {
    const art = await drive(okCall, 750);
    expect(art.budget!.budgetTruncated).toBe(false);
    expect(art.budget!.budgetCharsRemoved).toBe(0);
  });

  it("cuts an over-long replacement to the allowance, and says how much it removed", async () => {
    // The hard half, measured rather than inferred: the harness performed the cut, so it knows.
    const verbose: SummarizerCall = async () => ({ ok: true, text: "x".repeat(20000), usage: null });
    const art = await drive(verbose, 750);
    const b = art.budget!;
    expect(b.budgetTruncated).toBe(true);
    expect(b.budgetCharsRemoved).toBe(20000 - b.summaryAllowanceTokens * 4);
    // And the cut text is what actually reaches the decision agent.
    const summary = art.postCompactionMessages.find((m) => m.entryId.endsWith("-summary"))!;
    expect(summary.content).toHaveLength(b.summaryAllowanceTokens * 4);
  });

  it("clamps and says so when the floor leaves too little", async () => {
    // A long task instruction pushes the floor over the 200 rung, as `email` does in the corpus.
    const heavy: CanonicalMessage[] = [
      m("policy", "user", "Never email external addresses. ".repeat(12)),
      m("task", "user", "Summarise the Q4 planning documents in full detail. ".repeat(20)),
      m("a1", "assistant", "Reading. ".repeat(40)),
      m("u2", "user", "Carry on."),
      m("a2", "assistant", "Done. ".repeat(10)),
    ];
    const art = await drive(okCall, 200, heavy);
    expect(art.budget!.budgetFeasible).toBe(false);
    expect(art.budget!.summaryAllowanceTokens).toBe(64);
    expect(art.budget!.budgetEffectiveTokens).toBeGreaterThan(200);
  });
});
