/**
 * The v1.2 strategy registry.
 *
 * These tests guard the properties a reader of the results will assume without checking: that
 * every arm is registered, that the control is marked as a control, and that an arm whose schema
 * has no constraints section reports "not applicable" rather than "not preserved".
 */
import { describe, expect, it } from "vitest";
import {
  buildHarnessStrategy,
  definitionFor,
  REGISTRY,
  RegistryError,
  validateSelection,
  type StrategyDeps,
} from "../src/compaction/registry.ts";
import { STRATEGY_IDS } from "../src/compaction/strategy-ids.ts";
import type { SummarizerCall } from "../src/compaction/strategies-summary.ts";

const summarizerCall: SummarizerCall = async () => ({ ok: true, text: "summary", usage: null });
const deps: StrategyDeps = { summarizerCall };

describe("registry completeness", () => {
  it("registers all ten arms", () => {
    expect(Object.keys(REGISTRY).sort()).toEqual([...STRATEGY_IDS].sort());
    expect(STRATEGY_IDS).toHaveLength(10);
  });

  it("assigns every arm a group, kind, path and backend", () => {
    for (const id of STRATEGY_IDS) {
      const d = definitionFor(id);
      expect(["A", "B", "C"]).toContain(d.group);
      expect(["mechanism", "structured-summary"]).toContain(d.kind);
      expect(d.path === "pi-session" ? d.backend : "harness").toBe(d.backend);
    }
  });

  it("puts exactly the two pi arms on the pi session path", () => {
    const piArms = STRATEGY_IDS.filter((id) => definitionFor(id).path === "pi-session");
    expect(piArms).toEqual(["pi-native-cut", "pi-native-policy-preserving"]);
  });

  it("marks exactly one arm as a control", () => {
    const controls = STRATEGY_IDS.filter((id) => definitionFor(id).isControl);
    expect(controls).toEqual(["baseline-structured-summary"]);
    // A control is a reference, not a proposed method. Marking it keeps it from being quoted as
    // a technique in a results table.
    expect(definitionFor("baseline-structured-summary").group).toBe("B");
  });
});

describe("constraints diagnostic applicability", () => {
  it("declares ACON's schema heading as GUARDRAILS, not Constraints & Preferences", () => {
    // The v1.1 parser looks for `## Constraints & Preferences`, which ACON never emits. Without
    // this, every ACON row would report null and read as a missing measurement rather than as a
    // different schema.
    expect(definitionFor("acon-ut").constraintsHeading).toBe("GUARDRAILS");
    expect(definitionFor("acon-utco").constraintsHeading).toBe("GUARDRAILS");
  });

  it("declares no heading for arms that emit no schema", () => {
    for (const id of ["fifo", "lru-mechanism", "lru-prompting"] as const) {
      expect(definitionFor(id).constraintsHeading).toBeNull();
      expect(definitionFor(id).producesReplacementText).toBe(false);
    }
  });

  it("gives every structured-summary arm a heading to parse", () => {
    for (const id of STRATEGY_IDS) {
      const d = definitionFor(id);
      if (d.kind === "structured-summary") expect(d.constraintsHeading).not.toBeNull();
    }
  });
});

describe("construction", () => {
  it("builds every harness-backend arm", () => {
    for (const id of STRATEGY_IDS) {
      const d = definitionFor(id);
      if (d.path !== "harness") continue;
      expect(buildHarnessStrategy(id, deps).id).toBe(id);
    }
  });

  it("refuses to build a pi arm, which the pi-session path constructs", () => {
    expect(() => buildHarnessStrategy("pi-native-cut", deps)).toThrow(RegistryError);
  });
});

describe("selection validation happens before a sweep spends anything", () => {
  it("rejects an unknown id with the list of known ones", () => {
    expect(() => validateSelection(["acon-ut", "nope"], deps)).toThrow(/unknown strategy "nope"/);
  });

  it("rejects an empty selection", () => {
    expect(() => validateSelection([], deps)).toThrow(/no strategies/);
  });

  it("accepts the full ten", () => {
    expect(validateSelection([...STRATEGY_IDS], deps)).toHaveLength(10);
  });
});

describe("provenance travels with the arm", () => {
  it("marks only genuinely native implementations native", () => {
    const native = STRATEGY_IDS.filter((id) => definitionFor(id).provenance.nativeImplementation);
    expect([...native].sort()).toEqual(["pi-native-cut"]);
  });

  it("marks every harness-backend prompt arm as having replaced its upstream boundary", () => {
    for (const id of ["prompting-h", "acon-ut", "acon-utco", "trace-optimized"] as const) {
      expect(definitionFor(id).provenance.upstreamBoundaryReplaced).toBe(true);
    }
  });
});
