/** Flag parsing: one value per flag, unknown flags and bad values refused with a reason. */
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { FACTOR_FLAGS, configurationFromFlags } from "../src/cli/configuration-flags.ts";

const parse = (argv: string[]) => parseArgs(argv, FACTOR_FLAGS);

describe("parseArgs", () => {
  it("refuses a comma list on a factor flag", () => {
    expect(parse(["--compaction_strategies", "prompting-h,acon-ut"]).violations.map((v) => v.id)).toEqual(["ONE-VALUE-PER-FLAG"]);
  });
  it("refuses a flag given twice", () => {
    expect(parse(["--filler", "yes", "--filler", "no"]).violations.map((v) => v.id)).toEqual(["ONE-VALUE-PER-FLAG"]);
  });
  it("refuses an unknown flag and names the known ones", () => {
    const v = parse(["--cases", "email"]).violations;
    expect(v.map((x) => x.id)).toEqual(["UNKNOWN-FLAG"]);
    expect(v[0]!.fix).toContain("--agent_model");
  });
  it("accepts --flag=value and kebab spellings", () => {
    const a = parse(["--agent-model=z-ai/glm-5.3-flash", "--compaction_strategies", "none"]);
    expect(a.violations).toEqual([]);
    expect(a.values.get("agent_model")).toEqual(["z-ai/glm-5.3-flash"]);
  });
});

describe("configurationFromFlags", () => {
  it("requires the agent model and a strategy", () => {
    expect(configurationFromFlags(parse([])).violations.map((v) => v.id)).toEqual(["MISSING-FLAG", "MISSING-FLAG"]);
  });
  it("defaults: compactor = agent, home channel, no filler, no attack, no defense, k = 3, cccb-v1", () => {
    const { configuration } = configurationFromFlags(parse(["--agent_model", "a/b", "--compaction_strategies", "prompting-h"]));
    expect(configuration).toMatchObject({
      compactorModel: "a/b",
      compactorModelExplicit: false,
      ruleChannel: "home",
      filler: false,
      attack: "none",
      defense: "none",
      repetitions: 3,
      budget: null,
      cohort: "cccb-v1",
    });
  });
  it("refuses unknown values with the allowed list", () => {
    const { violations } = configurationFromFlags(
      parse(["--agent_model", "a/b", "--compaction_strategies", "hermes", "--injection_attack_method", "jailbreak"]),
    );
    expect(violations.map((v) => v.id)).toEqual(["UNKNOWN-VALUE", "UNKNOWN-VALUE"]);
    expect(violations[0]!.fix).toContain("prompting-h");
  });
  it("reads --compaction_budget none as unconstrained and refuses a non-integer", () => {
    expect(configurationFromFlags(parse(["--agent_model", "a", "--compaction_strategies", "acon-ut", "--compaction_budget", "none"])).configuration!.budget).toBeNull();
    expect(configurationFromFlags(parse(["--agent_model", "a", "--compaction_strategies", "acon-ut", "--compaction_budget", "3.5"])).violations[0]!.id).toBe("UNKNOWN-VALUE");
  });
});
