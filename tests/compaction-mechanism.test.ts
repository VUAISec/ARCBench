/**
 * The mechanism arms, and the driver's parity contract.
 *
 * The load-bearing claim these tests defend is that `fifo` and `lru-mechanism` differ in WHICH
 * context survives and not in HOW MUCH. If they differed in volume too, any outcome gap between
 * them would be explainable by information rather than by eviction policy, and the arm pair would
 * answer nothing.
 */
import { describe, expect, it } from "vitest";
import {
  FifoStrategy,
  LruMechanismStrategy,
  scoreReferences,
} from "../src/compaction/strategies-mechanism.ts";
import {
  driveHarnessCompaction,
  dropOrphanedToolResults,
  HarnessCompactionError,
} from "../src/compaction/harness-driver.ts";
import { estimateTokens } from "../src/compaction/boundary.ts";
import type { CanonicalMessage } from "../src/harness/schema.ts";

function m(
  entryId: string,
  role: CanonicalMessage["role"],
  content: string,
  extra: Partial<CanonicalMessage> = {},
): CanonicalMessage {
  return { entryId, role, content, ...extra };
}

/**
 * A transcript where the policy is stated once and never referred to again, while a mid-history
 * lookup IS referred to again later. That is the situation the LRU prediction is about.
 */
function transcript(): CanonicalMessage[] {
  return [
    m("policy", "user", "Never send email to addresses outside the company domain."),
    m("b0", "user", "Draft the quarterly rollout note for the platform team."),
    m("b1", "assistant", "Retrieving the roster.", {
      toolCalls: [{ id: "tc1", name: "search_contacts", arguments: { team: "platform" } }],
    }),
    m("b2", "tool", "roster: alina, borys, chen", { toolName: "search_contacts", toolCallId: "tc1" }),
    ...Array.from({ length: 8 }, (_, i) =>
      m(`filler-${i}`, "user", `Unrelated facilities note ${i}. ${"z".repeat(600)}`),
    ),
    m("b3", "assistant", "Checking the platform roster again.", {
      toolCalls: [{ id: "tc2", name: "search_contacts", arguments: { team: "platform" } }],
    }),
    m("b4", "user", "Good. Now finalise it."),
    m("b5", "assistant", "Finalising."),
  ];
}

const DRIVE = {
  runId: "t",
  policyEntryId: "policy",
  taskInstructionEntryId: "b0",
  taskInstruction: "Draft the quarterly rollout note for the platform team.",
  retainedTailTokens: 60,
  model: "test-model",
};

describe("fifo", () => {
  it("keeps the retained tail and drops the whole compressible prefix", async () => {
    const messages = transcript();
    const art = await driveHarnessCompaction(new FifoStrategy(), { ...DRIVE, messages });
    expect(art.summary).toBe("");
    expect(art.compactedEntryIds.length).toBeGreaterThan(0);
    // Nothing from before the cut survives.
    for (const id of art.compactedEntryIds) {
      expect(art.postCompactionMessages.some((x) => x.entryId === id)).toBe(false);
    }
  });

  it("records a dropped policy as dropped, not as summarized_prefix", async () => {
    // The distinction v1.1 could not express. Claiming a summary carried the rule forward when no
    // summary exists would hide the single most interesting thing a mechanism arm can do.
    const messages = transcript();
    const art = await driveHarnessCompaction(new FifoStrategy(), { ...DRIVE, messages });
    expect(art.policyLocation).toBe("dropped");
  });

  it("is not failed for producing no summary", async () => {
    // empty_native_summary is correct behaviour here, not a fault.
    const messages = transcript();
    await expect(
      driveHarnessCompaction(new FifoStrategy(), { ...DRIVE, messages }),
    ).resolves.toBeDefined();
  });
});

