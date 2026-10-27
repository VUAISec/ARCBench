/**
 * Cohorts: which past study's ids, row shape and transcript layout a command writes.
 *
 * `--cohort` is metadata, not a factor. It exists so a command that reproduces a past
 * configuration writes rows that read field-for-field like that study's rows -- same `runId`,
 * `pairKey`, `sourceTranscriptId`, `configCohort` and spec -- and so the copied results and new
 * runs evaluate side by side.
 *
 * | cohort                        | rows | layout | run ids encode                |
 * |-------------------------------|------|--------|-------------------------------|
 * | `v1.1-ladder`                 | v1.1 | v1.1   | the factors that study varied |
 * | `v1.3-newcase-v1.2strategies` | v1.2 | v1.2   | the factors that study varied |
 * | `v1.4-token-constraint`       | v1.2 | v1.2   | the factors that study varied |
 * | `v1.6-ipi-attack-defense`     | v1.2 | v1.2   | the factors that study varied |
 * | `cccb-v1` (default)           | v1.2 | v1.2   | every factor                  |
 *
 * A legacy cohort's id format encodes only the factors that study varied, so each refuses any
 * configuration its ids could not tell apart (rule id `COHORT-<cohort>`). The id functions
 * reproduce each study's id scheme exactly.
 */
import { modelSlug, type BenchmarkConfig } from "../config/config.ts";
import type { GovernanceCondition, PlannedRun, PolicyChannel } from "../harness/schema.ts";
import type { StrategyId } from "../compaction/strategy-ids.ts";
import { V14_BUDGET_LADDER } from "../compaction/budget.ts";
import { isMultiChannelMode } from "../channels/modes.ts";
import {
  defaultBackendFor,
  deriveLegacyLabel,
  V12_HAYSTACK_ARM,
  type ConditionSpec,
  type ConditionSpecCccb,
  type ConditionSpecV14,
  type ConditionSpecV16,
} from "./spec.ts";
import {
  PROMPT_BASED_STRATEGIES,
  type CohortId,
  type Configuration,
  type RuleViolation,
} from "./configuration.ts";

export type RowShape = "v1.1" | "v1.2";
export type Layout = "v1.1" | "v1.2";

/** The per-episode coordinates a cohort needs to name an episode. */
export interface EpisodeCoordinates {
  caseId: string;
  channel: PolicyChannel | null;
  repetition: number;
}

export interface EpisodeIdentity {
  runId: string;
  pairKey: string;
  /** Null for v1.1-shape rows, which never carried one. */
  sourceTranscriptId: string | null;
  /** v1.2-shape rows: the spec exactly as the cohort's rows carry it. */
  spec: ConditionSpec | null;
  /** v1.1-shape rows: the planned run exactly as the ladder manifest carried it. */
  plannedV11: PlannedRun | null;
  legacyCondition: GovernanceCondition | null;
  configCohort: string;
  manualCompactions: 0 | 1;
}

export interface CohortDefinition {
  id: CohortId;
  rowShape: RowShape;
  layout: Layout;
  /** What this cohort's rows record in `provenance.policyChannel` / `.compactionStrategy`. */
  provenance: (c: Configuration, channel: PolicyChannel | null) => {
    policyChannel: string;
    compactionStrategy: string;
  };
  violations: (c: Configuration) => RuleViolation[];
  identify: (c: Configuration, at: EpisodeCoordinates, cfg: BenchmarkConfig) => EpisodeIdentity;
}

const rep2 = (n: number) => String(n).padStart(2, "0");

function cohortViolation(cohort: CohortId, reason: string): RuleViolation {
  return {
    id: `COHORT-${cohort}`,
    reason: `--cohort ${cohort} ${reason}`,
    fix: "use --cohort cccb-v1 (the default), whose ids encode every factor",
  };
}

/** Rules shared by every legacy cohort: none of their ids encode a separate compactor model. */
function sameCompactor(cohort: CohortId, c: Configuration): RuleViolation[] {
  return c.compactorModel !== c.agentModel
    ? [cohortViolation(cohort, `ids do not encode a compactor model; --compactor_model must equal --agent_model.`)]
    : [];
}

