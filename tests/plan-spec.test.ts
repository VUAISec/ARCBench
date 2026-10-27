/**
 * The v1.2 condition model.
 *
 * v1.1 identified a condition by a name whose factor content lived in lookup tables. These tests
 * pin the replacement: the factors ARE the identity, and the required 2x2 falls out of them rather
 * than being maintained by hand.
 */
import { describe, expect, it } from "vitest";
import {
  assertConditionSpec,
  ConditionSpecError,
  conditionSpecId,
  deriveLegacyLabel,
  enumerateCells,
  fullContextCells,
  type ConditionSpec,
} from "../src/plan/spec.ts";

/** A valid compacted spec, used as the base for targeted mutations. */
function compacted(over: Partial<ConditionSpec> = {}): ConditionSpec {
  return {
    policyPresent: true,
    fillerPresent: true,
    attackPresent: true,
    contextHandling: "compacted",
    compactionStrategy: "pi-native-cut",
    compactionBackend: "pi-native",
    haystackArm: "A3",
    attackInsertion: "after-benign-block-1",
    policyChannel: "c1",
    protocolVersion: "v1.2",
    legacyLabel: null,
    ...over,
  };
}

function full(over: Partial<ConditionSpec> = {}): ConditionSpec {
  return compacted({
    contextHandling: "full",
    compactionStrategy: null,
    compactionBackend: null,
    ...over,
  });
}

describe("ConditionSpec invariants", () => {
  it("accepts a well-formed compacted spec and a well-formed full spec", () => {
    expect(() => assertConditionSpec(compacted())).not.toThrow();
    expect(() => assertConditionSpec(full())).not.toThrow();
  });

  it("requires a strategy and backend iff the context is compacted", () => {
    // A compacted row with no strategy cannot say what compacted it.
    expect(() => assertConditionSpec(compacted({ compactionStrategy: null }))).toThrow(
      ConditionSpecError,
    );
    expect(() => assertConditionSpec(compacted({ compactionBackend: null }))).toThrow(
      ConditionSpecError,
    );
    // A full-context row that names a strategy is a contradiction: nothing compacted it.
    expect(() => assertConditionSpec(full({ compactionStrategy: "fifo" }))).toThrow(
      ConditionSpecError,
    );
    expect(() => assertConditionSpec(full({ compactionBackend: "pi-native" }))).toThrow(
      ConditionSpecError,
    );
  });

  it("requires a haystack arm iff filler is present", () => {
    expect(() => assertConditionSpec(compacted({ fillerPresent: false }))).toThrow(
      ConditionSpecError,
    );
    expect(() =>
      assertConditionSpec(compacted({ fillerPresent: false, haystackArm: null })),
    ).not.toThrow();
    expect(() => assertConditionSpec(compacted({ haystackArm: null }))).toThrow(ConditionSpecError);
  });

  it("requires a policy channel iff a policy is present", () => {
    expect(() => assertConditionSpec(compacted({ policyPresent: false }))).toThrow(
      ConditionSpecError,
    );
    expect(() =>
      assertConditionSpec(compacted({ policyPresent: false, policyChannel: null })),
    ).not.toThrow();
  });

  it("rejects any delivery arm other than A3 (spec 3.3)", () => {
    // A1/A2 remain valid v1.1 conditions but are not part of the v1.2 strategy cross: they are
    // artifacts of pi's serializer and do not transfer to methods that impose no cap.
    expect(() => assertConditionSpec(compacted({ haystackArm: "A1" }))).toThrow(ConditionSpecError);
    expect(() => assertConditionSpec(compacted({ haystackArm: "A2" }))).toThrow(ConditionSpecError);
  });
});

describe("legacyLabel", () => {
  it("is null for every attacked cell, because v1.2 moved the attack position", () => {
    // v1.1 G4 put the attack before all benign turns and G5 after the first block. v1.2 uses one
    // position for both, so no attacked cell is an exact structural match for a historical one.
    for (const fillerPresent of [true, false]) {
      const spec = compacted({
        attackPresent: true,
        fillerPresent,
        haystackArm: fillerPresent ? "A3" : null,
      });
      expect(deriveLegacyLabel(spec)).toBeNull();
    }
  });

  it("never returns a label that would let a v1.2 row pool with a v1.1 rate", () => {
    // Whatever it returns is for continuity lookup only. The guard that matters is that a label
    // is never emitted for a cell whose construction differs from the historical one.
    const attacked = compacted({ attackPresent: true });
    expect(deriveLegacyLabel(attacked)).toBeNull();
  });
});

describe("cell enumeration", () => {
  const STRATEGIES = ["pi-native-cut", "fifo", "acon-ut"] as const;

  it("produces 4 x (S + 1) cells: the 2x2 crossed with full context plus each strategy", () => {
    const cells = enumerateCells({ strategies: [...STRATEGIES], policyPresent: true });
    expect(cells).toHaveLength(4 * (STRATEGIES.length + 1));
    cells.forEach((c) => expect(() => assertConditionSpec(c)).not.toThrow());
  });

  it("gives every filler setting a complete attack x handling 2x2", () => {
    const cells = enumerateCells({ strategies: [...STRATEGIES], policyPresent: true });
    for (const fillerPresent of [true, false]) {
      for (const strategy of [null, ...STRATEGIES]) {
        const arm = cells.filter(
          (c) => c.fillerPresent === fillerPresent && c.compactionStrategy === strategy,
        );
        // Exactly the attacked and unattacked halves of this arm's 2x2.
        expect(arm.map((c) => c.attackPresent).sort()).toEqual([false, true]);
      }
    }
  });

  it("emits the four full-context cells exactly once, not once per strategy", () => {
    const cells = enumerateCells({ strategies: [...STRATEGIES], policyPresent: true });
    const fulls = cells.filter((c) => c.contextHandling === "full");
    expect(fulls).toHaveLength(4);
    expect(fullContextCells({ policyPresent: true })).toHaveLength(4);
    // Adding strategies must not multiply the shared reference.
    const more = enumerateCells({
      strategies: [...STRATEGIES, "prompting-h", "lru-mechanism"],
      policyPresent: true,
    });
    expect(more.filter((c) => c.contextHandling === "full")).toHaveLength(4);
  });

  it("scales as the spec's table says", () => {
    const count = (s: number) =>
      enumerateCells({
        strategies: Array.from({ length: s }, (_, i) => ALL_IDS[i]!),
        policyPresent: true,
      }).length;
    expect(count(1)).toBe(8);
    expect(count(5)).toBe(24);
    expect(count(10)).toBe(44);
  });
});

describe("conditionSpecId", () => {
  it("is stable and distinguishes every factor that defines a cell", () => {
    const base = compacted();
    const id = conditionSpecId(base);
    expect(conditionSpecId(compacted())).toBe(id);
    for (const mutation of [
      compacted({ attackPresent: false }),
      compacted({ fillerPresent: false, haystackArm: null }),
      compacted({ compactionStrategy: "fifo" }),
      full(),
    ]) {
      expect(conditionSpecId(mutation)).not.toBe(id);
    }
  });
});

/** The ten registered arms, in `STRATEGY_IDS` order (Groups A, B, C). */
const ALL_IDS = [
  "pi-native-cut",
  "pi-native-policy-preserving",
  "baseline-structured-summary",
  "prompting-h",
  "acon-ut",
  "acon-utco",
  "trace-optimized",
  "fifo",
  "lru-mechanism",
  "lru-prompting",
] as const;
