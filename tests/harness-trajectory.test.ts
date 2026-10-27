import { legacyArmsConfig } from "./helpers/legacy-config.ts";
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCutPoint, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  TrajectoryWriter,
  parseTrajectory,
  assertEventOrder,
  EVENT_ORDER,
  type HaystackRef,
  type TrajectoryEvent,
} from "../src/harness/trajectory.ts";
import { rehydrate, regenerateCorpus, RehydrationError } from "../scripts/rehydrate-trajectory.ts";
import { buildCondition, HAYSTACK_HEADER, HAYSTACK_HEADER_CHARS } from "../src/context/transcript-v11.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import { loadMvpConfig, PI_TOOL_RESULT_MAX_CHARS } from "../src/config/config.ts";
import { reconstructSummarizerInput, toPiMessageForTest } from "../src/compaction/pi-native.ts";
import type { CanonicalMessage, GovernanceCondition } from "../src/harness/schema.ts";

const CFG = legacyArmsConfig();
const ROWS = loadTaskRows("data/rule-loss/cases.jsonl");

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "traj-"));
}

/** The ref factory the runner uses, reproduced here so the round-trip test is self-contained. */
function refsFor(built: ReturnType<typeof buildCondition>, taskId: string) {
  const needle = built.needle;
  if (!needle) return undefined;
  let cursor = 0;
  return (m: CanonicalMessage): HaystackRef | null => {
    if (m.role !== "tool" || !m.entryId.includes("-haystack")) return null;
    const body = Math.max(0, m.content.length - HAYSTACK_HEADER_CHARS);
    const ref: HaystackRef = {
      kind: "haystack",
      corpusId: needle.corpusId,
      corpusSha256: needle.corpusSha256,
      corpusChars: needle.corpusChars,
      seed: needle.seed,
      taskId,
      repetition: 0,
      sliceStart: cursor,
      sliceEnd: cursor + body,
      headerChars: HAYSTACK_HEADER_CHARS,
      chars: m.content.length,
    };
    cursor += body;
    return ref;
  };
}

describe("§6.2: the event log round-trips", () => {
  it("every event type survives write → read", async () => {
    const w = new TrajectoryWriter(tmpDir());
    const samples: TrajectoryEvent[] = [
      {
        type: "run_meta",
        runId: "r", condition: "G5", policyChannel: "c2", haystackArm: "A2", taskId: "email",
        repetition: 0, model: "m", startedAt: new Date(0).toISOString(),
        config: {
          keepRecentTokens: 100, reserveTokens: 16384, compactionStrategy: "pi-native-cut",
          haystackDelivery: "chunked-tool-results", haystackChunkChars: 8000,
          haystackCharsReachingSummarizer: 23499, haystackInsertionTurn: 1,
          toolResultMaxChars: PI_TOOL_RESULT_MAX_CHARS, piRevision: "abc", seed: 7, temperature: 0.7,
        },
      },
      {
        type: "policy_channel_step", channel: "c2", expectedTool: "persist_document",
        observedToolCalls: [{ name: "persist_document", args: { path: "rule.md" } }],
        writtenContent: "text", satisfied: true, usage: null, latencyMs: 5,
      },
      { type: "input_message", index: 0, entryId: "e0", role: "user", content: "hi", chars: 2, estTokens: 1 },
      {
        type: "cut_decision", firstKeptEntryId: "e1", firstKeptIndex: 1, compactedEntryIds: ["e0"],
        retainedEntryIds: ["e1"], isSplitTurn: true, turnStartIndex: 1, tokensBefore: 10, tokensAfter: 5,
      },
      {
        type: "summarizer_input", part: "history", entryIds: ["e0"], serializedConversation: "x",
        charsBeforeTruncation: 3, charsAfterTruncation: 1, truncatedEntryIds: ["e0"],
        charsDiscardedPerEntry: { e0: 2 }, isSplitTurn: true, reconstructed: true,
        promptTemplateRef: "abc",
      },
      // A retry that eventually succeeded — distinguishes a slow run from a fast one.
      { type: "summarizer_retry", attempt: 1, delayMs: 1000, message: "429: rate limited" },
      // A terminal failure WITH its provider message. Added after six mimo rows failed with the
      // invalid reason recorded and the cause missing, which is the one fact needed to tell a
      // retryable timeout from a permanent fault.
      {
        type: "summarizer_failure", reason: "missing_native_compaction",
        message: "Summarization failed: The operation was aborted", attempts: 1,
        classifiedTransient: false, elapsedMs: 50001,
      },
      {
        type: "summarizer_output", part: "turn_prefix", summary: "s", constraintsSection: null,
        usage: null, model: "m", latencyMs: 1,
      },
      { type: "post_compaction_context", messages: [{ entryId: "s", role: "user", chars: 1 }], totalChars: 1 },
      {
        type: "decision_step", step: 1, assistantText: "a",
        toolCalls: [{ id: "t", name: "send_email", args: {} }],
        stubResults: [{ toolCallId: "t", name: "send_email", content: "{}" }],
        latencyMs: 2, rawResponse: null,
      },
      {
        type: "outcome", grade: "violation", binaryLabel: "violation",
        toolCalls: [{ name: "send_email", args: {} }], terminalText: "t", toolSteps: 1, hitStepCap: false,
      },
      { type: "run_end", durationMs: 9, valid: true, invalidReason: null },
    ];
    for (const e of samples) w.record(e);
    const path = await w.flush();
    expect(path).not.toBeNull();

    const parsed = parseTrajectory(readFileSync(path!, "utf8"));
    expect(parsed).toEqual(samples);
    // Every declared event type is exercised, so a new type cannot be added without a sample.
    expect(new Set(parsed.map((e) => e.type))).toEqual(new Set(EVENT_ORDER));
    expect(() => assertEventOrder(parsed)).not.toThrow();
  });

  it("out-of-order events are rejected, so the log's shape is guaranteed not assumed", () => {
    expect(() =>
      assertEventOrder([
        { type: "run_end", durationMs: 1, valid: true, invalidReason: null },
        { type: "input_message", index: 0, entryId: "e", role: "user", content: "", chars: 0, estTokens: 0 },
      ]),
    ).toThrow(/after a later-stage event/);
  });

  it("recording can be switched off without the call sites changing", async () => {
    const w = new TrajectoryWriter(tmpDir(), false);
    w.record({ type: "run_end", durationMs: 1, valid: true, invalidReason: null });
    expect(w.snapshot()).toHaveLength(0);
    expect(await w.flush()).toBeNull();
  });
});

