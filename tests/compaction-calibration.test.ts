/**
 * The calibrated boundary, pinned as a regression test.
 *
 * This is the property that makes a pi-vs-Group-B comparison a comparison of METHOD. If the two
 * paths cut at different places, an outcome difference is explainable by how much context survived
 * -- a longer retained context can win on information rather than on a better summary. So the
 * agreement is asserted, not assumed, and asserted PER OBSERVATION: a mean can match while every
 * individual case differs.
 */
import { describe, expect, it } from "vitest";
import { findCutPoint, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadMvpConfig } from "../src/config/config.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import { toPiMessageForTest } from "../src/compaction/pi-native.ts";
import { buildConditionV12 } from "../src/context/transcript-v12.ts";
import { estimateTokens, findHarnessCut } from "../src/compaction/boundary.ts";
import type { ConditionSpec } from "../src/plan/spec.ts";

const cfg = loadMvpConfig();
/**
 * Replays a recorded v1.1/v1.2 result panel, so it loads the NINE-case set those runs used. v1.3
 * cut `language` from the live dataset (it failed a case-selection criterion), and pointing this at
 * the live file would silently reproduce a subset of the panel while still claiming to reproduce
 * it. The frozen copy differs from what ran only by the two v1.3 label fields the loader now
 * requires.
 */
const rows = loadTaskRows("data/rule-loss/cases-v1.2-9.jsonl");
const CALIBRATED = (cfg as unknown as { compaction: { harnessBoundary: { retainedTailTokens: number } } })
  .compaction.harnessBoundary.retainedTailTokens;

function spec(fillerPresent: boolean, attackPresent: boolean): ConditionSpec {
  return {
    policyPresent: true,
    fillerPresent,
    attackPresent,
    contextHandling: "compacted",
    compactionStrategy: "pi-native-cut",
    compactionBackend: "pi-native",
    haystackArm: fillerPresent ? "A3" : null,
    attackInsertion: "after-benign-block-1",
    policyChannel: "c1",
    protocolVersion: "v1.2",
    legacyLabel: null,
  };
}

function agreement(retainedTailTokens: number, over: typeof rows = rows) {
  let identical = 0;
  let total = 0;
  let maxTailDiff = 0;
  for (const row of over) {
    for (const filler of [false, true]) {
      for (const attack of [false, true]) {
        const built = buildConditionV12({ row, spec: spec(filler, attack), repetition: 0, cfg });
        const mgr = SessionManager.inMemory(process.cwd());
        built.messages.forEach((m, i) => mgr.appendMessage(toPiMessageForTest(m, cfg.agentModel, i)));
        const branch = mgr.getBranch();
        const piIdx = findCutPoint(branch, 0, branch.length, cfg.keepRecentTokens).firstKeptEntryIndex;
        const hIdx = findHarnessCut(built.messages, { retainedTailTokens }).firstKeptIndex;
        total++;
        if (piIdx === hIdx) identical++;
        maxTailDiff = Math.max(
          maxTailDiff,
          Math.abs(
            estimateTokens(built.messages.slice(piIdx)) - estimateTokens(built.messages.slice(hIdx)),
          ),
        );
      }
    }
  }
  return { identical, total, maxTailDiff };
}

describe("calibrated harness boundary", () => {
  it("is the value recorded in config", () => {
    expect(CALIBRATED).toBe(50);
  });

  it("reproduces pi's cut on every observation, not merely on average", () => {
    const { identical, total, maxTailDiff } = agreement(CALIBRATED);
    expect(total).toBe(36); // 9 tasks x filler x attack
    expect(identical).toBe(36);
    expect(maxTailDiff).toBe(0);
  });

  /**
   * The calibration was chosen on the nine-case set. v1.3 added eight cases, and a harness backend
   * arm (Hermes, ACON, TRACE) is only comparable to a pi arm if the two cut in the same place on
   * the cases it actually runs. Asserted on the LIVE dataset, so adding a case that cuts
   * differently fails here rather than silently confounding a sweep.
   */
  it("still reproduces pi's cut on every case in the live v1.3 dataset", () => {
    const live = loadTaskRows("data/rule-loss/cases.jsonl");
    const { identical, total, maxTailDiff } = agreement(CALIBRATED, live);
    expect(total).toBe(live.length * 4); // tasks x filler x attack
    expect(identical).toBe(total);
    expect(maxTailDiff).toBe(0);
  });

  it("shows the calibration was necessary rather than cosmetic", () => {
    // Naively reusing pi's own number agrees on only a third of observations, which is exactly
    // the confound the calibration removes.
    const naive = agreement(cfg.keepRecentTokens);
    expect(naive.identical).toBeLessThan(naive.total);
    expect(naive.maxTailDiff).toBeGreaterThan(0);
  });
});
