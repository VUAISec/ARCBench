/**
 * The Group C arms on the REAL fixtures, at the configured allowance.
 *
 * This file exists because of a lesson this repo has already paid for once: a green suite is not
 * evidence that the shipped path works. The unit tests in `compaction-mechanism.test.ts` run on a
 * synthetic transcript with a 44-character policy, and they passed throughout the period when the
 * allowance was smaller than every real policy and no arm could retain one. Nothing in them could
 * have caught that, because the number that was wrong lived in the config (`config/benchmark.json`)
 * and the fixture they used was not the fixture the sweep ran.
 *
 * So these assertions are made against `data/rule-loss/cases.jsonl`, the real config, and the
 * real condition builder. Nothing here touches a network: the only model call in Group C is
 * `lru-prompting`'s ranker, which is stubbed.
 */
import { describe, expect, it } from "vitest";
import { loadMvpConfig } from "../src/config/config.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import { buildConditionV12 } from "../src/context/transcript-v12.ts";
import type { ConditionSpec } from "../src/plan/spec.ts";
import { compactionSettings, selectionBudgetFor } from "../src/config/config.ts";
import { driveHarnessCompaction } from "../src/compaction/harness-driver.ts";
import { FifoStrategy, LruMechanismStrategy } from "../src/compaction/strategies-mechanism.ts";
import { LruPromptingStrategy, type SummarizerCall } from "../src/compaction/strategies-summary.ts";
import { estimateTokens } from "../src/compaction/boundary.ts";
import type { CompactionArtifact } from "../src/harness/schema.ts";

const cfg = loadMvpConfig();
const settings = compactionSettings(cfg);
const rows = loadTaskRows("data/rule-loss/cases.jsonl");

const SPEC: ConditionSpec = {
  policyPresent: true,
  fillerPresent: false,
  attackPresent: false,
  contextHandling: "compacted",
  compactionStrategy: "fifo",
  compactionBackend: "harness",
  haystackArm: null,
  attackInsertion: "after-benign-block-1",
  policyChannel: "c1",
  protocolVersion: "v1.2",
  legacyLabel: null,
};

/** The ranker, stubbed to name the policy first — the modal real behaviour (195/432 cohort-b). */
const rankPolicyFirst =
  (policyIndex: () => number): SummarizerCall =>
  async () => ({ ok: true, text: `${policyIndex()}`, usage: null });

async function runArm(
  taskId: string,
  arm: "fifo" | "lru-mechanism" | "lru-prompting",
  budget: number,
): Promise<CompactionArtifact> {
  const row = rows.find((r) => r.id === taskId)!;
  const built = buildConditionV12({ row, spec: { ...SPEC, compactionStrategy: arm }, repetition: 0, cfg });
  let policyIndex = 0;
  const strategy =
    arm === "fifo"
      ? new FifoStrategy()
      : arm === "lru-mechanism"
        ? new LruMechanismStrategy()
        : new LruPromptingStrategy(rankPolicyFirst(() => policyIndex));
  // The ranker indexes the compressible list, which excludes the pinned task instruction.
  const prefix = built.messages.slice(0, -1);
  policyIndex = Math.max(
    0,
    prefix.filter((m) => m.entryId !== built.taskInstructionEntryId)
      .findIndex((m) => m.entryId === built.policyEntryId),
  );
  return driveHarnessCompaction(strategy, {
    runId: `fixture-${taskId}-${arm}`,
    messages: built.messages,
    policyEntryId: built.policyEntryId,
    taskInstructionEntryId: built.taskInstructionEntryId,
    taskInstruction: built.taskInstruction,
    retainedTailTokens: settings.harnessBoundary.retainedTailTokens,
    selectionBudgetTokens: budget,
    model: "test-model",
  });
}

const ARMS = ["fifo", "lru-mechanism", "lru-prompting"] as const;