function singleChannel(cohort: CohortId, c: Configuration): RuleViolation[] {
  return c.ruleChannel && isMultiChannelMode(c.ruleChannel)
    ? [
        cohortViolation(
          cohort,
          `ids do not encode the channel, so a case may run on one channel only; --rule_channel ${c.ruleChannel} gives it several.`,
        ),
      ]
    : [];
}

// ---------------------------------------------------------------------------------------------
// v1.1-ladder
// ---------------------------------------------------------------------------------------------

/** The ladder condition a configuration is, or null when it is none of G0–G5n. */
export function ladderCondition(c: Configuration): GovernanceCondition | null {
  const attacked = c.attack !== "none";
  if (c.strategy === "none") {
    if (c.filler || attacked) return null;
    return c.rulePresent ? "G1" : "G0";
  }
  const base = !c.filler && !attacked ? "G2" : c.filler && !attacked ? "G3" : !c.filler ? "G4" : "G5";
  return (c.rulePresent ? base : `${base}n`) as GovernanceCondition;
}

const V11_LADDER: CohortDefinition = {
  id: "v1.1-ladder",
  rowShape: "v1.1",
  layout: "v1.1",
  // The ladder sweep ran with config strategy prompting-h and channel c1; provenance stamped the
  // config's values, not the run's (src/config/config.ts buildProvenance).
  provenance: () => ({ policyChannel: "c1", compactionStrategy: "prompting-h" }),
  violations(c) {
    const out: RuleViolation[] = [...sameCompactor("v1.1-ladder", c)];
    if (c.strategy !== "none" && c.strategy !== "prompting-h") {
      out.push(cohortViolation("v1.1-ladder", `reproduces the v1.3-(1.1) ladder, which ran prompting-h only; its ids do not encode the strategy (got ${c.strategy}).`));
    }
    if (c.attack !== "none" && c.attack !== "legacy") {
      out.push(cohortViolation("v1.1-ladder", `ids do not encode the attack construction; the ladder used the legacy payload (got ${c.attack}).`));
    }
    if (c.budget !== null) out.push(cohortViolation("v1.1-ladder", "rows carry no budget field."));
    if (c.defense !== "none") out.push(cohortViolation("v1.1-ladder", "rows carry no defense field."));
    if (c.strategy === "none" && (c.filler || c.attack !== "none")) {
      out.push(cohortViolation("v1.1-ladder", "has no uncompacted condition with filler or attack (G0/G1 carry neither)."));
    }
    return out;
  },
  identify(c, at, cfg) {
    const cond = ladderCondition(c)!;
    const compacted = c.strategy !== "none";
    const backend = compacted ? defaultBackendFor(c.strategy as StrategyId) : null;
    const armId = c.filler ? V12_HAYSTACK_ARM : null;
    const mslug = modelSlug(c.agentModel);
    const runId = [
      "governance",
      at.caseId,
      cond.toLowerCase(),
      ...(at.channel ? [at.channel] : []),
      ...(armId ? [armId.toLowerCase()] : []),
      ...(backend ? [backend] : []),
      mslug,
      `rep-${rep2(at.repetition)}`,
    ].join("-");
    const pairKey = [
      "governance",
      at.caseId,
      cond.toLowerCase(),
      `ch-${at.channel ?? "none"}`,
      `arm-${armId ?? "none"}`,
      `model-${c.agentModel}`,
      `temp-${cfg.temperature}`,
      `krt-${cfg.keepRecentTokens}`,
      `seed-${cfg.seed}`,
      `rep-${rep2(at.repetition)}`,
    ].join("|");
    const plannedV11: PlannedRun = {
      runId,
      pairKey,
      family: "governance",
      condition: cond,
      taskOrSampleId: at.caseId,
      compactorBackend: backend,
      policyChannel: at.channel,
      haystackArm: armId,
      compactionStrategy: compacted ? (c.strategy as StrategyId) : null,
      repetition: at.repetition,
      fixtureOnly: false,
      reportable: true,
      manualCompactions: compacted ? 1 : 0,
      model: c.agentModel,
      seed: cfg.seed,
    };
    return {
      runId,
      pairKey,
      sourceTranscriptId: null,
      spec: null,
      plannedV11,
      legacyCondition: cond,
      configCohort: "v1.1-ladder",
      manualCompactions: compacted ? 1 : 0,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Shared v1.2-layout spec construction
// ---------------------------------------------------------------------------------------------

function baseSpec(c: Configuration, channel: PolicyChannel | null): ConditionSpec {
  const compacted = c.strategy !== "none";
  // Key order is `spec.ts`'s `baseSpec` + `enumerateCells` order.
  const spec: ConditionSpec = {
    policyPresent: c.rulePresent,
    fillerPresent: c.filler,
    attackPresent: c.attack !== "none",
    haystackArm: c.filler ? V12_HAYSTACK_ARM : null,
    attackInsertion: "after-benign-block-1",
    policyChannel: c.rulePresent ? channel : null,
    protocolVersion: "v1.2",
    legacyLabel: null,
    contextHandling: compacted ? "compacted" : "full",
    compactionStrategy: compacted ? (c.strategy as StrategyId) : null,
    compactionBackend: compacted ? defaultBackendFor(c.strategy as StrategyId) : null,
  };
  return spec;
}

function v12Transcript(prefix: string, at: EpisodeCoordinates, spec: ConditionSpec): string[] {
  return [
    prefix,
    at.caseId,
    `rep-${rep2(at.repetition)}`,
    spec.policyPresent ? `pol-${spec.policyChannel}` : "nopol",
    spec.fillerPresent ? `fill-${spec.haystackArm}` : "nofill",
    spec.attackPresent ? "atk" : "noatk",
  ];
}

// ---------------------------------------------------------------------------------------------
// v1.3-newcase-v1.2strategies
// ---------------------------------------------------------------------------------------------

const V13_STRATEGIES: CohortDefinition = {
  id: "v1.3-newcase-v1.2strategies",
  rowShape: "v1.2",
  layout: "v1.2",
  provenance: () => ({ policyChannel: "c1", compactionStrategy: "pi-native-cut" }),
  violations(c) {
    const cid = "v1.3-newcase-v1.2strategies" as const;
    const out: RuleViolation[] = [...sameCompactor(cid, c), ...singleChannel(cid, c)];
    if (c.attack !== "none" && c.attack !== "legacy") {
      out.push(cohortViolation(cid, `ids do not encode the attack construction; the study used the legacy payload (got ${c.attack}).`));
    }
    if (c.budget !== null) out.push(cohortViolation(cid, "rows carry no budget field; use --cohort v1.4-token-constraint or cccb-v1."));
    if (c.defense !== "none") out.push(cohortViolation(cid, "rows carry no defense field; use --cohort v1.6-ipi-attack-defense or cccb-v1."));
    return out;
  },
  identify(c, at, cfg) {
    const base = baseSpec(c, at.channel);
    const spec: ConditionSpec = { ...base, legacyLabel: deriveLegacyLabel(base) };
    const handling = spec.contextHandling === "full" ? "full" : String(spec.compactionStrategy);
    return {
      runId: [
        "v12",
        at.caseId,
        spec.policyPresent ? "pol" : "nopol",
        spec.fillerPresent ? "fill" : "nofill",
        spec.attackPresent ? "atk" : "noatk",
        handling,
        modelSlug(c.agentModel),
        `rep-${rep2(at.repetition)}`,
      ].join("-"),
      sourceTranscriptId: v12Transcript("v1.2", at, spec).join("|"),
      pairKey: [
        ...v12Transcript("v1.2", at, spec),
        `model-${c.agentModel}`,
        `temp-${cfg.temperature}`,
        `seed-${cfg.seed}`,
      ].join("|"),
      spec,
      plannedV11: null,
      legacyCondition: null,
      configCohort: "v1.3-newcase-v1.2strategies",
      manualCompactions: spec.contextHandling === "full" ? 0 : 1,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// v1.4-token-constraint
// ---------------------------------------------------------------------------------------------

const V14_BUDGET: CohortDefinition = {
  id: "v1.4-token-constraint",
  rowShape: "v1.2",
  layout: "v1.2",
  provenance: () => ({ policyChannel: "c1", compactionStrategy: "pi-native-cut" }),
  violations(c) {
    const cid = "v1.4-token-constraint" as const;
    const out: RuleViolation[] = [...sameCompactor(cid, c), ...singleChannel(cid, c)];
    if (!c.rulePresent) out.push(cohortViolation(cid, "has no rule-absent cells; every v1.4 cell carries the rule."));
    if (!c.filler) out.push(cohortViolation(cid, "ran only under filler (--filler yes); its ids do not encode filler."));
    if (c.strategy !== "none" && !PROMPT_BASED_STRATEGIES.includes(c.strategy)) {
      out.push(cohortViolation(cid, `ran the seven prompt-based strategies only (got ${c.strategy}).`));
    }
    if (c.budget !== null && !(V14_BUDGET_LADDER as readonly number[]).includes(c.budget)) {
      out.push(cohortViolation(cid, `budgets are the v1.4 ladder ${V14_BUDGET_LADDER.join(", ")} (got ${c.budget}).`));
    }
    if (c.attack !== "none" && c.attack !== "legacy") {
      out.push(cohortViolation(cid, `ids do not encode the attack construction; v1.4 used the legacy payload (got ${c.attack}).`));
    }
    if (c.defense !== "none") out.push(cohortViolation(cid, "rows carry no defense field."));
    return out;
  },
  identify(c, at, cfg) {
    const spec: ConditionSpecV14 = {
      ...baseSpec(c, at.channel),
      outputBudgetTokens: c.budget,
      budgetEnforcement: c.budget === null ? "none" : "prompt+mechanism",
    };
    const handling = spec.contextHandling === "full" ? "full" : String(spec.compactionStrategy);
    const transcript = [
      "v1.4",
      at.caseId,
      `rep-${rep2(at.repetition)}`,
      `pol-${spec.policyChannel}`,
      `fill-${spec.haystackArm}`,
      spec.attackPresent ? "atk" : "noatk",
    ];
    return {
      runId: [
        "v14",
        at.caseId,
        spec.attackPresent ? "atk" : "noatk",
        handling,
        spec.outputBudgetTokens === null ? "bnone" : `b${spec.outputBudgetTokens}`,
        modelSlug(c.agentModel),
        `rep-${rep2(at.repetition)}`,
      ].join("-"),
      sourceTranscriptId: transcript.join("|"),
      pairKey: [...transcript, `model-${c.agentModel}`, `temp-${cfg.temperature}`, `seed-${cfg.seed}`].join("|"),
      spec,
      plannedV11: null,
      legacyCondition: null,
      configCohort: "v1.4-token-constraint",
      manualCompactions: spec.contextHandling === "full" ? 0 : 1,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// v1.6-ipi-attack-defense
// ---------------------------------------------------------------------------------------------

const V16_ATTACK_DEFENSE: CohortDefinition = {
  id: "v1.6-ipi-attack-defense",
  rowShape: "v1.2",
  layout: "v1.2",
  provenance: () => ({ policyChannel: "c1", compactionStrategy: "pi-native-cut" }),
  violations(c) {
    const cid = "v1.6-ipi-attack-defense" as const;
    const out: RuleViolation[] = [...sameCompactor(cid, c), ...singleChannel(cid, c)];
    if (c.strategy !== "none" && c.strategy !== "prompting-h") {
      out.push(cohortViolation(cid, `ran prompting-h only; its ids do not encode the strategy (got ${c.strategy}).`));
    }
    if (!c.rulePresent) out.push(cohortViolation(cid, "has no rule-absent cells."));
    if (c.filler) out.push(cohortViolation(cid, "ran without filler; its ids do not encode filler."));
    if (c.budget !== null) out.push(cohortViolation(cid, "rows carry no budget field."));
    return out;
  },
  identify(c, at, cfg) {
    const attackTechnique = c.attack === "none" ? null : c.attack;
    const spec: ConditionSpecV16 = { ...baseSpec(c, at.channel), attackTechnique, defense: c.defense };
    const full = spec.contextHandling === "full";
    const transcript = [
      "v1.6",
      at.caseId,
      `rep-${rep2(at.repetition)}`,
      `pol-${spec.policyChannel}`,
      "nofill",
      `atk-${attackTechnique ?? "none"}`,
    ];
    return {
      runId:
        [
          "v16",
          at.caseId,
          `atk-${attackTechnique ?? "none"}`,
          `def-${spec.defense}`,
          modelSlug(c.agentModel),
          `rep-${rep2(at.repetition)}`,
        ].join("-") + (full ? "-full" : ""),
      sourceTranscriptId: transcript.join("|"),
      pairKey: [
        "v1.6",
        at.caseId,
        `rep-${rep2(at.repetition)}`,
        `pol-${spec.policyChannel}`,
        "nofill",
        `model-${c.agentModel}`,
        `temp-${cfg.temperature}`,
        `seed-${cfg.seed}`,
      ].join("|"),
      spec,
      plannedV11: null,
      legacyCondition: null,
      configCohort: "v1.6-ipi-attack-defense",
      manualCompactions: full ? 0 : 1,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// cccb-v1 — new; encodes every factor
// ---------------------------------------------------------------------------------------------

const CARCBENCH_V1: CohortDefinition = {
  id: "cccb-v1",
  rowShape: "v1.2",
  layout: "v1.2",
  // New rows record what actually ran.
  provenance: (c, channel) => ({
    policyChannel: channel ?? "none",
    compactionStrategy: c.strategy,
  }),
  violations: () => [],
  identify(c, at, cfg) {
    const attackTechnique = c.attack === "none" ? null : c.attack;
    const callsModel = c.strategy !== "none" && !["fifo", "lru-mechanism"].includes(c.strategy);
    const spec: ConditionSpecCccb = {
      ...baseSpec(c, at.channel),
      outputBudgetTokens: c.budget,
      budgetEnforcement: c.budget === null ? "none" : "prompt+mechanism",
      attackTechnique,
      defense: c.defense,
      compactorModel: callsModel ? c.compactorModel : null,
    };
    const handling = spec.contextHandling === "full" ? "full" : String(spec.compactionStrategy);
    const transcript = [
      "cccb",
      at.caseId,
      `rep-${rep2(at.repetition)}`,
      spec.policyPresent ? `pol-${spec.policyChannel}` : "nopol",
      spec.fillerPresent ? `fill-${spec.haystackArm}` : "nofill",
      `atk-${attackTechnique ?? "none"}`,
    ];
    const compactorPart =
      callsModel && c.compactorModel !== c.agentModel ? [`cm-${modelSlug(c.compactorModel)}`] : [];
    return {
      runId: [
        "cccb",
        at.caseId,
        spec.policyPresent ? `pol-${spec.policyChannel}` : "nopol",
        spec.fillerPresent ? "fill" : "nofill",
        `atk-${attackTechnique ?? "none"}`,
        `def-${c.defense}`,
        handling,
        c.budget === null ? "bnone" : `b${c.budget}`,
        modelSlug(c.agentModel),
        ...compactorPart,
        `rep-${rep2(at.repetition)}`,
      ].join("-"),
      sourceTranscriptId: transcript.join("|"),
      pairKey: [...transcript, `model-${c.agentModel}`, `temp-${cfg.temperature}`, `seed-${cfg.seed}`].join("|"),
      spec,
      plannedV11: null,
      legacyCondition: null,
      configCohort: "cccb-v1",
      manualCompactions: spec.contextHandling === "full" ? 0 : 1,
    };
  },
};

export const COHORTS: Record<CohortId, CohortDefinition> = {
  "cccb-v1": CARCBENCH_V1,
  "v1.1-ladder": V11_LADDER,
  "v1.3-newcase-v1.2strategies": V13_STRATEGIES,
  "v1.4-token-constraint": V14_BUDGET,
  "v1.6-ipi-attack-defense": V16_ATTACK_DEFENSE,
};

export function cohortFor(id: CohortId): CohortDefinition {
  return COHORTS[id];
}
