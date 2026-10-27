/**
 * pi's binding summarizer cap, and the mapping between its native and canonical coordinates.
 *
 * Both are forward-only. Neither reruns anything, and neither rewrites a historical row.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUMMARIZER_MAX_TOKENS,
  effectiveSummarizerLimits,
} from "../src/compaction/pi-native.ts";
import { loadMvpConfig } from "../src/config/config.ts";

describe("A02: the binding summarizer cap", () => {
  it("shows why raising reserveTokens alone changed nothing", () => {
    // The exact arithmetic. With the model cap at 8,192, doubling the reserve from 16,384
    // to 32,768 leaves both effective limits identical -- so the proposed remedy for DeepSeek's
    // 27 losses could not have worked, and this is the check that says so.
    const at16k = effectiveSummarizerLimits(8192, 16384);
    const at32k = effectiveSummarizerLimits(8192, 32768);
    expect(at16k.effectiveHistoryMaxTokens).toBe(8192);
    expect(at16k.effectiveTurnPrefixMaxTokens).toBe(8192);
    expect(at32k.effectiveHistoryMaxTokens).toBe(8192);
    expect(at32k.effectiveTurnPrefixMaxTokens).toBe(8192);
  });

  it("lets the reserve bind once the model cap is raised", () => {
    const raised = effectiveSummarizerLimits(32768, 16384);
    expect(raised.effectiveHistoryMaxTokens).toBe(13107); // floor(0.8 * 16384)
    expect(raised.effectiveTurnPrefixMaxTokens).toBe(8192); // floor(0.5 * 16384)
  });

  it("defaults to the value v1.1 actually ran, so history stays reproducible", () => {
    expect(DEFAULT_SUMMARIZER_MAX_TOKENS).toBe(8192);
  });

  it("reports both limits separately, because they differ once the cap is not binding", () => {
    // pi summarizes a split turn with a SECOND call under a different limit. Collapsing them into
    // one number would hide which branch a truncation came from.
    const l = effectiveSummarizerLimits(65536, 20000);
    expect(l.effectiveHistoryMaxTokens).not.toBe(l.effectiveTurnPrefixMaxTokens);
  });
});

import { mapNativeCut } from "../src/compaction/pi-native.ts";
import type { CanonicalMessage } from "../src/harness/schema.ts";

describe("A01: native and canonical coordinate systems", () => {
  /**
   * A branch shaped the way `createAgentSession` really produces one: model-change and
   * thinking-level entries first, then the seeded messages. Those leading entries are the entire
   * cause of the defect -- with them, native index i is not canonical index i.
   */
  function realisticBranch() {
    const messages: CanonicalMessage[] = [
      { entryId: "g-email-policy", role: "user", content: "Never email externally." },
      { entryId: "g-email-benign-00", role: "user", content: "Draft the note." },
      { entryId: "g-email-benign-01", role: "assistant", content: "Drafting." },
      { entryId: "g-email-benign-02", role: "user", content: "Finalise it." },
    ];
    const branch = [
      { id: "native-meta-model-change" },
      { id: "native-meta-thinking-level" },
      { id: "native-0" },
      { id: "native-1" },
      { id: "native-2" },
      { id: "native-3" },
    ];
    const canonicalByEntryId = new Map(
      messages.map((m, i) => [`native-${i}`, m.entryId] as const),
    );
    return { messages, branch, canonicalByEntryId };
  }

  it("reproduces the v1.1 defect when the native index is used directly", () => {
    // The whole finding in one assertion: at native index 3 the naive read gives benign-02, but
    // the true entry is benign-00. Two seeded metadata entries, two positions of drift.
    const { messages } = realisticBranch();
    const naive = messages[3]?.entryId;
    const correct = mapNativeCut({ ...realisticBranch(), nativeFirstKeptIndex: 3 })
      .canonicalFirstKeptEntryId;
    expect(naive).toBe("g-email-benign-02");
    expect(correct).toBe("g-email-benign-00");
    expect(correct).not.toBe(naive);
  });

  it("records both coordinate systems so neither has to be inferred", () => {
    const mapped = mapNativeCut({ ...realisticBranch(), nativeFirstKeptIndex: 4 });
    expect(mapped.nativeFirstKeptEntryId).toBe("native-2");
    expect(mapped.nativeFirstKeptIndex).toBe(4);
    expect(mapped.canonicalFirstKeptEntryId).toBe("g-email-benign-01");
    expect(mapped.canonicalFirstKeptIndex).toBe(2);
  });

  it("counts non-message entries instead of letting them vanish", () => {
    // "This entry is not a message" and "the mapping failed" must not look the same.
    const mapped = mapNativeCut({ ...realisticBranch(), nativeFirstKeptIndex: 3 });
    expect(mapped.nonMessageEntriesSkipped).toBe(2);
  });

  it("partitions every canonical message into exactly one side of the cut", () => {
    const { messages } = realisticBranch();
    const mapped = mapNativeCut({ ...realisticBranch(), nativeFirstKeptIndex: 4 });
    expect([...mapped.compactedEntryIds, ...mapped.retainedEntryIds].sort()).toEqual(
      messages.map((m) => m.entryId).sort(),
    );
    expect(mapped.compactedEntryIds).toEqual(["g-email-policy", "g-email-benign-00"]);
    expect(mapped.retainedEntryIds).toEqual(["g-email-benign-01", "g-email-benign-02"]);
  });

  it("is a no-op when the branch carries no metadata entries", () => {
    const messages: CanonicalMessage[] = [
      { entryId: "a", role: "user", content: "x" },
      { entryId: "b", role: "assistant", content: "y" },
    ];
    const mapped = mapNativeCut({
      branch: [{ id: "n0" }, { id: "n1" }],
      canonicalByEntryId: new Map([
        ["n0", "a"],
        ["n1", "b"],
      ]),
      messages,
      nativeFirstKeptIndex: 1,
    });
    expect(mapped.canonicalFirstKeptIndex).toBe(1);
    expect(mapped.nonMessageEntriesSkipped).toBe(0);
  });
});

describe("A02: the cohort-b raised cap", () => {
  it("makes reserveTokens the binding limit, which was the point of the change", () => {
    // The v1.1 remedy tried to raise the reserve and could not take effect, because the model
    // descriptor's 8,192 sat underneath it. At 16,384 the reserve finally decides.
    const before = effectiveSummarizerLimits(8192, 16384);
    const after = effectiveSummarizerLimits(16384, 16384);
    expect(before.effectiveHistoryMaxTokens).toBe(8192); // model cap binds
    expect(after.effectiveHistoryMaxTokens).toBe(13107); // floor(0.8 * 16384) -- reserve binds
    expect(after.effectiveHistoryMaxTokens).toBeLessThan(16384);
  });

  it("is the value config still records, whichever cohort it currently describes", () => {
    const cfg = loadMvpConfig();
    // Cohort labels now travel on each run's rows (`--cohort`), not in shared config.
    expect(cfg.compaction.summarizerMaxTokens).toBe(16384);
  });
});