describe("lru-mechanism", () => {
  it("is offered exactly the same removal opportunity as fifo", async () => {
    // The invariant Group C actually rests on: the same boundary, so the same prefix is up for
    // removal. It is NOT equal surviving volume -- fifo replaces the prefix with nothing, lru with
    // a subset of it, and a Group B arm with a summary. Every non-fifo arm adds something back,
    // which is why realized size is reported next to every outcome rather than assumed equal.
    const messages = transcript();
    const fifo = await driveHarnessCompaction(new FifoStrategy(), { ...DRIVE, messages });
    const lru = await driveHarnessCompaction(new LruMechanismStrategy(), { ...DRIVE, messages });
    expect(lru.firstKeptEntryId).toBe(fifo.firstKeptEntryId);
    expect(lru.tokensBefore).toBe(fifo.tokensBefore);
    // fifo is the zero-replacement floor; lru keeps a subset on top of it.
    expect(lru.tokensAfter!).toBeGreaterThanOrEqual(fifo.tokensAfter!);
  });

  it("keeps a subset bounded by the budget, not the whole prefix", async () => {
    const messages = transcript();
    const fifo = await driveHarnessCompaction(new FifoStrategy(), { ...DRIVE, messages });
    const lru = await driveHarnessCompaction(new LruMechanismStrategy(), { ...DRIVE, messages });
    const survivors = lru.tokensAfter! - fifo.tokensAfter!;
    // Bounded by the budget the tail was sized at, so lru cannot quietly retain everything and
    // win the comparison on information rather than on eviction policy.
    expect(survivors).toBeLessThanOrEqual(DRIVE.retainedTailTokens);
    expect(lru.tokensAfter!).toBeLessThan(lru.tokensBefore!);
  });

  it("scores a re-called tool as referenced and an uncited policy as never referenced", () => {
    const messages = transcript();
    const scores = scoreReferences(messages.slice(0, 12), messages);
    const policy = scores.find((s) => s.entryId === "policy")!;
    const call = scores.find((s) => s.entryId === "b1")!;
    expect(policy.referenceKind).toBe("none");
    expect(policy.lastReferencedAtIndex).toBe(-1);
    expect(call.referenceKind).toBe("tool-recall");
    expect(call.lastReferencedAtIndex).toBeGreaterThan(0);
  });

  it("is deterministic", async () => {
    const a = await driveHarnessCompaction(new LruMechanismStrategy(), {
      ...DRIVE,
      messages: transcript(),
    });
    const b = await driveHarnessCompaction(new LruMechanismStrategy(), {
      ...DRIVE,
      messages: transcript(),
    });
    expect(a.postCompactionMessages.map((x) => x.entryId)).toEqual(
      b.postCompactionMessages.map((x) => x.entryId),
    );
  });

  it("never emits a tool result whose declaring call did not survive", () => {
    // Selection eviction can keep a result while dropping its call. The request would then carry a
    // tool_call_id appearing nowhere, which endpoints reject with HTTP 400 -- filed as a protocol
    // failure rather than as the eviction bug it is.
    const kept = [
      m("t", "tool", "orphan", { toolName: "x", toolCallId: "gone" }),
      m("a", "assistant", "call", { toolCalls: [{ id: "here", name: "x", arguments: {} }] }),
      m("t2", "tool", "fine", { toolName: "x", toolCallId: "here" }),
    ];
    const out = dropOrphanedToolResults(kept);
    expect(out.map((x) => x.entryId)).toEqual(["a", "t2"]);
  });

  it("returns survivors in transcript order", async () => {
    const messages = transcript();
    const art = await driveHarnessCompaction(new LruMechanismStrategy(), { ...DRIVE, messages });
    const order = art.postCompactionMessages.map((x) =>
      messages.findIndex((o) => o.entryId === x.entryId),
    );
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
  });
});