describe("§6.2: uncompacted conditions produce a log too", () => {
  it("G0 and G1 write a trajectory — they previously produced no artifact at all", async () => {
    // The directory used to be created by the compaction adapter, so 378 uncompacted runs had
    // zero raw record. The writer is now owned by the runner and opened for every condition.
    for (const condition of ["G0", "G1"] as GovernanceCondition[]) {
      const w = new TrajectoryWriter(tmpDir());
      const built = buildCondition({ row: ROWS[0]!, condition, repetition: 0, cfg: CFG });
      w.recordInputMessages(built.messages);
      w.record({ type: "run_end", durationMs: 1, valid: true, invalidReason: null });
      const path = await w.flush();
      const events = parseTrajectory(readFileSync(path!, "utf8"));
      expect(events.filter((e) => e.type === "input_message")).toHaveLength(built.messages.length);
      // And no compaction events, because none happened.
      expect(events.some((e) => e.type === "cut_decision")).toBe(false);
      expect(events.some((e) => e.type === "summarizer_input")).toBe(false);
    }
  });
});

describe("§6.3: the haystack is stored by reference and rehydrates exactly", () => {
  it("references replace bytes, and expansion reproduces every entry", async () => {
    const arm = CFG.haystackArms.find((a) => a.id === "A2")!;
    const built = buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 0, cfg: CFG, arm });
    const w = new TrajectoryWriter(tmpDir());
    w.recordInputMessages(built.messages, refsFor(built, ROWS[0]!.id));
    const path = await w.flush();

    const raw = readFileSync(path!, "utf8");
    const events = parseTrajectory(raw);
    const refs = events.filter((e) => e.type === "input_message" && e.contentRef);
    expect(refs.length, "13 haystack tool results stored as refs").toBe(13);

    // The whole point: the corpus bytes are NOT in the file.
    expect(raw).not.toContain(built.needle!.needleSentence);
    expect(raw.length).toBeLessThan(built.needle!.corpusChars / 2);

    const result = rehydrate(events, HAYSTACK_HEADER);
    expect(result.refsExpanded).toBe(13);
    expect(result.corporaVerified).toBe(1);

    // Byte-for-byte against what buildCondition produced.
    const expanded = result.events.filter((e) => e.type === "input_message");
    built.messages.forEach((m, i) => {
      const e = expanded[i]!;
      expect(e.type === "input_message" && e.content, `entry ${i} (${m.entryId})`).toBe(m.content);
    });
  });

  it("rehydration fails loudly if the corpus generator has drifted", () => {
    const built = buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 0, cfg: CFG });
    const ref: HaystackRef = {
      kind: "haystack", corpusId: built.needle!.corpusId,
      corpusSha256: "0".repeat(64), corpusChars: built.needle!.corpusChars,
      seed: built.needle!.seed, taskId: "email", repetition: 0,
      sliceStart: 0, sliceEnd: 10, headerChars: 0, chars: 10,
    };
    // A silent mismatch would hand back different filler than the summarizer actually read, which
    // is worse than no rehydration at all.
    expect(() => regenerateCorpus(ref, CFG.haystackTargetChars, CFG.needleKeyPrefix)).toThrow(
      RehydrationError,
    );
  });

  it("every arm's refs tile the corpus without gap or overlap", () => {
    for (const arm of CFG.haystackArms) {
      const built = buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 0, cfg: CFG, arm });
      const w = new TrajectoryWriter(tmpDir());
      w.recordInputMessages(built.messages, refsFor(built, ROWS[0]!.id));
      const refs = w
        .snapshot()
        .filter((e): e is Extract<TrajectoryEvent, { type: "input_message" }> => e.type === "input_message")
        .map((e) => e.contentRef)
        .filter((r): r is HaystackRef => r !== undefined);
      let cursor = 0;
      for (const r of refs) {
        expect(r.sliceStart, `arm ${arm.id} contiguous`).toBe(cursor);
        cursor = r.sliceEnd;
      }
      expect(cursor, `arm ${arm.id} covers the whole corpus`).toBe(built.needle!.corpusChars);
    }
  });
});

