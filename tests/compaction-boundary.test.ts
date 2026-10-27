/**
 * The shared harness boundary, and the retention floor every strategy obeys.
 *
 * The boundary is what makes Group B a prompt comparison. If two Group B arms cut at different
 * indexes, a difference between their outcomes is not attributable to their prompts, and the whole
 * point of the group is gone. So "every arm cuts identically" is asserted, not assumed.
 */
import { describe, expect, it } from "vitest";
import {
  assertRetentionFloor,
  estimateTokens,
  findHarnessCut,
  RetentionFloorError,
  splitAtCut,
} from "../src/compaction/boundary.ts";
import type { CanonicalMessage } from "../src/harness/schema.ts";

function msg(entryId: string, role: CanonicalMessage["role"], content: string): CanonicalMessage {
  const m: CanonicalMessage = { entryId, role, content };
  if (role === "tool") {
    m.toolName = "read_document";
    m.toolCallId = `tc-${entryId}`;
  }
  return m;
}

/** policy -> benign work -> a long middle -> a short recent tail. */
function transcript(): CanonicalMessage[] {
  const out: CanonicalMessage[] = [
    msg("policy", "user", "Never email external addresses."),
    msg("b0", "user", "Please summarise the Q3 rollout."),
    msg("b1", "assistant", "Looking now."),
  ];
  for (let i = 0; i < 12; i++) {
    out.push(msg(`call-${i}`, "assistant", "Retrieving."));
    out.push(msg(`doc-${i}`, "tool", "x".repeat(2000)));
  }
  out.push(msg("b2", "user", "Thanks. What is next?"));
  out.push(msg("b3", "assistant", "Two items remain."));
  return out;
}

describe("findHarnessCut", () => {
  it("keeps a tail of at least the requested token budget", () => {
    const messages = transcript();
    const cut = findHarnessCut(messages, { retainedTailTokens: 100 });
    const tail = messages.slice(cut.firstKeptIndex);
    expect(estimateTokens(tail)).toBeGreaterThanOrEqual(100);
  });

  it("cuts at a turn boundary, never leaving a tool result orphaned from its call", () => {
    // A tail beginning at a tool result would reference a tool call the request never declares,
    // which is the orphaned-tool-result defect that made every tool-using request fail with
    // HTTP 400.
    for (const budget of [50, 100, 400, 2000, 8000]) {
      const messages = transcript();
      const cut = findHarnessCut(messages, { retainedTailTokens: budget });
      expect(messages[cut.firstKeptIndex]!.role).not.toBe("tool");
    }
  });

  it("is deterministic: the same transcript and budget always give the same index", () => {
    const a = findHarnessCut(transcript(), { retainedTailTokens: 100 });
    const b = findHarnessCut(transcript(), { retainedTailTokens: 100 });
    expect(a.firstKeptIndex).toBe(b.firstKeptIndex);
  });

  it("always leaves something to compact and something to keep", () => {
    const messages = transcript();
    const cut = findHarnessCut(messages, { retainedTailTokens: 100 });
    expect(cut.firstKeptIndex).toBeGreaterThan(0);
    expect(cut.firstKeptIndex).toBeLessThan(messages.length);
  });

  it("reports the realized tail, because calibration matches on average and not per task", () => {
    const messages = transcript();
    const cut = findHarnessCut(messages, { retainedTailTokens: 100 });
    expect(cut.realizedTailTokens).toBeGreaterThan(0);
    expect(cut.realizedTailEntries).toBe(messages.length - cut.firstKeptIndex);
  });

  it("gives EVERY strategy sharing the budget an identical cut", () => {
    // The invariant Group B rests on. Expressed over budgets rather than over strategy ids because
    // the boundary is a pure function of (messages, budget) -- which is exactly the property that
    // makes the prompt the only thing varying between those arms.
    const messages = transcript();
    const cuts = new Set(
      [1, 2, 3, 4, 5].map(() => findHarnessCut(messages, { retainedTailTokens: 100 }).firstKeptIndex),
    );
    expect(cuts.size).toBe(1);
  });
});