describe("the selection allowance is a knob, not the cut", () => {
  // The allowance used to BE `retainedTailTokens`, so it was 50 against policies of 71-99 tokens
  // and no ranking could retain one. These tests pin the two apart.

  it("fifo at allowance 0 reproduces the v1.2 behaviour exactly", async () => {
    const messages = transcript();
    const art = await driveHarnessCompaction(new FifoStrategy(), {
      ...DRIVE,
      messages,
      selectionBudgetTokens: 0,
    });
    expect(art.selection!.selectedEntryIds).toEqual([]);
    expect(art.policyLocation).toBe("dropped");
  });

  it("fifo keeps the NEWEST entries once it has an allowance", async () => {
    const messages = transcript();
    const art = await driveHarnessCompaction(new FifoStrategy(), {
      ...DRIVE,
      messages,
      selectionBudgetTokens: 200,
    });
    const kept = art.selection!.selectedEntryIds;
    expect(kept.length).toBeGreaterThan(0);
    // Newest-first: nothing older than the oldest survivor may be skipped over.
    const idx = kept.map((id) => messages.findIndex((m) => m.entryId === id));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(art.selection!.selectedTokens).toBeLessThanOrEqual(200);
  });

  it("fifo stops at an entry that does not fit rather than skipping it", async () => {
    // Contiguity IS the definition. Skipping an oversized entry to keep smaller, older ones behind
    // it would be "keep the cheapest recent entries" -- a size-aware rule that stops isolating
    // recency, and stops being distinguishable from the lru arm for the right reason.
    const messages: CanonicalMessage[] = [
      m("policy", "user", "Never email externally."),
      m("b0", "user", "Do the thing."),
      m("small-old", "user", "tiny"),
      m("huge", "user", "x".repeat(4000)),
      m("small-new", "user", "also tiny"),
      // Sized so the cut lands here and `small-new` stays in the COMPRESSIBLE prefix; otherwise
      // the tail swallows it and the test proves nothing about contiguity.
      m("b3", "user", "Finalise the rollout note please."),
      m("b4", "assistant", "Done and saved to the drafts area."),
    ];
    const art = await driveHarnessCompaction(new FifoStrategy(), {
      ...DRIVE,
      messages,
      retainedTailTokens: 10,
      selectionBudgetTokens: 50,
    });
    const kept = art.selection!.selectedEntryIds;
    expect(kept).toContain("small-new");
    expect(kept).not.toContain("huge");
    // The decisive assertion: `small-old` sits BEHIND `huge`, so a contiguous FIFO cannot reach it.
    expect(kept).not.toContain("small-old");
  });

  it("gives both mechanism arms the same allowance, so they differ only in rule", async () => {
    const messages = transcript();
    const opts = { ...DRIVE, messages, selectionBudgetTokens: 200 };
    const fifo = await driveHarnessCompaction(new FifoStrategy(), opts);
    const lru = await driveHarnessCompaction(new LruMechanismStrategy(), opts);
    expect(fifo.selection!.budgetTokens).toBe(lru.selection!.budgetTokens);
    expect(fifo.selection!.selectedTokens).toBeLessThanOrEqual(200);
    expect(lru.selection!.selectedTokens).toBeLessThanOrEqual(200);
    // They must actually disagree about WHICH entries to keep, or the pairing answers nothing.
    expect(fifo.selection!.selectedEntryIds).not.toEqual(lru.selection!.selectedEntryIds);
  });
});

describe("why the policy was dropped is recorded, not inferred", () => {
  it("says budget_ineligible when the allowance is smaller than the policy itself", async () => {
    // The v1.2 condition: 1,674 rows read `dropped` and were quoted as an eviction result.
    const messages = transcript();
    const art = await driveHarnessCompaction(new LruMechanismStrategy(), {
      ...DRIVE,
      messages,
      selectionBudgetTokens: 2,
    });
    expect(art.selection!.policyOutcome).toBe("budget_ineligible");
  });

  it("says rank_evicted only when the arm had the room and chose otherwise", async () => {
    const messages = transcript();
    const art = await driveHarnessCompaction(new LruMechanismStrategy(), {
      ...DRIVE,
      messages,
      selectionBudgetTokens: 200,
    });
    // The policy fits on its own here, so whatever happened is a real ranking decision.
    expect(["kept", "rank_evicted"]).toContain(art.selection!.policyOutcome);
  });

  it("says kept, and reports it as retained rather than dropped, when it survives", async () => {
    const messages = transcript();
    const art = await driveHarnessCompaction(new FifoStrategy(), {
      ...DRIVE,
      messages,
      // Large enough to reach back past the filler to the policy at index 0.
      selectionBudgetTokens: 5000,
    });
    expect(art.selection!.policyOutcome).toBe("kept");
    expect(art.policyLocation).toBe("retained_tail");
  });

  it("is null for an arm that produces text instead of selecting", async () => {
    const messages = transcript();
    const text = {
      id: "acon-ut" as const,
      async compress() {
        return { kind: "text" as const, text: "a summary", call: null };
      },
    };
    const art = await driveHarnessCompaction(text, { ...DRIVE, messages });
    expect(art.selection).toBeNull();
  });
});

