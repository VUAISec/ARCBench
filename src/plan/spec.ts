/**
 * A condition is its factors.
 *
 * v1.1 named a condition `G0`..`G5n` and kept the factor content in lookup tables spread across the
 * condition builder, the run matrix and the analysis scripts. That worked while there were ten
 * names. It does not survive eleven strategies crossed with two filler settings and two attack
 * states: the names would grow combinatorially while the thing they encode -- which factors this
 * row varies -- stayed implicit.
 *
 * So the factors become the identity. The required four-condition comparison is then a consequence
 * of the model rather than a list somebody maintains by hand, and `enumerateCells` cannot silently
 * omit a cell the way a hand-written table can.
 */
import type {
  CompactorBackend,
  GovernanceCondition,
  HaystackArmId,
  PolicyChannel,
} from "../harness/schema.ts";
import { STRATEGY_IDS, usesPiSessionPath, type StrategyId } from "../compaction/strategy-ids.ts";

export class ConditionSpecError extends Error {}

/** Where the attack note sits relative to benign work. One position for every v1.2 condition. */
export type AttackInsertion = "after-benign-block-1";

export type ContextHandling = "full" | "compacted";

/**
 * The only delivery arm in the v1.2 strategy cross.
 *
 * A1/A2/A3 exist because pi caps each tool result at 2,000 chars, making chunk count the only
 * lever on what reaches pi's summarizer. That is a property of pi's serializer, not of compaction:
 * ACON, Hermes and TRACE impose no such cap. Crossing arms with strategies would vary a
 * pi-specific artifact across methods that do not share it.
 *
 * A3 is the arm sized so the cap does not bite -- 1,930-char bodies plus a 70-char header land on
 * exactly 2,000, and pi's `truncateForSummary` is a `length <= maxChars` check -- so every strategy
 * sees the whole document.
 */
export const V12_HAYSTACK_ARM: HaystackArmId = "A3";

export interface ConditionSpec {
  policyPresent: boolean;
  fillerPresent: boolean;
  attackPresent: boolean;
  contextHandling: ContextHandling;
  /** Null iff `contextHandling === "full"`. */
  compactionStrategy: StrategyId | null;
  /** Null iff `contextHandling === "full"`. */
  compactionBackend: CompactorBackend | null;
  /** Null iff `fillerPresent === false`. Always `A3` when present. */
  haystackArm: HaystackArmId | null;
  attackInsertion: AttackInsertion;
  /** Null iff `policyPresent === false`. */
  policyChannel: PolicyChannel | null;
  protocolVersion: "v1.2";
  /**
   * The historical G-name iff this cell is an exact structural match for one, for continuity
   * lookups only. Never a licence to pool: see `deriveLegacyLabel`.
   */
  legacyLabel: GovernanceCondition | null;
}

/**
 * Enforce the null-iff invariants.
 *
 * Each of these encodes a row that would otherwise be self-contradictory in a way no downstream
 * consumer could detect: a compacted row that cannot say what compacted it, a full-context row
 * claiming a strategy, a no-filler row carrying a delivery arm.
 */
export function assertConditionSpec(spec: ConditionSpec): void {
  const compacted = spec.contextHandling === "compacted";

  if (compacted !== (spec.compactionStrategy !== null)) {
    throw new ConditionSpecError(
      `contextHandling ${spec.contextHandling} requires compactionStrategy to be ` +
        `${compacted ? "set" : "null"}, got ${String(spec.compactionStrategy)}`,
    );
  }
  if (compacted !== (spec.compactionBackend !== null)) {
    throw new ConditionSpecError(
      `contextHandling ${spec.contextHandling} requires compactionBackend to be ` +
        `${compacted ? "set" : "null"}, got ${String(spec.compactionBackend)}`,
    );
  }
  if (spec.compactionStrategy !== null && !STRATEGY_IDS.includes(spec.compactionStrategy)) {
    throw new ConditionSpecError(`unknown compactionStrategy ${spec.compactionStrategy}`);
  }

  if (spec.fillerPresent !== (spec.haystackArm !== null)) {
    throw new ConditionSpecError(
      `fillerPresent ${spec.fillerPresent} requires haystackArm to be ` +
        `${spec.fillerPresent ? "set" : "null"}, got ${String(spec.haystackArm)}`,
    );
  }
  if (spec.haystackArm !== null && spec.haystackArm !== V12_HAYSTACK_ARM) {
    throw new ConditionSpecError(
      `v1.2 uses delivery arm ${V12_HAYSTACK_ARM} only, got ${spec.haystackArm}. A1/A2 remain ` +
        `valid v1.1 conditions but are pi-serializer artifacts and do not cross the strategy axis.`,
    );
  }

  if (spec.policyPresent !== (spec.policyChannel !== null)) {
    throw new ConditionSpecError(
      `policyPresent ${spec.policyPresent} requires policyChannel to be ` +
        `${spec.policyPresent ? "set" : "null"}, got ${String(spec.policyChannel)}`,
    );
  }

  if (spec.protocolVersion !== "v1.2") {
    throw new ConditionSpecError(`protocolVersion must be "v1.2", got ${spec.protocolVersion}`);
  }
}

/**
 * The historical G-name for a cell, or null when there is no exact structural match.
 *
 * **Returns null for every attacked cell, by construction.** v1.1 placed the attack in two
 * different positions -- G4 before all benign turns, G5 after the first benign block -- while v1.2
 * uses one position for both. No attacked v1.2 cell is therefore built the same way as any
 * historical one, and emitting a label for it would invite exactly the cross-protocol pooling that
 * must not happen.
 *
 * Unattacked cells can match, and their labels are recorded so a continuity analysis can find the
 * historical rows. Finding them is not the same as combining them: the v1.1 aggregate
 * (`src/record/row-v11.ts`) takes v1.1-shape rows only.
 */
