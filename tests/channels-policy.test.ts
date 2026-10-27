import { describe, it, expect } from "vitest";
import { findCutPoint, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildCondition, hasPolicy } from "../src/context/transcript-v11.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import { loadMvpConfig, PI_TOOL_RESULT_MAX_CHARS } from "../src/config/config.ts";
import { toPiMessageForTest } from "../src/compaction/pi-native.ts";
import {
  CHANNEL_TOOLS,
  CHANNEL_TOOL_SCHEMAS,
  RULE_FILENAME,
  auditChannelTools,
  assertChannelToolsClean,
  buildPolicyBlock,
  channelInstruction,
  channelToolsFor,
  expectedToolFor,
  isLiveChannel,
  PolicyChannelError,
} from "../src/channels/policy-channels.ts";
import type { GovernanceCondition, PolicyChannel } from "../src/harness/schema.ts";

const CFG = loadMvpConfig();
const ROWS = loadTaskRows("data/rule-loss/cases.jsonl");
const CHANNELS: PolicyChannel[] = ["c1", "c2", "c3", "c4"];
const POLICY_CONDITIONS: GovernanceCondition[] = ["G1", "G2", "G3", "G4", "G5"];

describe("§3.0.1: every channel delivers byte-identical policy text", () => {
  it("the policy entry carries the policy verbatim, on every channel and condition", () => {
    for (const channel of CHANNELS) {
      for (const condition of POLICY_CONDITIONS) {
        for (const row of ROWS) {
          const built = buildCondition({ row, condition, repetition: 0, cfg: CFG, channel });
          const where = `${row.id} ${condition} ${channel}`;
          expect(built.policyEntryId, `${where} has a policy entry`).not.toBeNull();
          const msg = built.messages.find((m) => m.entryId === built.policyEntryId);
          expect(msg, `${where} policy entry present`).toBeDefined();
          // Verbatim containment, not equality: c2's entry is the write RESULT, which echoes the
          // persisted text after a "Wrote rule.md." line. Framing differs; the policy does not.
          expect(msg!.content, `${where} verbatim`).toContain(row.policy.trim());
        }
      }
    }
  });

  it("framing is the only difference — c1 states it, c3 does not instruct at all", () => {
    const row = ROWS[0]!;
    const c1 = buildCondition({ row, condition: "G2", repetition: 0, cfg: CFG, channel: "c1" });
    const c3 = buildCondition({ row, condition: "G2", repetition: 0, cfg: CFG, channel: "c3" });
    // c1: the policy IS a user instruction.
    expect(c1.messages.find((m) => m.entryId === c1.policyEntryId)!.role).toBe("user");
    // c3: the policy is a document the agent read. It is expected to bind because of what it is,
    // so an instruction turn here would erase the entire c1-vs-c3 contrast.
    expect(c3.messages.find((m) => m.entryId === c3.policyEntryId)!.role).toBe("tool");
    expect(c3.messages.some((m) => m.content.includes("Record the following"))).toBe(false);
  });

  it("c2 and c4 are the live channels; c1 and c3 are fully harness-authored", () => {
    for (const channel of CHANNELS) {
      const built = buildCondition({ row: ROWS[0]!, condition: "G2", repetition: 0, cfg: CFG, channel });
      expect(built.requiresLiveChannelCall).toBe(isLiveChannel(channel));
      expect(built.policyChannel).toBe(channel);
    }
    expect(expectedToolFor("c2")).toBe(CHANNEL_TOOLS.c2);
    expect(expectedToolFor("c4")).toBe(CHANNEL_TOOLS.c4);
    expect(() => expectedToolFor("c1")).toThrow(PolicyChannelError);
  });

  it("c2's instruction dictates the exact text and names the file", () => {
    const row = ROWS[0]!;
    const instruction = channelInstruction("c2", row.policy);
    expect(instruction).toContain(RULE_FILENAME);
    expect(instruction).toContain(row.policy);
    // "verbatim ... without rewording" is what makes the dictated-vs-composed distinction real.
    expect(instruction).toMatch(/verbatim/i);
  });

  it("a live channel's model-written content is used as-is, not corrected", () => {
    // By decision (2026-09-04) c2 is NOT fidelity-graded: a paraphrase is the channel behaving as
    // it behaves and the row stays reportable. So a drifted write must survive construction.
    const row = ROWS[0]!;
    const drifted = "Do not email outsiders.";
    const block = buildPolicyBlock({
      row,
      channel: "c2",
      entryId: (l) => `probe-${l}`,
      liveResult: { toolCallId: "tc-probe", writtenContent: drifted },
    });
    const call = block.messages.find((m) => m.role === "assistant")!;
    expect(call.toolCalls![0]!.arguments["content"]).toBe(drifted);
    expect(block.messages.find((m) => m.entryId === block.policyEntryId)!.content).toContain(drifted);
  });
});