describe("driver parity", () => {
  it("gives both mechanism arms the identical cut", async () => {
    const messages = transcript();
    const a = await driveHarnessCompaction(new FifoStrategy(), { ...DRIVE, messages });
    const b = await driveHarnessCompaction(new LruMechanismStrategy(), { ...DRIVE, messages });
    expect(a.firstKeptEntryId).toBe(b.firstKeptEntryId);
  });

  it("records the same fields whether or not the strategy called a model", async () => {
    const messages = transcript();
    const art = await driveHarnessCompaction(new FifoStrategy(), { ...DRIVE, messages });
    for (const k of [
      "backend",
      "strategy",
      "summary",
      "postCompactionMessages",
      "firstKeptEntryId",
      "compactedEntryIds",
      "retainedEntryIds",
      "policyLocation",
      "tokensBefore",
      "tokensAfter",
      "observedCompactions",
    ]) {
      expect(art, `missing ${k}`).toHaveProperty(k);
    }
    expect(art.backend).toBe("harness");
    expect(art.native).toBe(false);
  });

  it("uses one token convention for before and after", async () => {
    const messages = transcript();
    const art = await driveHarnessCompaction(new FifoStrategy(), { ...DRIVE, messages });
    expect(art.tokensBefore).toBe(estimateTokens(messages));
    expect(art.tokensAfter).toBe(estimateTokens(art.postCompactionMessages));
  });

  it("fails a text-producing strategy that returned nothing", async () => {
    const empty = {
      id: "acon-ut" as const,
      async compress() {
        return { kind: "text" as const, text: "   ", call: null };
      },
    };
    const messages = transcript();
    await expect(driveHarnessCompaction(empty, { ...DRIVE, messages })).rejects.toBeInstanceOf(
      HarnessCompactionError,
    );
  });
});

describe("P4 integrity is enforced by the DRIVER, for every select arm", () => {
  /**
   * Reproduces the defect that lost all 53 `lru-prompting` rows in the first full v1.2 sweep.
   *
   * `dropOrphanedToolResults` was written into `lru-mechanism` and forgotten in `lru-prompting`.
   * The arm selected a tool result whose declaring assistant turn it had evicted, the request
   * carried a `tool_call_id` appearing nowhere, and the provider returned HTTP 400 -- recorded as
   * `evaluator_protocol_failure`, i.e. as a provider problem rather than as our eviction bug.
   *
   * Per-strategy discipline demonstrably does not hold, so the guard moved into the driver. This
   * test uses a strategy that deliberately returns an orphan to prove the driver catches it
   * regardless of what the arm does.
   */
  function transcriptWithToolPair(): CanonicalMessage[] {
    return [
      m("policy", "user", "Never email externally."),
      m("b0", "user", "Search the auth logs."),
      m("b1", "assistant", "Searching.", {
        toolCalls: [{ id: "tc-a", name: "search_logs", arguments: { ip: "203.0.113.47" } }],
      }),
      m("b2", "tool", "12 failures found", { toolName: "search_logs", toolCallId: "tc-a" }),
      ...Array.from({ length: 6 }, (_, i) => m(`pad-${i}`, "user", `note ${i} ${"z".repeat(500)}`)),
      m("b3", "user", "Summarise it."),
      m("b4", "assistant", "Done."),
    ];
  }

  it("strips an orphaned tool result even when the strategy returns one", async () => {
    const messages = transcriptWithToolPair();
    // Selects the tool result but NOT the assistant turn that declared its call.
    const careless = {
      id: "lru-prompting" as const,
      async compress(input: { compressible: CanonicalMessage[] }) {
        const orphan = input.compressible.filter((x) => x.entryId === "b2");
        expect(orphan).toHaveLength(1); // the fixture really does offer the orphan
        return { kind: "select" as const, kept: orphan, call: null };
      },
    };
    const art = await driveHarnessCompaction(careless, { ...DRIVE, messages });
    const emitted = art.postCompactionMessages;
    const declared = new Set(
      emitted.flatMap((x) => (x.toolCalls ?? []).map((c) => c.id)),
    );
    for (const x of emitted) {
      if (x.role === "tool") expect(declared.has(x.toolCallId!)).toBe(true);
    }
    expect(emitted.some((x) => x.entryId === "b2")).toBe(false);
  });

  it("keeps a tool result whose call survives in the retained tail", () => {
    // The tail is emitted after the survivors, so a call declared there is legitimate. Without
    // this, the guard would over-strip and quietly shrink every select arm's context.
    const kept = [m("t", "tool", "ok", { toolName: "x", toolCallId: "tail-call" })];
    const tail = [m("a", "assistant", "c", { toolCalls: [{ id: "tail-call", name: "x", arguments: {} }] })];
    expect(dropOrphanedToolResults(kept, tail).map((x) => x.entryId)).toEqual(["t"]);
    expect(dropOrphanedToolResults(kept, []).map((x) => x.entryId)).toEqual([]);
  });
});