describe("the configured allowance clears every real policy", () => {
  it("is larger than the largest policy in the fixture", () => {
    // The v1.2 failure in one assertion. 50 < 71 made `dropped` unavoidable on all 1,674 rows;
    // if this ever regresses, every Group C number silently becomes arithmetic again.
    const budget = selectionBudgetFor(settings, "lru-mechanism");
    const largest = Math.max(...rows.map((r) => estimateTokens([{ entryId: "p", role: "user", content: r.policy }])));
    expect(largest).toBeGreaterThan(50); // the v1.2 allowance really was infeasible
    expect(budget).toBeGreaterThanOrEqual(largest);
  });

  it("gives every select arm the same allowance", () => {
    const budgets = new Set(ARMS.map((a) => selectionBudgetFor(settings, a)));
    expect(budgets.size).toBe(1);
  });
});

describe.each(rows.map((r) => r.id))("%s", (taskId) => {
  it("no longer reports the policy as budget-ineligible for any arm", async () => {
    for (const arm of ARMS) {
      const art = await runArm(taskId, arm, selectionBudgetFor(settings, arm));
      expect(art.selection!.policyOutcome, `${taskId}/${arm}`).not.toBe("budget_ineligible");
    }
  });

  it("keeps the policy when the ranker asks for it", async () => {
    // The claim the v1.2 design could not test: given the room, does naming the rule retain it?
    const art = await runArm(taskId, "lru-prompting", selectionBudgetFor(settings, "lru-prompting"));
    expect(art.selection!.policyOutcome).toBe("kept");
    expect(art.policyLocation).toBe("retained_tail");
    expect(art.postCompactionMessages.some((m) => m.entryId === art.selection!.selectedEntryIds[0])).toBe(true);
  });

  /**
   * The v1.2 allowance of 50 tokens was smaller than every policy the cohort ran, which is why
   * all 1,674 rows came back `dropped`. Stated as the mechanism rather than as a blanket verdict:
   * v1.3's personal policies are one-liners that genuinely fit in 50 tokens, and asserting
   * `budget_ineligible` for those would assert something false about the arithmetic.
   */
  it("at the v1.2 allowance, a policy larger than the allowance is ineligible and one that fits is not", async () => {
    const row = rows.find((r) => r.id === taskId)!;
    const policyTokens = estimateTokens([{ entryId: "p", role: "user", content: row.policy }]);
    const oversized = policyTokens > 50;
    for (const arm of ARMS) {
      const art = await runArm(taskId, arm, 50);
      if (oversized) {
        expect(art.selection!.policyOutcome, `${taskId}/${arm}`).toBe("budget_ineligible");
        expect(art.policyLocation).toBe("dropped");
      } else {
        expect(art.selection!.policyOutcome, `${taskId}/${arm}`).not.toBe("budget_ineligible");
      }
    }
  });

  it("every policy the v1.2 cohort actually ran was oversized at 50 tokens", () => {
    // The claim above only explains the recorded rows if this holds for the nine cases they used.
    const v12 = loadTaskRows("data/rule-loss/cases-v1.2-9.jsonl");
    for (const row of v12) {
      expect(
        estimateTokens([{ entryId: "p", role: "user", content: row.policy }]),
        row.id,
      ).toBeGreaterThan(50);
    }
  });

  it("holds every arm to the allowance it was given", async () => {
    // `lru-prompting` overran on 253/432 cohort-b rows because it charged only message content.
    const budget = selectionBudgetFor(settings, "fifo");
    for (const arm of ARMS) {
      const art = await runArm(taskId, arm, budget);
      expect(art.selection!.selectedTokens, `${taskId}/${arm}`).toBeLessThanOrEqual(budget);
    }
  });

  it("emits no tool result whose declaring call is absent", async () => {
    const budget = selectionBudgetFor(settings, "fifo");
    for (const arm of ARMS) {
      const art = await runArm(taskId, arm, budget);
      const declared = new Set(art.postCompactionMessages.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
      for (const m of art.postCompactionMessages) {
        if (m.role === "tool") expect(declared.has(m.toolCallId!), `${taskId}/${arm}`).toBe(true);
      }
    }
  });
});
