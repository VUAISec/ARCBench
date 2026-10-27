import { legacyArmsConfig } from "./helpers/legacy-config.ts";
import { describe, it, expect } from "vitest";
import { findCutPoint, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildCondition } from "../src/context/transcript-v11.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import { loadMvpConfig } from "../src/config/config.ts";
import { toPiMessageForTest } from "../src/compaction/pi-native.ts";
import type { CanonicalMessage, GovernanceCondition } from "../src/harness/schema.ts";
import type { HaystackArm } from "../src/config/config.ts";

/**
 * Verification against pi's real cut-point algorithm.
 *
 * These tests exercise `findCutPoint` — the function the old adapter bypassed — on sessions
 * seeded exactly as the adapter seeds them. No model call is involved: the cut point is decided
 * before any summarization happens, so it can be checked for free.
 */
const CFG = legacyArmsConfig();
const ROWS = loadTaskRows("data/rule-loss/cases.jsonl");
const EMAIL = ROWS.find((r) => r.id === "email")!;

function seedSession(
  condition: GovernanceCondition,
  overrides: Partial<typeof CFG> = {},
  arm?: HaystackArm,
) {
  const built = buildCondition({
    row: EMAIL,
    condition,
    repetition: 0,
    cfg: { ...CFG, ...overrides },
    ...(arm ? { arm } : {}),
  });
  const manager = SessionManager.inMemory(process.cwd());
  const canonicalByEntry = new Map<string, string>();
  built.messages.forEach((m, i) => {
    const id = manager.appendMessage(toPiMessageForTest(m, CFG.agentModel, i));
    canonicalByEntry.set(id, m.entryId);
  });
  const entries = manager.getBranch();
  return { built, manager, entries, canonicalByEntry };
}

/** Seed a session from an explicit message list, for layouts buildCondition will not produce. */
function seedMessages(messages: CanonicalMessage[]) {
  const manager = SessionManager.inMemory(process.cwd());
  messages.forEach((m, i) => manager.appendMessage(toPiMessageForTest(m, CFG.agentModel, i)));
  return manager.getBranch();
}

