/**
 * The factor flags of `plan`, `smoke` and `run`, and their translation into a Configuration.
 */
import { CHANNEL_MODES, isChannelMode } from "../channels/modes.ts";
import { DEFENSE_IDS } from "../defenses/defenses.ts";
import {
  ATTACK_METHODS,
  COHORT_IDS,
  DEFAULT_COHORT,
  isAttackMethod,
  isCohort,
  isDefense,
  isStrategyChoice,
  STRATEGY_CHOICES,
  type Configuration,
  type RuleViolation,
} from "../plan/configuration.ts";
import { one, type FlagSpec, type ParsedArgs } from "./args.ts";

export const FACTOR_FLAGS: Record<string, FlagSpec> = {
  agent_model: {},
  compactor_model: {},
  compaction_strategies: {},
  compaction_budget: {},
  repetitions: {},
  rule_present: {},
  rule_channel: {},
  filler: {},
  injection_attack_method: {},
  defense_method: {},
  cohort: {},
};

export const EXECUTION_FLAGS: Record<string, FlagSpec> = {
  out: { allowComma: true },
  resume: { boolean: true },
  concurrency: {},
  batch_size: {},
};

export const FACTOR_HELP = `Factor flags (one value each; every run covers all 17 cases):
  --agent_model <slug>                 OpenRouter model for the agent (required)
  --compactor_model <slug>             OpenRouter model for the compactor (default: the agent model)
  --compaction_strategies <id>         none (full context) | ${STRATEGY_CHOICES.filter((s) => s !== "none").join(" | ")}
  --compaction_budget <none|tokens>    token cap on the post-compaction context (default none)
  --repetitions <k>                    repetitions per case and channel (default 3)
  --rule_present <yes|no>              deliver the operating rule (default yes)
  --rule_channel <mode>                ${CHANNEL_MODES.join(" | ")} (default home)
  --filler <yes|no>                    add 96,000 chars of RULER-style filler (default no)
  --injection_attack_method <m>        ${ATTACK_METHODS.join(" | ")} (default none)
  --defense_method <d>                 ${DEFENSE_IDS.join(" | ")} (default none)
  --cohort <c>                         ${COHORT_IDS.join(" | ")} (default ${DEFAULT_COHORT}); a past
                                       study's cohort writes that study's ids and row shape`;

function unknown(flag: string, value: string, allowed: readonly string[]): RuleViolation {
  return {
    id: "UNKNOWN-VALUE",
    reason: `--${flag} ${value} is not a known value.`,
    fix: `use one of: ${allowed.join(", ")}`,
  };
}

function yesNo(args: ParsedArgs, flag: string, dflt: boolean, out: RuleViolation[]): boolean {
  const v = one(args, flag);
  if (v === undefined) return dflt;
  if (v === "yes") return true;
  if (v === "no") return false;
  out.push(unknown(flag, v, ["yes", "no"]));
  return dflt;
}

function positiveInt(args: ParsedArgs, flag: string, dflt: number | null, out: RuleViolation[]): number | null {
  const v = one(args, flag);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    out.push({ id: "UNKNOWN-VALUE", reason: `--${flag} ${v} is not a positive integer.`, fix: `give --${flag} an integer >= 1` });
    return dflt;
  }
  return n;
}

/** Build the Configuration a command's flags describe, or the violations that stop it. */
export function configurationFromFlags(args: ParsedArgs): { configuration: Configuration | null; violations: RuleViolation[] } {
  const out: RuleViolation[] = [];

  const agentModel = one(args, "agent_model");
  if (!agentModel) out.push({ id: "MISSING-FLAG", reason: "--agent_model is required.", fix: "give --agent_model <openrouter slug>, e.g. z-ai/glm-5.3-flash" });

  const strategyRaw = one(args, "compaction_strategies");
  if (strategyRaw === undefined) {
    out.push({ id: "MISSING-FLAG", reason: "--compaction_strategies is required.", fix: `give one of: ${STRATEGY_CHOICES.join(", ")}` });
  } else if (!isStrategyChoice(strategyRaw)) {
    out.push(unknown("compaction_strategies", strategyRaw, STRATEGY_CHOICES));
  }

  const budgetRaw = one(args, "compaction_budget");
  let budget: number | null = null;
  if (budgetRaw !== undefined && budgetRaw !== "none") budget = positiveInt(args, "compaction_budget", null, out);

  const repetitions = positiveInt(args, "repetitions", 3, out)!;
  const rulePresent = yesNo(args, "rule_present", true, out);
  const filler = yesNo(args, "filler", false, out);

  const channelRaw = one(args, "rule_channel");
  if (channelRaw !== undefined && !isChannelMode(channelRaw)) out.push(unknown("rule_channel", channelRaw, CHANNEL_MODES));

  const attackRaw = one(args, "injection_attack_method") ?? "none";
  if (!isAttackMethod(attackRaw)) out.push(unknown("injection_attack_method", attackRaw, ATTACK_METHODS));

  const defenseRaw = one(args, "defense_method") ?? "none";
  if (!isDefense(defenseRaw)) out.push(unknown("defense_method", defenseRaw, DEFENSE_IDS));

  const cohortRaw = one(args, "cohort") ?? DEFAULT_COHORT;
  if (!isCohort(cohortRaw)) out.push(unknown("cohort", cohortRaw, COHORT_IDS));

  if (out.length > 0 || !agentModel || !strategyRaw || !isStrategyChoice(strategyRaw)) {
    return { configuration: null, violations: out };
  }

  const compactorRaw = one(args, "compactor_model");
  const configuration: Configuration = {
    agentModel,
    compactorModel: compactorRaw ?? agentModel,
    compactorModelExplicit: compactorRaw !== undefined,
    strategy: strategyRaw,
    budget,
    repetitions,
    rulePresent,
    ruleChannel: rulePresent ? (channelRaw && isChannelMode(channelRaw) ? channelRaw : "home") : channelRaw && isChannelMode(channelRaw) ? channelRaw : null,
    ruleChannelExplicit: channelRaw !== undefined,
    filler,
    attack: attackRaw as Configuration["attack"],
    defense: defenseRaw as Configuration["defense"],
    cohort: cohortRaw as Configuration["cohort"],
  };
  return { configuration, violations: [] };
}

/** One line describing a configuration, for logs and `plan`. */
export function describeConfiguration(c: Configuration): string {
  return [
    `agent=${c.agentModel}`,
    ...(c.compactorModel !== c.agentModel ? [`compactor=${c.compactorModel}`] : []),
    `strategy=${c.strategy}`,
    `budget=${c.budget ?? "none"}`,
    `rule=${c.rulePresent ? `yes/${c.ruleChannel}` : "no"}`,
    `filler=${c.filler ? "yes" : "no"}`,
    `attack=${c.attack}`,
    `defense=${c.defense}`,
    `k=${c.repetitions}`,
    `cohort=${c.cohort}`,
  ].join(" ");
}
