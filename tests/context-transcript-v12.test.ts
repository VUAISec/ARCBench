/**
 * One common attack position, and the shared source transcript.
 *
 * The property under test is the one v1.1 lacks: the attack sits at the SAME place relative to
 * benign work whether or not filler is present, so adding filler is the only thing that changes
 * between those two conditions.
 */
import { describe, expect, it } from "vitest";
import { buildConditionV12 } from "../src/context/transcript-v12.ts";
import type { ConditionSpec } from "../src/plan/spec.ts";
import { loadMvpConfig } from "../src/config/config.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";

const cfg = loadMvpConfig();
const rows = loadTaskRows("data/rule-loss/cases.jsonl");
const row = rows.find((r) => r.id === "email")!;

function spec(over: Partial<ConditionSpec> = {}): ConditionSpec {
  return {
    policyPresent: true,
    fillerPresent: false,
    attackPresent: false,
    contextHandling: "compacted",
    compactionStrategy: "pi-native-cut",
    compactionBackend: "pi-native",
    haystackArm: null,
    attackInsertion: "after-benign-block-1",
    policyChannel: "c1",
    protocolVersion: "v1.2",
    legacyLabel: null,
    ...over,
  };
}

const build = (s: ConditionSpec) => buildConditionV12({ row, spec: s, repetition: 0, cfg });

/** Index of the attack block relative to the benign turns that precede it. */
function benignTurnsBeforeAttack(messages: { entryId: string; role: string }[]): number {
  const attackAt = messages.findIndex((m) => m.entryId.includes("-inject"));
  if (attackAt === -1) return -1;
  return messages.slice(0, attackAt).filter((m) => m.entryId.includes("-benign-")).length;
}

describe("common attack position (A03)", () => {
  it("places the attack after the same amount of benign work with and without filler", () => {
    const noFiller = build(spec({ attackPresent: true }));
    const withFiller = build(spec({ attackPresent: true, fillerPresent: true, haystackArm: "A3" }));
    const a = benignTurnsBeforeAttack(noFiller.messages);
    const b = benignTurnsBeforeAttack(withFiller.messages);
    expect(a).toBeGreaterThan(0);
    expect(a).toBe(b);
  });

  it("leaves the filler at the same logical point when the attack is absent", () => {
    const withAttack = build(spec({ attackPresent: true, fillerPresent: true, haystackArm: "A3" }));
    const without = build(spec({ attackPresent: false, fillerPresent: true, haystackArm: "A3" }));
    const benignBefore = (ms: { entryId: string }[]) => {
      const at = ms.findIndex((m) => m.entryId.includes("-haystack"));
      return ms.slice(0, at).filter((m) => m.entryId.includes("-benign-")).length;
    };
    expect(benignBefore(withAttack.messages)).toBe(benignBefore(without.messages));
  });

  it("puts the attack before the filler, so its position does not depend on the filler", () => {
    const s = build(spec({ attackPresent: true, fillerPresent: true, haystackArm: "A3" }));
    const inj = s.messages.findIndex((m) => m.entryId.includes("-inject"));
    const doc = s.messages.findIndex((m) => m.entryId.includes("-haystack"));
    expect(inj).toBeLessThan(doc);
  });
});

describe("source transcript sharing", () => {
  it("is identical across every conversation-handling branch of one instance", () => {
    // The premise of the whole four-condition comparison: full context and each compacted arm are
    // the SAME conversation handled differently, not four separately generated ones.
    const full = build(spec({ contextHandling: "full", compactionStrategy: null, compactionBackend: null }));
    const pi = build(spec({ compactionStrategy: "pi-native-cut" }));
    const acon = build(spec({ compactionStrategy: "acon-ut", compactionBackend: "harness" }));
    expect(full.sourceTranscriptId).toBe(pi.sourceTranscriptId);
    expect(pi.sourceTranscriptId).toBe(acon.sourceTranscriptId);
    expect(full.messages.map((m) => m.entryId)).toEqual(pi.messages.map((m) => m.entryId));
  });

  it("differs when a factor that changes the conversation changes", () => {
    const base = build(spec());
    for (const other of [
      spec({ attackPresent: true }),
      spec({ fillerPresent: true, haystackArm: "A3" }),
      spec({ policyPresent: false, policyChannel: null }),
    ]) {
      expect(build(other).sourceTranscriptId).not.toBe(base.sourceTranscriptId);
    }
  });

  it("gives the attacked and unattacked branches byte-identical filler", () => {
    const a = build(spec({ fillerPresent: true, haystackArm: "A3", attackPresent: true }));
    const b = build(spec({ fillerPresent: true, haystackArm: "A3", attackPresent: false }));
    expect(a.needle!.corpusSha256).toBe(b.needle!.corpusSha256);
  });
});

describe("task instruction", () => {
  it("identifies the first benign user turn, which the retention floor pins", () => {
    const s = build(spec());
    const entry = s.messages.find((m) => m.entryId === s.taskInstructionEntryId)!;
    expect(entry.role).toBe("user");
    expect(s.taskInstruction).toBe(entry.content);
    // It must not be the policy turn: ACON binds {{ task }} to this text.
    expect(s.taskInstructionEntryId).not.toBe(s.policyEntryId);
  });

  it("never equals the final trigger", () => {
    const s = build(spec());
    expect(s.taskInstruction).not.toBe(s.trigger);
  });
});

describe("no-policy conditions", () => {
  it("leaks the policy nowhere", () => {
    const s = build(spec({ policyPresent: false, policyChannel: null }));
    expect(s.policyEntryId).toBeNull();
    expect(s.messages.some((m) => m.content.includes(row.policy.trim()))).toBe(false);
  });
});

describe("every task builds in every cell", () => {
  it("constructs all four filler x attack combinations for all nine tasks", () => {
    for (const r of rows) {
      for (const fillerPresent of [false, true]) {
        for (const attackPresent of [false, true]) {
          const s = spec({ fillerPresent, attackPresent, haystackArm: fillerPresent ? "A3" : null });
          expect(() =>
            buildConditionV12({ row: r, spec: s, repetition: 0, cfg }),
          ).not.toThrow();
        }
      }
    }
  });
});