export function deriveLegacyLabel(spec: ConditionSpec): GovernanceCondition | null {
  if (spec.attackPresent) return null;
  if (!spec.policyPresent) return null;

  if (spec.contextHandling === "full") {
    // Uncompacted, policy present, no attack. Matches G1 only when there is also no filler: v1.1
    // had no uncompacted filler-bearing condition at all, the gap the full-context control fills.
    return spec.fillerPresent ? null : "G1";
  }
  // Compacted, policy present, no attack. Only pi's own arm reproduces a historical construction;
  // every other strategy is new, so no historical label applies.
  if (spec.compactionStrategy !== "pi-native-cut") return null;
  return spec.fillerPresent ? "G3" : "G2";
}

/** A stable id for a cell, used in run ids and as a grouping key. */
export function conditionSpecId(spec: ConditionSpec): string {
  return [
    spec.policyPresent ? "pol" : "nopol",
    spec.fillerPresent ? `fill-${spec.haystackArm}` : "nofill",
    spec.attackPresent ? "atk" : "noatk",
    spec.contextHandling === "full" ? "full" : `cmp-${spec.compactionStrategy}`,
    `ch-${spec.policyChannel ?? "none"}`,
  ].join("|");
}

/**
 * Which system compacts, per arm. The pi arms run pi's real session; everything else is this
 * harness applying the strategy's own boundary and prompt.
 */
export function defaultBackendFor(id: StrategyId): CompactorBackend {
  return usesPiSessionPath(id) ? "pi-native" : "harness";
}

export interface EnumerateOptions {
  strategies: StrategyId[];
  policyPresent: boolean;
  /** Defaults to c1, the only channel in the v1.2 cross. */
  policyChannel?: PolicyChannel;
  /** Defaults to pi-native for pi arms and harness elsewhere; supplied by the registry in use. */
  backendFor?: (id: StrategyId) => CompactorBackend;
}

function baseSpec(
  opts: EnumerateOptions,
  fillerPresent: boolean,
  attackPresent: boolean,
): Omit<ConditionSpec, "contextHandling" | "compactionStrategy" | "compactionBackend"> {
  const policyChannel = opts.policyPresent ? opts.policyChannel ?? "c1" : null;
  return {
    policyPresent: opts.policyPresent,
    fillerPresent,
    attackPresent,
    haystackArm: fillerPresent ? V12_HAYSTACK_ARM : null,
    attackInsertion: "after-benign-block-1",
    policyChannel,
    protocolVersion: "v1.2",
    legacyLabel: null,
  };
}

function withLegacy(spec: ConditionSpec): ConditionSpec {
  return { ...spec, legacyLabel: deriveLegacyLabel(spec) };
}

/**
 * The four shared full-context cells: filler x attack, kept in full.
 *
 * Planned ONCE and reused by every strategy comparison rather than regenerated per strategy. That
 * sharing is the point -- these are the common reference -- and it is also why `sourceTranscriptId`
 * has to travel with the rows, so the dependence it induces survives into the uncertainty
 * calculation instead of being silently treated as independent observations.
 */
export function fullContextCells(opts: Omit<EnumerateOptions, "strategies">): ConditionSpec[] {
  const out: ConditionSpec[] = [];
  for (const fillerPresent of [false, true]) {
    for (const attackPresent of [false, true]) {
      out.push(
        withLegacy({
          ...baseSpec({ ...opts, strategies: [] }, fillerPresent, attackPresent),
          contextHandling: "full",
          compactionStrategy: null,
          compactionBackend: null,
        }),
      );
    }
  }
  return out;
}

/**
 * Every cell in the v1.2 cross: `4 x (S + 1)`.
 *
 * Four full-context cells, plus the attack x filler 2x2 for each strategy. The required 2x2 is not
 * assembled here -- it is what the loop produces, which is why a missing cell is a failing test
 * rather than a reviewer's catch.
 */
export function enumerateCells(opts: EnumerateOptions): ConditionSpec[] {
  const backendFor = opts.backendFor ?? defaultBackendFor;

  const out: ConditionSpec[] = fullContextCells(opts);
  for (const fillerPresent of [false, true]) {
    for (const attackPresent of [false, true]) {
      for (const strategy of opts.strategies) {
        out.push(
          withLegacy({
            ...baseSpec(opts, fillerPresent, attackPresent),
            contextHandling: "compacted",
            compactionStrategy: strategy,
            compactionBackend: backendFor(strategy),
          }),
        );
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Extended specs, one per row shape that carries more than the v1.2 factors. Key order matters:
// a reproduced row must read field-for-field like the original, so extensions append.
// ---------------------------------------------------------------------------------------------

/** v1.4 rows: the budget this cell ran under. */
export interface ConditionSpecV14 extends ConditionSpec {
  /** The rung, or null for the unconstrained reference. */
  outputBudgetTokens: number | null;
  /** `"none"` iff `outputBudgetTokens === null`. */
  budgetEnforcement: "none" | "prompt+mechanism";
}

/** v1.6 rows: the attack construction and the defense level. */
export interface ConditionSpecV16 extends ConditionSpec {
  /** Null iff `attackPresent === false`. */
  attackTechnique: string | null;
  defense: string;
}

/** cccb-v1 rows: every factor a command can set. */
export interface ConditionSpecCccb extends ConditionSpec {
  outputBudgetTokens: number | null;
  budgetEnforcement: "none" | "prompt+mechanism";
  attackTechnique: string | null;
  defense: string;
  /** The compactor model, or null when the strategy calls none. */
  compactorModel: string | null;
}