describe("§6.5 / D-5: the recorded summarizer input shows the truncation", () => {
  it("charsAfterTruncation is far below charsBeforeTruncation, and names the entries cut", () => {
    const arm = CFG.haystackArms.find((a) => a.id === "A2")!;
    const built = buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 0, cfg: CFG, arm });
    const mgr = SessionManager.inMemory(process.cwd());
    built.messages.forEach((m, i) => mgr.appendMessage(toPiMessageForTest(m, CFG.agentModel, i)));
    const entries = mgr.getBranch();
    const cut = findCutPoint(entries, 0, entries.length, CFG.keepRecentTokens);
    const end = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;

    const rec = reconstructSummarizerInput(
      entries, 0, end, "history",
      (i) => built.messages[i]?.entryId,
      (i) => built.messages[i]?.content,
      (i) => built.messages[i]?.role,
    );

    // This is the pair of numbers whose absence let the truncation go unnoticed: an entry-level
    // record shows the document is in the prefix, and says nothing about how much of it the model
    // receives.
    expect(rec.charsBeforeTruncation).toBeGreaterThan(90_000);
    expect(rec.charsAfterTruncation).toBeLessThan(40_000);
    // 12 of the 13 chunks exceed the cap; the 13th is ~339 chars. Counted by filtering on the
    // haystack ids, because `email` also ships a 2,128-char BENIGN tool result that pi caps too —
    // conflating the two is how the absolute count reads 13 and means nothing.
    const haystackTruncations = rec.truncatedEntryIds.filter((id) => id.includes("-haystack"));
    expect(haystackTruncations.length).toBe(12);
    expect(rec.truncatedEntryIds.length).toBe(13);
    const discarded = Object.values(rec.charsDiscardedPerEntry).reduce((a, b) => a + b, 0);
    expect(discarded).toBeGreaterThan(60_000);
    // And the marker pi writes is visible in the recorded text.
    expect(rec.serializedConversation).toContain("more characters truncated");
  });

  it("A3 records no truncated entries — that is its defining property", () => {
    const arm = CFG.haystackArms.find((a) => a.id === "A3")!;
    const built = buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 0, cfg: CFG, arm });
    const mgr = SessionManager.inMemory(process.cwd());
    built.messages.forEach((m, i) => mgr.appendMessage(toPiMessageForTest(m, CFG.agentModel, i)));
    const entries = mgr.getBranch();
    const cut = findCutPoint(entries, 0, entries.length, CFG.keepRecentTokens);
    const end = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
    const rec = reconstructSummarizerInput(
      entries, 0, end, "history",
      (i) => built.messages[i]?.entryId,
      (i) => built.messages[i]?.content,
      (i) => built.messages[i]?.role,
    );
    const haystackTruncations = rec.truncatedEntryIds.filter((id) => id.includes("-haystack"));
    expect(haystackTruncations).toEqual([]);
  });
});
