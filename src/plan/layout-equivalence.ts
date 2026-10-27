/**
 * Which v1.2-layout cells rebuild a v1.1-ladder condition message for message.
 *
 * The two layouts differ in exactly one place: an attack without filler goes right after the rule
 * in v1.1 (G4/G4n) and after the first benign block in v1.2. Every other cell is identical, which
 * `tests/context-layout-equivalence.test.ts` proves by rebuilding both for all seventeen cases.
 *
 * This is what licenses reusing a ladder row as a v1.2 cell (the paper's strategy study spliced G1/G2/G3/G5 into the
 * strategy table). The metrics module pools on the full factor tuple -- attack position included --
 * so it reaches the same answer from the data; this function states it in code.
 */
import type { GovernanceCondition } from "../harness/schema.ts";
import type { ConditionSpec } from "./spec.ts";

/** The one arm the v1.1 ladder swept on the seventeen cases. */
const V11_LADDER_STRATEGY = "prompting-h";

export function v11CoveredCondition(spec: ConditionSpec): GovernanceCondition | null {
  if (!spec.policyPresent) return null;

  if (spec.contextHandling === "full") {
    // v1.1's only uncompacted rule-bearing condition is G1, with neither filler nor attack.
    return !spec.fillerPresent && !spec.attackPresent ? "G1" : null;
  }

  if (spec.compactionStrategy !== V11_LADDER_STRATEGY) return null;

  if (!spec.fillerPresent && !spec.attackPresent) return "G2";
  if (spec.fillerPresent && !spec.attackPresent) return "G3";
  if (spec.fillerPresent && spec.attackPresent) return "G5";
  // No filler, attacked: G4's analogue, built at a different injection position.
  return null;
}
