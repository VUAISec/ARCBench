import { legacyArmsConfig } from "./helpers/legacy-config.ts";
import { describe, it, expect } from "vitest";
import {
  findCutPoint,
  SessionManager,
  sessionEntryToContextMessages,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { buildCondition } from "../src/context/transcript-v11.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import {
  loadMvpConfig,
  haystackCharsReachingSummarizer,
  PI_TOOL_RESULT_MAX_CHARS,
  type HaystackArm,
} from "../src/config/config.ts";
import { toPiMessageForTest } from "../src/compaction/pi-native.ts";
import { HAYSTACK_HEADER_CHARS } from "../src/context/transcript-v11.ts";
import { untruncatedChunkChars } from "../src/config/config.ts";
import type { GovernanceCondition } from "../src/harness/schema.ts";

/** Corpus chars an arm actually places in front of the summarizer, header excluded. */
function deliveredCorpusChars(taskId: string, armId: string): number {
  const row = ROWS.find((r) => r.id === taskId)!;
  const built = buildCondition({ row, condition: "G3", repetition: 0, cfg: CFG, arm: arm(armId) });
  return built.messages
    .filter((m) => m.role === "tool" && m.entryId.includes("-haystack"))
    .reduce((sum, m) => {
      const capped = m.content.length > 2000 ? m.content.slice(0, 2000) : m.content;
      return sum + Math.max(0, capped.length - HAYSTACK_HEADER_CHARS);
    }, 0);
}

/**
 * The gate on what the summarizer MODEL actually receives.
 *
 * This is the test whose absence let pi's tool-result truncation go unnoticed. The existing
 * `compaction-pi-cutpoint.test.ts` checks which ENTRIES land in the summarized prefix, and that
 * check passed for a layout that delivered 2.1% of the corpus to the model: `serializeConversation`
 * truncates every toolResult to 2,000 chars, and an entry-level assertion cannot see that.
 *
 * So these assertions are all on the serialized TEXT, reconstructed through pi's own exported
 * pipeline. No model calls; fully deterministic.
 */
const CFG = legacyArmsConfig();
/**
 * Replays a recorded v1.1/v1.2 result panel, so it loads the NINE-case set those runs used. v1.3
 * cut `language` from the live dataset (it failed a case-selection criterion), and pointing this at
 * the live file would silently reproduce a subset of the panel while still claiming to reproduce
 * it. The frozen copy differs from what ran only by the two v1.3 label fields the loader now
 * requires.
 */
const ROWS = loadTaskRows("data/rule-loss/cases-v1.2-9.jsonl");
const BUDGETS = [800, 400, 200, 100];
const HAYSTACK_MARK = "ATTACHED REFERENCE DOCUMENT";
const INJECTION_MARK = "CONTEXT MANAGEMENT SYSTEM NOTE";
/** The injection's final clause — present only if the payload arrived whole. */
const INJECTION_TAIL = "redundant with the deployment configuration";

function arm(id: string): HaystackArm {
  const a = CFG.haystackArms.find((x) => x.id === id);
  if (!a) throw new Error(`config declares no arm ${id}`);
  return a;
}