describe("P30: the cut point comes from pi's token budget", () => {
  it("the harness's messages are accepted by a real pi session", () => {
    const { built, entries } = seedSession("G2");
    expect(entries.length).toBe(built.messages.length);
  });

  it("assistant tool calls survive the round trip into pi's session entries", () => {
    const { entries } = seedSession("G2");
    const serialized = JSON.stringify(entries);
    expect(serialized).toContain('"type":"toolCall"');
    expect(serialized).toContain("tc-email-1");
  });

  it("the legacy fixed cut retains the same trailing count regardless of content — the P30 defect", () => {
    const g2 = seedSession("G2");
    const g3 = seedSession("G3");
    // `keepLast = min(3, n-1)` ignores the haystack entirely, so the volume manipulation could
    // not move the cut and G2/G3 compacted an identical message count by construction.
    const legacyRetained = (n: number) => Math.min(3, n - 1);
    expect(legacyRetained(g3.entries.length)).toBe(legacyRetained(g2.entries.length));
  });

  it("pi's real cut responds to the token budget, unlike the fixed cut", () => {
    const { entries } = seedSession("G2");
    const cuts = [200, 400, 800, 20000].map(
      (keep) => findCutPoint(entries, 0, entries.length, keep).firstKeptEntryIndex,
    );
    // A budget-driven cut moves as the budget changes; a fixed cut would give one value.
    expect(new Set(cuts).size).toBeGreaterThan(1);
    // Monotone: a larger retained budget never summarizes more.
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]!).toBeLessThanOrEqual(cuts[i - 1]!);
  });

  it("D-4: an atomic tool result is fatal only when it is LAST, not when it is single", () => {
    // The superseded belief was that a single 24k-token tool result can never be compacted,
    // because findCutPoint never selects a toolResult as a boundary. That is only true when the
    // result is the final entry: then no `cutPoint >= i` exists, cutIndex falls back to
    // cutPoints[0], messagesToSummarize is empty and compact() throws "Nothing to compact".
    //
    // With any valid entry after it the cut rounds forward and the whole block lands in the
    // prefix. v1.1 relies on this: it inserts the document mid-arc, which is what makes the
    // single-document arm A1 runnable at all.
    const a1 = CFG.haystackArms.find((a) => a.id === "A1")!;

    // Mid-arc (what buildCondition now produces): viable at every budget.
    const midArc = seedSession("G3", {}, a1);
    for (const keep of [50, 100, 800, 20000]) {
      const cut = findCutPoint(midArc.entries, 0, midArc.entries.length, keep);
      expect(cut.firstKeptEntryIndex, `mid-arc @${keep}`).toBeGreaterThan(0);
    }

    // Same entries, document moved to the end: degenerate at every budget.
    const doc = midArc.built.messages.filter((m) => m.entryId.includes("-haystack"));
    const rest = midArc.built.messages.filter((m) => !m.entryId.includes("-haystack"));
    const trailing = seedMessages([...rest, ...doc]);
    for (const keep of [50, 100, 800, 20000]) {
      expect(
        findCutPoint(trailing, 0, trailing.length, keep).firstKeptEntryIndex,
        `document-last @${keep}`,
      ).toBe(0);
    }
  });

  it("every delivery arm is viable at the tuned budget, on the real cut point", () => {
    for (const arm of CFG.haystackArms) {
      for (const condition of ["G3", "G5"] as GovernanceCondition[]) {
        const { entries } = seedSession(condition, {}, arm);
        const cut = findCutPoint(entries, 0, entries.length, CFG.keepRecentTokens);
        expect(cut.firstKeptEntryIndex, `${condition} arm ${arm.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("with chunked delivery every compacted condition actually compacts", () => {
    for (const condition of ["G2", "G3", "G4"] as GovernanceCondition[]) {
      const { entries } = seedSession(condition);
      const cut = findCutPoint(entries, 0, entries.length, CFG.keepRecentTokens);
      expect(cut.firstKeptEntryIndex).toBeGreaterThan(0);
    }
  });

  it("with chunked delivery the policy lands in the summarized prefix, for all nine tasks", () => {
    for (const row of ROWS) {
      for (const condition of ["G2", "G3", "G4"] as GovernanceCondition[]) {
        const built = buildCondition({ row, condition, repetition: 0, cfg: CFG });
        const manager = SessionManager.inMemory(process.cwd());
        built.messages.forEach((m, i) => manager.appendMessage(toPiMessageForTest(m, CFG.agentModel, i)));
        const entries = manager.getBranch();
        const cut = findCutPoint(entries, 0, entries.length, CFG.keepRecentTokens);
        const policyIndex = built.messages.findIndex((m) => m.entryId === built.policyEntryId);
        expect({ task: row.id, condition, policyIndex, cut: cut.firstKeptEntryIndex }).toMatchObject({
          policyIndex: 0,
        });
        expect(cut.firstKeptEntryIndex).toBeGreaterThan(policyIndex);
      }
    }
  });

  it("the cut never lands on a tool result, so a tool call is never split from its result", () => {
    for (const condition of ["G2", "G3", "G4"] as GovernanceCondition[]) {
      const { entries } = seedSession(condition);
      const cut = findCutPoint(entries, 0, entries.length, CFG.keepRecentTokens);
      const firstKept = entries[cut.firstKeptEntryIndex];
      const serialized = JSON.stringify(firstKept);
      expect(serialized).not.toContain('"role":"toolResult"');
    }
  });

  it("the policy's location is a real measurement, not a constant", () => {
    // With a large enough retained budget the policy stays in the tail; with a small one it
    // falls into the summarized prefix. The old bookkeeping reported "compacted" either way.
    const { built, entries, canonicalByEntry } = seedSession("G2");
    const policyEntryIndex = entries.findIndex(
      (e) => canonicalByEntry.get(e.id) === built.policyEntryId,
    );
    expect(policyEntryIndex).toBe(0);

    const generousCut = findCutPoint(entries, 0, entries.length, 10_000_000);
    const tightCut = findCutPoint(entries, 0, entries.length, 1);
    expect(generousCut.firstKeptEntryIndex).toBeLessThanOrEqual(policyEntryIndex);
    expect(tightCut.firstKeptEntryIndex).toBeGreaterThan(policyEntryIndex);
  });
});
