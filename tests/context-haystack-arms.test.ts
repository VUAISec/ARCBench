import { legacyArmsConfig } from "./helpers/legacy-config.ts";
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildCondition, HAYSTACK_HEADER, HAYSTACK_HEADER_CHARS } from "../src/context/transcript-v11.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import {
  assertHaystackArms,
  haystackCharsReachingSummarizer,
  loadMvpConfig,
  PI_TOOL_RESULT_MAX_CHARS,
  untruncatedChunkChars,
  type HaystackArm,
} from "../src/config/config.ts";
import type { GovernanceCondition } from "../src/harness/schema.ts";

const CFG = legacyArmsConfig();
const ROWS = loadTaskRows("data/rule-loss/cases.jsonl");
const HAYSTACK_CONDITIONS: GovernanceCondition[] = ["G3", "G3n", "G5", "G5n"];

/** The corpus bytes an arm places in the transcript, header stripped. */
function corpusBytes(taskId: string, arm: HaystackArm, condition: GovernanceCondition = "G3"): string {
  const row = ROWS.find((r) => r.id === taskId)!;
  const built = buildCondition({ row, condition, repetition: 0, cfg: CFG, arm });
  return built.messages
    .filter((m) => m.role === "tool" && m.entryId.includes("-haystack"))
    .map((m) => m.content.slice(HAYSTACK_HEADER_CHARS))
    .join("");
}

describe("§3.2: the arms are chunkings of ONE corpus", () => {
  it("concatenating any arm's chunks reproduces the corpus exactly, hash included", () => {
    // Without this, `A2 - A1` is not a delivery contrast: it could be a corpus contrast wearing
    // a delivery label.
    for (const row of ROWS) {
      const expected = buildCondition({ row, condition: "G3", repetition: 0, cfg: CFG }).needle!;
      for (const arm of CFG.haystackArms) {
        const joined = corpusBytes(row.id, arm);
        expect(joined.length, `${row.id} ${arm.id} length`).toBe(expected.corpusChars);
        expect(
          createHash("sha256").update(joined, "utf8").digest("hex"),
          `${row.id} ${arm.id} sha256`,
        ).toBe(expected.corpusSha256);
      }
    }
  });

  it("the corpus is identical across the four haystack conditions and every channel", () => {
    for (const row of ROWS) {
      const hashes = new Set<string>();
      for (const condition of HAYSTACK_CONDITIONS) {
        for (const channel of (["c1", "c2", "c3", "c4"] as const)) {
          // A no-policy twin takes no channel; building it once is enough.
          if (condition.endsWith("n") && channel !== (["c1", "c2", "c3", "c4"] as const)[0]) continue;
          const built = buildCondition({
            row,
            condition,
            repetition: 0,
            cfg: CFG,
            ...(condition.endsWith("n") ? {} : { channel }),
          });
          hashes.add(built.needle!.corpusSha256);
        }
      }
      expect(hashes.size, `${row.id} corpus varies across conditions/channels`).toBe(1);
    }
  });

  it("repetitions differ, so the three reps are not three copies of one draw", () => {
    const hashes = [0, 1, 2].map(
      (repetition) =>
        buildCondition({ row: ROWS[0]!, condition: "G3", repetition, cfg: CFG }).needle!.corpusSha256,
    );
    expect(new Set(hashes).size).toBe(3);
  });
});