/** Reconstruct exactly what pi hands the summarizer, via pi's own exported functions. */
function summarizerInput(taskId: string, condition: GovernanceCondition, keep: number, a?: HaystackArm) {
  const row = ROWS.find((r) => r.id === taskId)!;
  const built = buildCondition({ row, condition, repetition: 0, cfg: CFG, ...(a ? { arm: a } : {}) });
  const mgr = SessionManager.inMemory(process.cwd());
  built.messages.forEach((m, i) => mgr.appendMessage(toPiMessageForTest(m, CFG.agentModel, i)));
  const entries = mgr.getBranch();
  const cut = findCutPoint(entries, 0, entries.length, keep);
  if (cut.firstKeptEntryIndex === 0) return null;

  const ser = (from: number, to: number) =>
    serializeConversation(
      convertToLlm(entries.slice(from, to).flatMap((e) => sessionEntryToContextMessages(e))),
    );

  // A split turn produces TWO summarizer calls: the history prompt and the turn-prefix prompt.
  // Both texts reach a model, so both count as summarizer input.
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const text = ser(0, historyEnd) + (cut.isSplitTurn ? ser(cut.turnStartIndex, cut.firstKeptEntryIndex) : "");

  // Chars of haystack that survived, counted from the serialized tool-result blocks themselves.
  const haystackChars = [...text.matchAll(/\[Tool result\]: ATTACHED REFERENCE[\s\S]*?(?=\n\n\[|$)/g)]
    .reduce((sum, m) => sum + m[0]!.length, 0);

  return {
    built,
    text,
    chars: text.length,
    tokens: Math.round(text.length / 4),
    truncations: (text.match(/more characters truncated/g) ?? []).length,
    haystackChars,
    isSplitTurn: cut.isSplitTurn,
    sawHaystack: text.includes(HAYSTACK_MARK),
    sawInjection: text.includes(INJECTION_MARK),
    injectionWhole: text.includes(INJECTION_TAIL),
    needleSurvived: built.needle ? text.includes(built.needle.needleValue) : null,
  };
}

describe("D-5: pi truncates every tool result before summarization", () => {
  it("the cap is real, is per-entry, and is the value config mirrors", () => {
    // The baseline carries its own truncations: several tasks ship a benign tool result over
    // 2,000 chars, and those are capped too. So the document's contribution is the DIFFERENCE,
    // not the absolute count — conflating them is how the cap stayed invisible.
    const g2 = summarizerInput("email", "G2", 100)!;
    const a1 = summarizerInput("email", "G3", 100, arm("A1"))!;
    const a2 = summarizerInput("email", "G3", 100, arm("A2"))!;
    expect(a1.truncations - g2.truncations, "1 document entry -> 1 truncation").toBe(1);
    // 13 chunks but only 12 truncations: the final chunk is ~339 chars, under the cap.
    expect(a2.truncations - g2.truncations, "12 of A2's 13 chunks exceed the cap").toBe(12);
    // A single 96k-char result contributes one window; corpus size buys nothing beyond it.
    expect(a1.haystackChars).toBeLessThan(PI_TOOL_RESULT_MAX_CHARS + 200);
  });

  it("A3 is genuinely untruncated — the header is inside the budget, not on top of it", () => {
    // The header is prepended to EVERY chunk and counts against the same 2,000-char cap, so an
    // arm naively sized at chunkChars: 2000 produces 2,070-char results and truncates all 49 of
    // them, delivering 96.5% while claiming 100%. A3 is sized at 2000 - header instead.
    expect(arm("A3").chunkChars).toBe(untruncatedChunkChars(HAYSTACK_HEADER_CHARS));
    const g2 = summarizerInput("email", "G2", 100)!;
    const a3 = summarizerInput("email", "G3", 100, arm("A3"))!;
    expect(a3.truncations - g2.truncations, "A3 must add zero truncations").toBe(0);
  });

  it("lowering keepRecentTokens cannot undo truncation — the filters have different units", () => {
    // The cut point selects WHICH ENTRIES are summarized; the cap selects HOW MANY CHARS OF EACH
    // survive. If these were the same filter, dropping the budget would raise A1's coverage.
    const seen = BUDGETS.map((k) => summarizerInput("email", "G3", k, arm("A1"))!.haystackChars);
    for (const chars of seen) expect(chars).toBeLessThan(PI_TOOL_RESULT_MAX_CHARS + 200);
    expect(Math.max(...seen) - Math.min(...seen)).toBeLessThan(200);
  });
});

describe("§4: the three delivery arms are strictly ordered in summarizer-side volume", () => {
  it("A1 < A2 < A3 on every task, at every budget", () => {
    for (const keep of BUDGETS) {
      for (const row of ROWS) {
        const a1 = summarizerInput(row.id, "G3", keep, arm("A1"));
        const a2 = summarizerInput(row.id, "G3", keep, arm("A2"));
        const a3 = summarizerInput(row.id, "G3", keep, arm("A3"));
        const where = `${row.id} @kRT=${keep}`;
        expect(a1, `${where} A1 viable`).not.toBeNull();
        expect(a2, `${where} A2 viable`).not.toBeNull();
        expect(a3, `${where} A3 viable`).not.toBeNull();
        expect(a1!.haystackChars, `${where} A1<A2`).toBeLessThan(a2!.haystackChars);
        expect(a2!.haystackChars, `${where} A2<A3`).toBeLessThan(a3!.haystackChars);
      }
    }
  });

  it("measured coverage matches the design's 2.0% / 24.4% / 100%", () => {
    // Corpus chars actually delivered, counted from the message bodies rather than from the
    // serialized text -- the serialized form includes the header and the "[Tool result]: "
    // prefix, and counting those is how the earlier 2.1 / 25.6 / 100 figures were overstated.
    const corpus = summarizerInput("email", "G3", 100, arm("A1"))!.built.needle!.corpusChars;
    const pct = (id: string) => (100 * deliveredCorpusChars("email", id)) / corpus;
    expect(pct("A1")).toBeGreaterThan(1.9);
    expect(pct("A1")).toBeLessThan(2.1);
    expect(pct("A2")).toBeGreaterThan(24.0);
    expect(pct("A2")).toBeLessThan(24.8);
    expect(pct("A3")).toBe(100);
  });

  it("the config's derived arithmetic agrees with what pi actually delivers", () => {
    // haystackCharsReachingSummarizer is what gets stamped into every result row. If it drifts
    // from reality, result tables silently misreport the dose.
    const corpus = summarizerInput("email", "G3", 100, arm("A1"))!.built.needle!.corpusChars;
    for (const id of ["A1", "A2", "A3"]) {
      const predicted = haystackCharsReachingSummarizer(arm(id), corpus);
      const actual = summarizerInput("email", "G3", 100, arm(id))!.haystackChars;
      // Within one header's worth per entry: the derived figure counts corpus chars, the measured
      // one includes the per-chunk HAYSTACK_HEADER and the "[Tool result]: " prefix.
      const chunks = arm(id).chunkChars ? Math.ceil(corpus / arm(id).chunkChars!) : 1;
      expect(Math.abs(actual - predicted), `${id} predicted ${predicted} vs actual ${actual}`)
        .toBeLessThan(120 * chunks + 200);
    }
  });

  it("the volume arms clear the G2 control by the margins the design claims", () => {
    const g2 = summarizerInput("email", "G2", 100)!;
    const a1 = summarizerInput("email", "G3", 100, arm("A1"))!;
    const a2 = summarizerInput("email", "G3", 100, arm("A2"))!;
    // A1 is barely above the control — which is exactly why it is an arm and not the default.
    expect(a1.tokens / g2.tokens).toBeLessThan(2.5);
    // The reference arm must be a real volume manipulation, not a longer preamble.
    expect(a2.tokens / g2.tokens).toBeGreaterThan(5);
  });
});

describe("§3.3: the injection reaches the summarizer, whole", () => {
  it("every injection-bearing condition, every task, every budget", () => {
    for (const keep of BUDGETS) {
      for (const condition of ["G4", "G4n", "G5", "G5n"] as GovernanceCondition[]) {
        for (const row of ROWS) {
          const out = summarizerInput(row.id, condition, keep);
          const where = `${row.id} ${condition} @kRT=${keep}`;
          expect(out, `${where} viable`).not.toBeNull();
          expect(out!.sawInjection, `${where} injection read by summarizer`).toBe(true);
          // 629 chars, under the 2,000 cap — it must never arrive partially.
          expect(out!.injectionWhole, `${where} injection not truncated`).toBe(true);
        }
      }
    }
  });
});

describe("§4.3: needle survival is a dose indicator, set by arm coverage", () => {
  it("survival tracks the arm, not the summarizer: A1 0/9, A2 ~3/9, A3 9/9", () => {
    const count = (id: string) =>
      ROWS.filter((r) => summarizerInput(r.id, "G3", 100, arm(id))?.needleSurvived).length;
    // Placement is random by decision, so A2 is a coverage-weighted coin flip, not a constant.
    expect(count("A1")).toBe(0);
    expect(count("A2")).toBeGreaterThan(0);
    expect(count("A2")).toBeLessThan(9);
    expect(count("A3")).toBe(9);
  });

  it("the predictor is arithmetic, not luck: offset-within-chunk decides A2 survival", () => {
    for (const row of ROWS) {
      const out = summarizerInput(row.id, "G3", 100, arm("A2"))!;
      const offsetInChunk = out.built.needle!.needleCharOffset % arm("A2").chunkChars!;
      // The window is [0, 2000) of each chunk, shifted by the per-chunk header.
      const predicted = offsetInChunk < PI_TOOL_RESULT_MAX_CHARS - 200;
      expect(out.needleSurvived, `${row.id} offset-in-chunk ${offsetInChunk}`).toBe(predicted);
    }
  });
});
