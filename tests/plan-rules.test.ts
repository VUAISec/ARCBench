/**
 * The command-setup rules: each one refuses the combination it names and accepts the nearest valid
 * one. A rule that never fires, or fires on a valid command, fails here.
 */
import { describe, expect, it } from "vitest";
import { factorRuleViolations, type Configuration } from "../src/plan/configuration.ts";
import { validateConfiguration } from "../src/plan/episodes.ts";

function config(over: Partial<Configuration> = {}): Configuration {
  return {
    agentModel: "z-ai/glm-5.3-flash",
    compactorModel: "z-ai/glm-5.3-flash",
    compactorModelExplicit: false,
    strategy: "prompting-h",
    budget: null,
    repetitions: 3,
    rulePresent: true,
    ruleChannel: "home",
    ruleChannelExplicit: false,
    filler: false,
    attack: "none",
    defense: "none",
    cohort: "cccb-v1",
    ...over,
  };
}

const ids = (c: Configuration) => validateConfiguration(c).map((v) => v.id);

describe("COMPACTOR-NO-MODEL", () => {
  it.each(["none", "fifo", "lru-mechanism"] as const)("refuses an explicit compactor under %s", (s) => {
    expect(ids(config({ strategy: s, compactorModel: "x/y", compactorModelExplicit: true }))).toContain("COMPACTOR-NO-MODEL");
  });
  it("accepts it under a strategy that calls a model, including the LRU ranker", () => {
    for (const s of ["prompting-h", "pi-native-cut", "lru-prompting"] as const) {
      expect(ids(config({ strategy: s, compactorModel: "x/y", compactorModelExplicit: true }))).toEqual([]);
    }
  });
});

describe("BUDGET-NOT-PROMPT", () => {
  it.each(["none", "fifo", "lru-mechanism", "lru-prompting"] as const)("refuses a budget on %s", (s) => {
    expect(ids(config({ strategy: s, budget: 300 }))).toContain("BUDGET-NOT-PROMPT");
  });
  it.each([
    "pi-native-cut",
    "pi-native-policy-preserving",
    "baseline-structured-summary",
    "prompting-h",
    "acon-ut",
    "acon-utco",
    "trace-optimized",
  ] as const)("accepts a budget on %s", (s) => {
    expect(ids(config({ strategy: s, budget: 300 }))).toEqual([]);
  });
});

describe("CHANNEL-NO-RULE", () => {
  it("refuses an explicit channel without a rule", () => {
    expect(ids(config({ rulePresent: false, ruleChannel: "c2", ruleChannelExplicit: true }))).toContain("CHANNEL-NO-RULE");
  });
  it("accepts a rule-absent command that names no channel", () => {
    expect(ids(config({ rulePresent: false, ruleChannel: null }))).toEqual([]);
  });
});

describe("DEFENSE rules", () => {
  it("DEFENSE-NO-RULE refuses a defense without a rule", () => {
    expect(ids(config({ rulePresent: false, ruleChannel: null, defense: "sandwich" }))).toContain("DEFENSE-NO-RULE");
  });
  it.each(["none", "fifo", "lru-mechanism"] as const)("DEFENSE-NO-PROMPT refuses a defense on %s", (s) => {
    expect(ids(config({ strategy: s, defense: "isolation" }))).toContain("DEFENSE-NO-PROMPT");
  });
  it.each(["pi-native-cut", "pi-native-policy-preserving"] as const)("DEFENSE-PI refuses a defense on %s", (s) => {
    expect(ids(config({ strategy: s, defense: "instructional" }))).toContain("DEFENSE-PI");
  });
  it("DEFENSE-RANKER refuses a defense on lru-prompting", () => {
    expect(ids(config({ strategy: "lru-prompting", defense: "sandwich" }))).toContain("DEFENSE-RANKER");
  });
  it.each(["prompting-h", "baseline-structured-summary", "acon-ut", "acon-utco", "trace-optimized"] as const)(
    "accepts every defense on %s (option B)",
    (s) => {
      for (const d of ["isolation", "instructional", "sandwich", "rule-preserving"] as const) {
        expect(ids(config({ strategy: s, defense: d }))).toEqual([]);
      }
    },
  );
});