describe("§4: derived coverage matches what the arms actually deliver", () => {
  it("haystackCharsReachingSummarizer agrees with the per-entry cap, arm by arm", () => {
    // This figure is stamped into every result row. If it drifts from reality, result tables
    // misreport the dose while looking authoritative.
    for (const arm of CFG.haystackArms) {
      const row = ROWS[0]!;
      const built = buildCondition({ row, condition: "G3", repetition: 0, cfg: CFG, arm });
      const actual = built.messages
        .filter((m) => m.role === "tool" && m.entryId.includes("-haystack"))
        .reduce((sum, m) => {
          const capped = m.content.slice(0, PI_TOOL_RESULT_MAX_CHARS);
          return sum + Math.max(0, capped.length - HAYSTACK_HEADER_CHARS);
        }, 0);
      const predicted = haystackCharsReachingSummarizer(
        arm,
        built.needle!.corpusChars,
        HAYSTACK_HEADER_CHARS,
      );
      expect(predicted, `${arm.id}`).toBe(actual);
    }
  });

  it("A3 is sized so header + body lands exactly on the cap", () => {
    const a3 = CFG.haystackArms.find((a) => a.id === "A3")!;
    expect(a3.chunkChars).toBe(untruncatedChunkChars(HAYSTACK_HEADER_CHARS));
    const built = buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 0, cfg: CFG, arm: a3 });
    for (const m of built.messages.filter((x) => x.role === "tool" && x.entryId.includes("-haystack"))) {
      // Exactly at the cap is not truncated: truncateForSummary is a `length <= maxChars` check.
      expect(m.content.length).toBeLessThanOrEqual(PI_TOOL_RESULT_MAX_CHARS);
    }
    expect(HAYSTACK_HEADER.length).toBe(HAYSTACK_HEADER_CHARS);
  });

  it("the arms are strictly ordered in delivered coverage", () => {
    const corpus = buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 0, cfg: CFG }).needle!
      .corpusChars;
    const byId = (id: string) =>
      haystackCharsReachingSummarizer(
        CFG.haystackArms.find((a) => a.id === id)!,
        corpus,
        HAYSTACK_HEADER_CHARS,
      );
    expect(byId("A1")).toBeLessThan(byId("A2"));
    expect(byId("A2")).toBeLessThan(byId("A3"));
    expect(byId("A3")).toBe(corpus);
  });
});

describe("§4.1: the arm set must stay well-formed", () => {
  it("exactly one reference arm is required", () => {
    const arms = CFG.haystackArms;
    expect(() => assertHaystackArms(arms)).not.toThrow();
    expect(() => assertHaystackArms(arms.map((a) => ({ ...a, reference: true })))).toThrow(
      /exactly one reference/,
    );
    expect(() => assertHaystackArms(arms.map((a) => ({ ...a, reference: false })))).toThrow(
      /exactly one reference/,
    );
  });

  it("chunkChars must be present iff the arm is chunked", () => {
    expect(() =>
      assertHaystackArms([{ id: "A2", delivery: "chunked-tool-results", chunkChars: null, reference: true }]),
    ).toThrow(/requires chunkChars/);
    expect(() =>
      assertHaystackArms([{ id: "A1", delivery: "single-tool-result", chunkChars: 8000, reference: true }]),
    ).toThrow(/chunkChars null/);
  });

  it("duplicate arm ids are rejected", () => {
    const a = CFG.haystackArms[0]!;
    expect(() => assertHaystackArms([{ ...a, reference: true }, { ...a, reference: false }])).toThrow(
      /duplicate haystack arm id/,
    );
  });

  it("user-message delivery is uncapped, which is why it would reach 100% in one entry", () => {
    // Specified and unrun. Recorded as a test so the asymmetry stays visible: pi caps toolResult
    // content only, so a user entry is the one delivery that needs no chunking.
    const arm: HaystackArm = { id: "A1", delivery: "user-message", chunkChars: null, reference: true };
    expect(haystackCharsReachingSummarizer(arm, 96_339, HAYSTACK_HEADER_CHARS)).toBe(96_339);
  });
});

describe("§4: every arm keeps the D5 invariant on every haystack condition", () => {
  it("a valid cut point follows the document block, all arms, all conditions, all tasks", () => {
    for (const arm of CFG.haystackArms) {
      for (const condition of HAYSTACK_CONDITIONS) {
        for (const row of ROWS) {
          const built = buildCondition({ row, condition, repetition: 0, cfg: CFG, arm });
          const ids = built.messages.map((m) => m.entryId);
          const lastDoc = ids.reduce((acc, id, i) => (id.includes("-haystack") ? i : acc), -1);
          expect(lastDoc, `${row.id} ${condition} ${arm.id} has a document`).toBeGreaterThan(-1);
          const after = built.messages.slice(lastDoc + 1);
          expect(
            after.some((m) => m.role === "user" || m.role === "assistant"),
            `${row.id} ${condition} ${arm.id}: no valid cut point after the document`,
          ).toBe(true);
        }
      }
    }
  });
});
