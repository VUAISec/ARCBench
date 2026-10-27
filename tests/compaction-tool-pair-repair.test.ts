import { describe, it, expect } from "vitest";
import { repairToolPairs, dropOrphanedToolResults } from "../src/compaction/harness-driver.ts";
import type { CanonicalMessage } from "../src/harness/schema.ts";

/**
 * Tool-pair repair, in BOTH directions.
 *
 * `dropOrphanedToolResults` only ever removed a `tool` result whose declaring assistant turn was
 * gone. The mirror case -- an assistant turn declaring a call whose result was evicted -- was left
 * in place, and OpenAI-shaped providers reject it:
 *
 *     No tool output found for function call tc-chan-1.  (invalid_request_error, Azure)
 *
 * That cost 255 of `~openai/gpt-luna-latest`'s rows in the v1.3 v1.2-strategies sweep, all on
 * `lru-mechanism` and `lru-prompting`. `fifo` was untouched because it keeps a contiguous prefix,
 * so its pairs cannot split; LRU selects by rank and can drop one half.
 *
 * The lenient providers are the reason this needs fixing rather than tolerating: gemma, qwen and
 * glm ACCEPTED the same context and recorded those rows valid. `lru-mechanism`'s selection is
 * model-independent (no ranker; 60/60 selections byte-identical across models), so those rows were
 * measured on a malformed conversation without anything flagging it.
 */
function m(
  entryId: string,
  role: CanonicalMessage["role"],
  content: string,
  extra: Partial<CanonicalMessage> = {},
): CanonicalMessage {
  return { entryId, role, content, ...extra };
}

const assistantCalling = (entryId: string, ...ids: string[]) =>
  m(entryId, "assistant", "Looking that up.", {
    toolCalls: ids.map((id) => ({ id, name: "search", arguments: {} })),
  });
const toolResult = (entryId: string, id: string) =>
  m(entryId, "tool", "result", { toolName: "search", toolCallId: id });

describe("repairToolPairs", () => {
  it("drops an assistant tool call whose result did not survive", () => {
    const kept = [assistantCalling("a", "tc1"), m("u", "user", "next")];
    const out = repairToolPairs(kept);
    expect(out.find((x) => x.entryId === "a")?.toolCalls ?? []).toEqual([]);
  });

  it("keeps a call whose result survives alongside it", () => {
    const kept = [assistantCalling("a", "tc1"), toolResult("t1", "tc1")];
    const out = repairToolPairs(kept);
    expect(out.find((x) => x.entryId === "a")?.toolCalls?.map((c) => c.id)).toEqual(["tc1"]);
    expect(out.map((x) => x.entryId)).toEqual(["a", "t1"]);
  });

  it("keeps a call whose result sits in the retained tail", () => {
    const kept = [assistantCalling("a", "tc1")];
    const out = repairToolPairs(kept, [toolResult("t1", "tc1")]);
    expect(out.find((x) => x.entryId === "a")?.toolCalls?.map((c) => c.id)).toEqual(["tc1"]);
  });

  it("drops only the unmatched call when an assistant turn declares several", () => {
    const kept = [assistantCalling("a", "tc1", "tc2"), toolResult("t1", "tc1")];
    const out = repairToolPairs(kept);
    expect(out.find((x) => x.entryId === "a")?.toolCalls?.map((c) => c.id)).toEqual(["tc1"]);
  });

  /**
   * An assistant turn that exists only to carry a tool call has no content worth keeping once the
   * call is stripped. Leaving a contentless assistant turn behind is the other shape providers
   * reject.
   */
  it("removes an assistant turn left with neither content nor calls", () => {
    const kept = [m("a", "assistant", "", { toolCalls: [{ id: "tc1", name: "search", arguments: {} }] })];
    expect(repairToolPairs(kept).map((x) => x.entryId)).toEqual([]);
  });

  it("still drops a tool result whose declaring turn is gone", () => {
    const kept = [toolResult("t1", "tc-missing"), m("u", "user", "hi")];
    expect(repairToolPairs(kept).map((x) => x.entryId)).toEqual(["u"]);
  });

  it("leaves a fully paired transcript untouched", () => {
    const kept = [m("u", "user", "go"), assistantCalling("a", "tc1"), toolResult("t1", "tc1")];
    expect(repairToolPairs(kept)).toEqual(kept);
  });

  /**
   * The regression this is really about: after repair, no surviving call lacks a result and no
   * surviving result lacks a call. That is the invariant the provider checks.
   */
  it("leaves no dangling call and no dangling result in either direction", () => {
    const kept = [
      assistantCalling("a1", "tc1"),
      toolResult("t2", "tc2"),
      assistantCalling("a3", "tc3", "tc4"),
      toolResult("t4", "tc4"),
    ];
    const out = repairToolPairs(kept);
    const declared = new Set(out.flatMap((x) => (x.toolCalls ?? []).map((c) => c.id)));
    const results = new Set(out.filter((x) => x.role === "tool").map((x) => x.toolCallId!));
    expect([...declared].filter((id) => !results.has(id))).toEqual([]);
    expect([...results].filter((id) => !declared.has(id))).toEqual([]);
  });
});

describe("dropOrphanedToolResults stays available for the one-directional case", () => {
  it("removes a result whose declaring turn is absent", () => {
    const kept = [m("a", "assistant", "hi"), toolResult("t1", "tc-gone")];
    expect(dropOrphanedToolResults(kept).map((x) => x.entryId)).toEqual(["a"]);
  });
});
