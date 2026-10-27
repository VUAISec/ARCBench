/**
 * Expand one configuration into its episodes: every case × the channel(s) its mode assigns × k
 * repetitions, each named by the configuration's cohort.
 */
import type { BenchmarkConfig } from "../config/config.ts";
import type { TaskRow } from "../rule-loss/dataset.ts";
import { channelsForMode, scenarioOf, type Scenario } from "../channels/modes.ts";
import type { PolicyChannel } from "../harness/schema.ts";
import {
  cohortFor,
  type EpisodeCoordinates,
  type EpisodeIdentity,
  type Layout,
  type RowShape,
} from "./cohorts.ts";
import { factorRuleViolations, type Configuration, type RuleViolation } from "./configuration.ts";

export interface Episode extends EpisodeIdentity, EpisodeCoordinates {
  configuration: Configuration;
  scenario: Scenario;
  rowShape: RowShape;
  layout: Layout;
}

/** Every rule a configuration breaks: the factor rules plus its cohort's. */
export function validateConfiguration(c: Configuration): RuleViolation[] {
  return [...factorRuleViolations(c), ...cohortFor(c.cohort).violations(c)];
}

export class InvalidConfigurationError extends Error {
  constructor(readonly violations: RuleViolation[]) {
    super(formatViolations(violations));
  }
}

export function formatViolations(violations: RuleViolation[]): string {
  const n = violations.length;
  const lines = [`arcbench: ${n} rule${n === 1 ? "" : "s"} broken; nothing was run`];
  for (const v of violations) {
    lines.push(`  [${v.id}] ${v.reason}`);
    lines.push(`    fix: ${v.fix}`);
  }
  return lines.join("\n");
}

export function planEpisodes(
  c: Configuration,
  rows: readonly TaskRow[],
  cfg: BenchmarkConfig,
): Episode[] {
  const violations = validateConfiguration(c);
  if (violations.length > 0) throw new InvalidConfigurationError(violations);
  const cohort = cohortFor(c.cohort);

  const episodes: Episode[] = [];
  for (const row of rows) {
    const channels: (PolicyChannel | null)[] =
      c.rulePresent && c.ruleChannel ? channelsForMode(c.ruleChannel, row) : [null];
    for (const channel of channels) {
      for (let repetition = 0; repetition < c.repetitions; repetition++) {
        const at: EpisodeCoordinates = { caseId: row.id, channel, repetition };
        episodes.push({
          ...at,
          ...cohort.identify(c, at, cfg),
          configuration: c,
          scenario: scenarioOf(row),
          rowShape: cohort.rowShape,
          layout: cohort.layout,
        });
      }
    }
  }

  const ids = new Set<string>();
  for (const e of episodes) {
    if (ids.has(e.runId)) throw new Error(`duplicate runId ${e.runId}: the cohort's id scheme cannot tell two episodes apart`);
    ids.add(e.runId);
  }
  return episodes;
}
