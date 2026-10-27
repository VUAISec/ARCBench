/**
 * One benchmark configuration: the value of every factor flag for one `arcbench run`.
 *
 * A command runs exactly one configuration over all 17 cases × the channel(s) its mode assigns ×
 * k repetitions. Grids are built by scripts that issue several commands (scripts/rqN/sM-<name>/run.sh), never by
 * crossing lists inside one command -- so every rule below is about one configuration, and a
 * command is either valid or not.
 */
import { ATTACK_TECHNIQUES, type AttackTechnique } from "../attacks/attack-library.ts";
import type { ChannelMode } from "../channels/modes.ts";
import { DEFENSE_IDS, type DefenseId } from "../defenses/defenses.ts";
import { STRATEGY_IDS, usesPiSessionPath, type StrategyId } from "../compaction/strategy-ids.ts";

/** `none` is full context: no compaction at all. */
export type StrategyChoice = StrategyId | "none";
export const STRATEGY_CHOICES: readonly StrategyChoice[] = ["none", ...STRATEGY_IDS];

/** The seven strategies that write replacement text from a prompt; the only ones a budget can cap. */
export const PROMPT_BASED_STRATEGIES: readonly StrategyId[] = [
  "pi-native-cut",
  "pi-native-policy-preserving",
  "baseline-structured-summary",
  "prompting-h",
  "acon-ut",
  "acon-utco",
  "trace-optimized",
];

/** Strategies that make no model call: nothing for a compactor model or a defense to act on. */
export const NO_MODEL_STRATEGIES: readonly StrategyChoice[] = ["none", "fifo", "lru-mechanism"];

/** Strategies whose compactor prompt the defenses are defined for. */
export const DEFENSE_CAPABLE_STRATEGIES: readonly StrategyId[] = [
  "prompting-h",
  "baseline-structured-summary",
  "acon-ut",
  "acon-utco",
  "trace-optimized",
];

export type AttackMethod = AttackTechnique | "none";
export const ATTACK_METHODS: readonly AttackMethod[] = ["none", ...ATTACK_TECHNIQUES];

export const COHORT_IDS = [
  "cccb-v1",
  "v1.1-ladder",
  "v1.3-newcase-v1.2strategies",
  "v1.4-token-constraint",
  "v1.6-ipi-attack-defense",
] as const;
export type CohortId = (typeof COHORT_IDS)[number];
export const DEFAULT_COHORT: CohortId = "cccb-v1";

export interface Configuration {
  agentModel: string;
  /** Resolved: the agent model unless `--compactor_model` named another. */
  compactorModel: string;
  /** True when `--compactor_model` was given; rules fire only on an explicit flag. */
  compactorModelExplicit: boolean;
  strategy: StrategyChoice;
  /** Token budget on the post-compaction context, or null for unconstrained. */
  budget: number | null;
  repetitions: number;
  rulePresent: boolean;
  /** Null iff the rule is absent. */
  ruleChannel: ChannelMode | null;
  /** True when `--rule_channel` was given explicitly. */
  ruleChannelExplicit: boolean;
  filler: boolean;
  attack: AttackMethod;
  defense: DefenseId;
  cohort: CohortId;
}

export interface RuleViolation {
  id: string;
  /** Why the combination cannot run, stated in terms of what the flags do. */
  reason: string;
  /** What to change instead. */
  fix: string;
}

const list = (xs: readonly string[]) => xs.join(", ");

/**
 * The command-setup rules. Returns every violation, not just the first.
 *
 * Cohort-specific rules (what a legacy cohort's ids can encode) live in `cohorts.ts` and are added
 * by `validateConfiguration`.
 */
export function factorRuleViolations(c: Configuration): RuleViolation[] {
  const out: RuleViolation[] = [];
  const s = c.strategy;

  if (c.compactorModelExplicit && NO_MODEL_STRATEGIES.includes(s)) {
    out.push({
      id: "COMPACTOR-NO-MODEL",
      reason:
        `--compactor_model ${c.compactorModel} cannot apply to --compaction_strategies ${s}: ` +
        (s === "none"
          ? "with no compaction there is no compactor to run a model."
          : `${s} makes no model call, so the compactor model would be unused.`),
      fix: "drop --compactor_model, or choose a strategy that calls a model",
    });
  }

  if (c.budget !== null && (s === "none" || !PROMPT_BASED_STRATEGIES.includes(s))) {
    out.push({
      id: "BUDGET-NOT-PROMPT",
      reason:
        `--compaction_budget ${c.budget} cannot apply to --compaction_strategies ${s}: ` +
        (s === "none"
          ? "with no compaction there is no summary to cap."
          : `the budget caps the summary a compactor writes, and ${s} writes none -- it keeps or drops existing content.`),
      fix: `use --compaction_budget none, or one of: ${list(PROMPT_BASED_STRATEGIES)}`,
    });
  }

  if (!c.rulePresent && c.ruleChannelExplicit) {
    out.push({
      id: "CHANNEL-NO-RULE",
      reason: `--rule_channel ${c.ruleChannel ?? ""} cannot apply to --rule_present no: there is no rule to deliver.`,
      fix: "drop --rule_channel, or use --rule_present yes",
    });
  }

  if (c.defense !== "none") {
    if (!c.rulePresent) {
      out.push({
        id: "DEFENSE-NO-RULE",
        reason: `--defense_method ${c.defense} cannot apply to --rule_present no: a defense protects the rule, and there is none.`,
        fix: "use --defense_method none, or --rule_present yes",
      });
    }
    if (NO_MODEL_STRATEGIES.includes(s)) {
      out.push({
        id: "DEFENSE-NO-PROMPT",
        reason:
          `--defense_method ${c.defense} cannot apply to --compaction_strategies ${s}: ` +
          (s === "none"
            ? "a defense changes the compactor's prompt, and with no compaction there is no compactor."
            : `a defense changes the compactor's prompt, and ${s} has none.`),
        fix: `use --defense_method none, or one of: ${list(DEFENSE_CAPABLE_STRATEGIES)}`,
      });
    } else if (s !== "none" && usesPiSessionPath(s)) {
      out.push({
        id: "DEFENSE-PI",
        reason:
          `--defense_method ${c.defense} cannot apply to --compaction_strategies ${s}: pi assembles its own ` +
          "compaction prompt inside its session and exposes only an appended instruction, so the defense cannot be placed.",
        fix: `use --defense_method none, or one of: ${list(DEFENSE_CAPABLE_STRATEGIES)}`,
      });
    } else if (s === "lru-prompting") {
      out.push({
        id: "DEFENSE-RANKER",
        reason:
          `--defense_method ${c.defense} cannot apply to --compaction_strategies lru-prompting: its model ranks ` +
          "messages rather than writing a summary, and no defense transform is defined for the ranking prompt.",
        fix: `use --defense_method none, or one of: ${list(DEFENSE_CAPABLE_STRATEGIES)}`,
      });
    }
  }

  return out;
}

export function isStrategyChoice(v: string): v is StrategyChoice {
  return (STRATEGY_CHOICES as readonly string[]).includes(v);
}
export function isAttackMethod(v: string): v is AttackMethod {
  return (ATTACK_METHODS as readonly string[]).includes(v);
}
export function isDefense(v: string): v is DefenseId {
  return (DEFENSE_IDS as readonly string[]).includes(v);
}
export function isCohort(v: string): v is CohortId {
  return (COHORT_IDS as readonly string[]).includes(v);
}