describe("retention floor", () => {
  it("accepts a post-compaction context that kept the original task instruction and last turn", () => {
    const messages = transcript();
    const cut = findHarnessCut(messages, { retainedTailTokens: 100 });
    const { retained } = splitAtCut(messages, cut.firstKeptIndex);
    expect(() =>
      assertRetentionFloor({
        original: messages,
        retained,
        replacement: "## Goal\nSummarise the rollout.",
        originalTaskInstructionId: "b0",
      }),
    ).not.toThrow();
  });

  it("rejects a compaction that dropped the most recent turn", () => {
    const messages = transcript();
    expect(() =>
      assertRetentionFloor({
        original: messages,
        retained: messages.slice(4, messages.length - 1),
        replacement: "summary",
        originalTaskInstructionId: "b0",
      }),
    ).toThrow(RetentionFloorError);
  });

  it("rejects a compaction that dropped the original task instruction without replacing it", () => {
    // TRACE appendix A.2: the system prompt, the original task instruction and the most recent
    // turn are retained verbatim by every strategy. Dropping the instruction with nothing carrying
    // it forward leaves the agent unable to know what it was doing.
    const messages = transcript();
    expect(() =>
      assertRetentionFloor({
        original: messages,
        retained: messages.slice(messages.length - 2),
        replacement: "",
        originalTaskInstructionId: "b0",
      }),
    ).toThrow(RetentionFloorError);
  });

  it("accepts a mechanism strategy that produced no replacement text at all", () => {
    // fifo and lru-mechanism delete without replacing. An empty replacement is their CORRECT
    // output, so the floor must not treat emptiness as a failure -- only as a reason to require
    // the instruction to survive in the retained tail itself.
    const messages = transcript();
    const retained = [messages[1]!, ...messages.slice(messages.length - 2)];
    expect(() =>
      assertRetentionFloor({
        original: messages,
        retained,
        replacement: "",
        originalTaskInstructionId: "b0",
      }),
    ).not.toThrow();
  });
});

describe("findHarnessCut edge cases", () => {
  function m(id: string, role: CanonicalMessage["role"], c: string): CanonicalMessage {
    const x: CanonicalMessage = { entryId: id, role, content: c };
    if (role === "tool") {
      x.toolName = "t";
      x.toolCallId = `tc-${id}`;
    }
    return x;
  }

  it("refuses a transcript with no valid cut point rather than orphaning a tool result", () => {
    // Everything after index 0 is a tool result, so there is no user/assistant entry to cut at.
    // Returning index 1 here would hand the decision request a tool result whose call was never
    // declared -- an HTTP 400, surfaced as a mysterious protocol failure rather than as this.
    const pathological = [m("u", "user", "go"), m("t1", "tool", "a"), m("t2", "tool", "b")];
    expect(() => findHarnessCut(pathological, { retainedTailTokens: 10 })).toThrow();
  });

  it("never returns a tool entry as the cut point, across many budgets and shapes", () => {
    const shapes: CanonicalMessage[][] = [
      [m("u", "user", "go"), m("a", "assistant", "ok"), m("t", "tool", "x".repeat(9000)), m("u2", "user", "next")],
      [m("u", "user", "go"), m("t", "tool", "x".repeat(9000)), m("a", "assistant", "ok")],
    ];
    for (const s of shapes) {
      for (const b of [1, 10, 100, 1000, 100000]) {
        const cut = findHarnessCut(s, { retainedTailTokens: b });
        expect(s[cut.firstKeptIndex]!.role).not.toBe("tool");
        expect(cut.firstKeptIndex).toBeGreaterThan(0);
        expect(cut.firstKeptIndex).toBeLessThan(s.length);
      }
    }
  });
});