describe("filler and attack need neither compaction nor the rule (decision D5)", () => {
  it("allows them under full context and without the rule", () => {
    expect(ids(config({ strategy: "none", filler: true, attack: "escape" }))).toEqual([]);
    expect(ids(config({ rulePresent: false, ruleChannel: null, filler: true, attack: "legacy" }))).toEqual([]);
    expect(ids(config({ strategy: "fifo", attack: "legacy" }))).toEqual([]);
  });
});

describe("every violation is reported, not just the first", () => {
  it("lists all broken rules at once", () => {
    const v = factorRuleViolations(
      config({ strategy: "fifo", budget: 300, defense: "sandwich", compactorModel: "x/y", compactorModelExplicit: true }),
    );
    expect(v.map((x) => x.id).sort()).toEqual(["BUDGET-NOT-PROMPT", "COMPACTOR-NO-MODEL", "DEFENSE-NO-PROMPT"]);
    for (const x of v) {
      expect(x.reason.length).toBeGreaterThan(20);
      expect(x.fix.length).toBeGreaterThan(5);
    }
  });
});

describe("cohort rules", () => {
  it("v1.1-ladder refuses what its ids cannot encode", () => {
    const c = config({ cohort: "v1.1-ladder", strategy: "acon-ut" });
    expect(ids(c)).toContain("COHORT-v1.1-ladder");
    expect(ids(config({ cohort: "v1.1-ladder", strategy: "none", filler: true }))).toContain("COHORT-v1.1-ladder");
    expect(ids(config({ cohort: "v1.1-ladder", attack: "escape" }))).toContain("COHORT-v1.1-ladder");
    expect(ids(config({ cohort: "v1.1-ladder", ruleChannel: "home-paired", filler: true, attack: "legacy" }))).toEqual([]);
  });
  it("v1.3-newcase-v1.2strategies refuses a budget, a defense, a new attack and a multi-channel mode", () => {
    const cohort = "v1.3-newcase-v1.2strategies" as const;
    expect(ids(config({ cohort, budget: 300 }))).toContain(`COHORT-${cohort}`);
    expect(ids(config({ cohort, defense: "sandwich" }))).toContain(`COHORT-${cohort}`);
    expect(ids(config({ cohort, attack: "escape" }))).toContain(`COHORT-${cohort}`);
    expect(ids(config({ cohort, ruleChannel: "home-paired" }))).toContain(`COHORT-${cohort}`);
    expect(ids(config({ cohort, strategy: "fifo", filler: true, attack: "legacy" }))).toEqual([]);
  });
  it("v1.4-token-constraint needs filler and a ladder rung", () => {
    const cohort = "v1.4-token-constraint" as const;
    expect(ids(config({ cohort, budget: 300 }))).toContain(`COHORT-${cohort}`);
    expect(ids(config({ cohort, filler: true, budget: 450 }))).toContain(`COHORT-${cohort}`);
    expect(ids(config({ cohort, filler: true, budget: 300 }))).toEqual([]);
    expect(ids(config({ cohort, filler: true, strategy: "none" }))).toEqual([]);
  });
  it("v1.6-ipi-attack-defense runs prompting-h or full context, without filler", () => {
    const cohort = "v1.6-ipi-attack-defense" as const;
    expect(ids(config({ cohort, strategy: "acon-ut" }))).toContain(`COHORT-${cohort}`);
    expect(ids(config({ cohort, filler: true }))).toContain(`COHORT-${cohort}`);
    expect(ids(config({ cohort, attack: "escape", defense: "sandwich" }))).toEqual([]);
    expect(ids(config({ cohort, strategy: "none", attack: "combined" }))).toEqual([]);
  });
  it("legacy cohorts refuse a compactor model different from the agent", () => {
    for (const cohort of ["v1.1-ladder", "v1.3-newcase-v1.2strategies", "v1.4-token-constraint", "v1.6-ipi-attack-defense"] as const) {
      expect(ids(config({ cohort, filler: cohort === "v1.4-token-constraint", compactorModel: "x/y", compactorModelExplicit: true }))).toContain(`COHORT-${cohort}`);
    }
  });
});