describe("§3.0.1: the channel tools must not reintroduce a P2 leak", () => {
  it("no channel tool description shares a content term with any task's policy", () => {
    // A tool description is sent on every call, independent of `messages`, so compaction has no
    // reach into it. `spend` and `pii` once encoded their graded constraint there, contaminating
    // even G0. One generic description is used matrix-wide, so one leak contaminates every task.
    expect(auditChannelTools(ROWS)).toEqual([]);
    expect(() => assertChannelToolsClean(ROWS)).not.toThrow();
  });

  it("the audit catches P2's two real leaks verbatim — it is not vacuously passing", () => {
    // The actual leaking descriptions found in the shipped dataset. If the audit cannot flag these,
    // it is not auditing anything.
    const cases: Array<[string, string]> = [
      ["spend-style ceiling", "Submit a purchase order directly (up to $100 limit)."],
      ["pii-style prohibition", "Customer SSN (must never be included in reports)."],
    ];
    for (const [label, description] of cases) {
      const schema = {
        ...CHANNEL_TOOL_SCHEMAS.c3,
        function: { ...CHANNEL_TOOL_SCHEMAS.c3.function, description },
      };
      const saved = CHANNEL_TOOL_SCHEMAS.c3.function.description;
      CHANNEL_TOOL_SCHEMAS.c3.function.description = schema.function.description;
      try {
        const found = auditChannelTools(ROWS);
        expect(found.length, `${label} must be flagged`).toBeGreaterThan(0);
        expect(() => assertChannelToolsClean(ROWS)).toThrow(PolicyChannelError);
      } finally {
        CHANNEL_TOOL_SCHEMAS.c3.function.description = saved;
      }
    }
    // And the real descriptions are clean again afterwards.
    expect(auditChannelTools(ROWS)).toEqual([]);
  });

  it("a parameter description is audited too — same surface, same reach", () => {
    const saved = CHANNEL_TOOL_SCHEMAS.c2.function.parameters.properties["content"]!.description;
    CHANNEL_TOOL_SCHEMAS.c2.function.parameters.properties["content"]!.description =
      "Text to store. Must never contain customer SSN.";
    try {
      expect(auditChannelTools(ROWS).length).toBeGreaterThan(0);
    } finally {
      CHANNEL_TOOL_SCHEMAS.c2.function.parameters.properties["content"]!.description = saved;
    }
  });

  it("channel tools never collide with a graded or task-declared tool", () => {
    for (const name of Object.values(CHANNEL_TOOLS)) {
      for (const row of ROWS) {
        expect(row.grader.tool, `${row.id} graded tool`).not.toBe(name);
        expect(row.tools.map((t) => t.function.name), `${row.id} task tools`).not.toContain(name);
      }
    }
  });

  it("the channel's tool is declared on the condition, so no call is undeclared", () => {
    for (const channel of CHANNELS) {
      const built = buildCondition({ row: ROWS[0]!, condition: "G2", repetition: 0, cfg: CFG, channel });
      const names = built.tools.map((t) => t.function.name);
      for (const schema of channelToolsFor(channel)) {
        expect(names).toContain(schema.function.name);
      }
      // Every tool call in the transcript references a declared tool.
      for (const m of built.messages) {
        for (const c of m.toolCalls ?? []) expect(names).toContain(c.name);
      }
    }
  });
});

describe("D-5: a tool-result channel must fit under pi's 2,000-char cap", () => {
  it("every task's policy fits, so c3/c4 are not silently truncated", () => {
    for (const row of ROWS) {
      expect(row.policy.length, `${row.id} policy chars`).toBeLessThan(PI_TOOL_RESULT_MAX_CHARS);
    }
  });

  it("an over-long policy is a construction error, not a silent partial delivery", () => {
    const row = { ...ROWS[0]!, policy: "x".repeat(PI_TOOL_RESULT_MAX_CHARS + 1) };
    for (const channel of ["c2", "c3", "c4"] as PolicyChannel[]) {
      expect(() => buildPolicyBlock({ row, channel, entryId: (l) => `probe-${l}` })).toThrow(
        PolicyChannelError,
      );
    }
    // c1 delivers as a user entry, which pi does not cap, so it is unaffected.
    expect(() => buildPolicyBlock({ row, channel: "c1", entryId: (l) => `probe-${l}` })).not.toThrow();
  });
});

