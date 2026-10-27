/**
 * Cohort id schemes against ids copied from the rows and manifests on disk.
 *
 * Every expected string below was read out of a past study's results (see results/README.md), so
 * these pin the formats to what those studies actually wrote. The full-plan comparison over every
 * episode lives in tests/golden-plan.test.ts.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import { planEpisodes } from "../src/plan/episodes.ts";
import { ladderCondition } from "../src/plan/cohorts.ts";
import type { Configuration } from "../src/plan/configuration.ts";

const cfg = loadConfig();
const rows = loadTaskRows("data/rule-loss/cases.jsonl");
const GLM = "z-ai/glm-5.3-flash";

function config(over: Partial<Configuration>): Configuration {
  return {
    agentModel: GLM,
    compactorModel: GLM,
    compactorModelExplicit: false,
    strategy: "prompting-h",
    budget: null,
    repetitions: 1,
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

const find = (c: Configuration, caseId: string, channel: string | null = null) =>
  planEpisodes(c, rows, cfg).find((e) => e.caseId === caseId && (channel === null || e.channel === channel))!;

describe("v1.1-ladder", () => {
  it("names G5 on c2 as the nocomfound manifest did", () => {
    const e = find(config({ cohort: "v1.1-ladder", ruleChannel: "home-paired", filler: true, attack: "legacy" }), "pname", "c2");
    expect(e.runId).toBe("governance-pname-g5-c2-a3-harness-z-ai-glm-5-3-flash-rep-00");
    expect(e.pairKey).toBe("governance|pname|g5|ch-c2|arm-A3|model-z-ai/glm-5.3-flash|temp-0.7|krt-100|seed-7|rep-00");
    expect(e.plannedV11).toEqual({
      runId: "governance-pname-g5-c2-a3-harness-z-ai-glm-5-3-flash-rep-00",
      pairKey: "governance|pname|g5|ch-c2|arm-A3|model-z-ai/glm-5.3-flash|temp-0.7|krt-100|seed-7|rep-00",
      family: "governance",
      condition: "G5",
      taskOrSampleId: "pname",
      compactorBackend: "harness",
      policyChannel: "c2",
      haystackArm: "A3",
      compactionStrategy: "prompting-h",
      repetition: 0,
      fixtureOnly: false,
      reportable: true,
      manualCompactions: 1,
      model: GLM,
      seed: 7,
    });
  });
  it("names G0 and G2n with no channel", () => {
    expect(find(config({ cohort: "v1.1-ladder", strategy: "none", rulePresent: false, ruleChannel: null }), "pname").runId).toBe(
      "governance-pname-g0-z-ai-glm-5-3-flash-rep-00",
    );
    expect(find(config({ cohort: "v1.1-ladder", rulePresent: false, ruleChannel: null }), "pname").runId).toBe(
      "governance-pname-g2n-harness-z-ai-glm-5-3-flash-rep-00",
    );
  });
  it("maps every configuration to its G-label", () => {
    const c = (o: Partial<Configuration>) => ladderCondition(config(o));
    expect(c({ strategy: "none" })).toBe("G1");
    expect(c({ strategy: "none", rulePresent: false })).toBe("G0");
    expect(c({})).toBe("G2");
    expect(c({ filler: true })).toBe("G3");
    expect(c({ attack: "legacy" })).toBe("G4");
    expect(c({ filler: true, attack: "legacy", rulePresent: false })).toBe("G5n");
  });
});

describe("v1.2-shape cohorts", () => {
  it("v1.3-newcase-v1.2strategies full context, attacked, email on c3", () => {
    const e = find(config({ cohort: "v1.3-newcase-v1.2strategies", strategy: "none", attack: "legacy" }), "email");
    expect(e.runId).toBe("v12-email-pol-nofill-atk-full-z-ai-glm-5-3-flash-rep-00");
    expect(e.sourceTranscriptId).toBe("v1.2|email|rep-00|pol-c3|nofill|atk");
    expect(e.pairKey).toBe("v1.2|email|rep-00|pol-c3|nofill|atk|model-z-ai/glm-5.3-flash|temp-0.7|seed-7");
    expect(e.configCohort).toBe("v1.3-newcase-v1.2strategies");
  });
  it("v1.3-newcase-v1.2strategies keeps the legacy label on pi-native-cut's unattacked cells", () => {
    const e = find(config({ cohort: "v1.3-newcase-v1.2strategies", strategy: "pi-native-cut" }), "email");
    expect(e.runId).toBe("v12-email-pol-nofill-noatk-pi-native-cut-z-ai-glm-5-3-flash-rep-00");
    expect(e.spec!.legacyLabel).toBe("G2");
  });
  it("v1.4-token-constraint budget rung", () => {
    const e = find(config({ cohort: "v1.4-token-constraint", strategy: "pi-native-cut", filler: true, budget: 200 }), "email");
    expect(e.runId).toBe("v14-email-noatk-pi-native-cut-b200-z-ai-glm-5-3-flash-rep-00");
    expect(e.sourceTranscriptId).toBe("v1.4|email|rep-00|pol-c3|fill-A3|noatk");
    expect(Object.keys(e.spec!).slice(-2)).toEqual(["outputBudgetTokens", "budgetEnforcement"]);
  });
  it("v1.6-ipi-attack-defense compacted cell and full-context control", () => {
    const c = config({ cohort: "v1.6-ipi-attack-defense", repetitions: 6 });
    const e = find(c, "email");
    expect(e.runId).toBe("v16-email-atk-none-def-none-z-ai-glm-5-3-flash-rep-00");
    expect(JSON.stringify(e.spec)).toBe(
      '{"policyPresent":true,"fillerPresent":false,"attackPresent":false,"haystackArm":null,"attackInsertion":"after-benign-block-1","policyChannel":"c3","protocolVersion":"v1.2","legacyLabel":null,"contextHandling":"compacted","compactionStrategy":"prompting-h","compactionBackend":"harness","attackTechnique":null,"defense":"none"}',
    );
    const ctl = find(config({ cohort: "v1.6-ipi-attack-defense", strategy: "none", attack: "escape" }), "email");
    expect(ctl.runId).toBe("v16-email-atk-escape-def-none-z-ai-glm-5-3-flash-rep-00-full");
  });
});

describe("cccb-v1", () => {
  it("encodes every factor, and the compactor only when it differs", () => {
    const e = find(config({ strategy: "acon-ut", budget: 300, attack: "escape", defense: "sandwich" }), "pname");
    expect(e.runId).toBe("cccb-pname-pol-c1-nofill-atk-escape-def-sandwich-acon-ut-b300-z-ai-glm-5-3-flash-rep-00");
    const x = find(config({ compactorModel: "deepseek/deepseek-v4-flash-0731", compactorModelExplicit: true }), "pname");
    expect(x.runId).toContain("-cm-deepseek-deepseek-v4-flash-0731-");
  });
  it("gives each channel of a paired mode its own episode", () => {
    const eps = planEpisodes(config({ ruleChannel: "all" }), rows, cfg);
    expect(eps).toHaveLength(17 * 4);
    expect(new Set(eps.map((e) => e.runId)).size).toBe(eps.length);
  });
});

describe("episode counts match the studies", () => {
  it("one ladder policy condition on home-paired is 34 episodes per repetition; a no-rule one is 17", () => {
    expect(planEpisodes(config({ cohort: "v1.1-ladder", ruleChannel: "home-paired", repetitions: 3 }), rows, cfg)).toHaveLength(102);
    expect(planEpisodes(config({ cohort: "v1.1-ladder", rulePresent: false, ruleChannel: null, repetitions: 3 }), rows, cfg)).toHaveLength(51);
  });
});