describe("channels do not disturb the layout invariants", () => {
  it("every channel keeps every condition compactable at the tuned budget", () => {
    for (const channel of CHANNELS) {
      for (const condition of ["G2", "G3", "G4", "G5"] as GovernanceCondition[]) {
        for (const row of ROWS) {
          const built = buildCondition({ row, condition, repetition: 0, cfg: CFG, channel });
          const mgr = SessionManager.inMemory(process.cwd());
          built.messages.forEach((m, i) => mgr.appendMessage(toPiMessageForTest(m, CFG.agentModel, i)));
          const entries = mgr.getBranch();
          const cut = findCutPoint(entries, 0, entries.length, CFG.keepRecentTokens);
          expect(
            cut.firstKeptEntryIndex,
            `${row.id} ${condition} ${channel} must be compactable`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("the payload insertion point is channel-independent", () => {
    // firstTurnEnd is computed on the benign arc alone. If it were computed on the assembled
    // list it would shift with the number of entries the channel contributed, and G3xc1 would
    // read the document at a different conversational position from G3xc2 — making the channel
    // axis a position axis as well.
    for (const row of ROWS) {
      const offsets = CHANNELS.map((channel) => {
        const built = buildCondition({ row, condition: "G3", repetition: 0, cfg: CFG, channel });
        const docAt = built.messages.findIndex((m) => m.entryId.includes("-haystack"));
        const policyBlockLength = built.messages.filter((m) =>
          m.entryId.includes("-policy"),
        ).length;
        // Position measured from the end of the policy block: that is what "after benign turn 1"
        // means, independent of how many entries the channel needed.
        return docAt - policyBlockLength;
      });
      expect(new Set(offsets).size, `${row.id} insertion offset varies by channel`).toBe(1);
    }
  });

  it("no-policy conditions ignore the channel entirely", () => {
    for (const condition of ["G0", "G2n", "G3n", "G4n", "G5n"] as GovernanceCondition[]) {
      expect(hasPolicy(condition)).toBe(false);
      for (const channel of CHANNELS) {
        const built = buildCondition({ row: ROWS[0]!, condition, repetition: 0, cfg: CFG, channel });
        expect(built.policyChannel, `${condition} channel`).toBeNull();
        expect(built.policyEntryId).toBeNull();
        expect(built.requiresLiveChannelCall).toBe(false);
        // And no channel tool is added, so the schema surface is identical across controls.
        expect(built.tools.map((t) => t.function.name)).toEqual(
          ROWS[0]!.tools.map((t) => t.function.name),
        );
      }
    }
  });
});

describe("a model-authored c2 policy may paraphrase without failing construction", () => {
  it("a drifted rule.md builds fine — signed off 2026-09-04", () => {
    // The invariant originally demanded verbatim containment for EVERY channel, contradicting the
    // rule that a written, non-blank rule.md is valid. Worse, the throw escaped the concurrent
    // prepare phase and aborted a whole 141-run chunk rather than one row.
    const built = buildCondition({
      row: ROWS[0]!,
      condition: "G1",
      repetition: 0,
      cfg: CFG,
      channel: "c2",
      liveChannelResult: { toolCallId: "tc-x", writtenContent: "Do not email outsiders." },
    });
    const msg = built.messages.find((m) => m.entryId === built.policyEntryId)!;
    expect(msg.content).toContain("Do not email outsiders.");
    // And it deliberately does NOT contain the dictated text — that is the drift being allowed.
    expect(msg.content).not.toContain(ROWS[0]!.policy);
  });

  it("a BLANK model-authored policy still fails — non-blank is the one requirement", () => {
    // Rejected on the WRITTEN CONTENT. Checking the assembled entry would never fire, because
    // buildPolicyBlock prefixes "Wrote rule.md." — a blank write would have sailed through.
    expect(() =>
      buildCondition({
        row: ROWS[0]!,
        condition: "G1",
        repetition: 0,
        cfg: CFG,
        channel: "c2",
        liveChannelResult: { toolCallId: "tc-x", writtenContent: "   " },
      }),
    ).toThrow(PolicyChannelError);
  });

  it("harness-authored channels are still held to verbatim delivery", () => {
    // c1/c3/c4 text comes from the harness, so a mismatch there is a harness fault and must fail.
    for (const channel of ["c1", "c3", "c4"] as PolicyChannel[]) {
      const built = buildCondition({ row: ROWS[0]!, condition: "G1", repetition: 0, cfg: CFG, channel });
      const msg = built.messages.find((m) => m.entryId === built.policyEntryId)!;
      expect(msg.content, `${channel} must be verbatim`).toContain(ROWS[0]!.policy.trim());
    }
  });
});
