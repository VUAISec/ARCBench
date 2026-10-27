import { legacyArmsConfig } from "./helpers/legacy-config.ts";
import { describe, it, expect } from "vitest";
import { buildCondition, hasPolicy, policyPresentInContext } from "../src/context/transcript-v11.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import { loadMvpConfig } from "../src/config/config.ts";
import { canonicalToOpenAI } from "../src/rule-loss/evaluator.ts";
import type { GovernanceCondition } from "../src/harness/schema.ts";

const CFG = legacyArmsConfig();
const ROWS = loadTaskRows("data/rule-loss/cases.jsonl");
const CONDITIONS: GovernanceCondition[] = ["G0", "G1", "G2", "G2n", "G3", "G4"];

const build = (taskId: string, condition: GovernanceCondition) =>
  buildCondition({ row: ROWS.find((r) => r.id === taskId)!, condition, repetition: 0, cfg: CFG });

describe("P41: policy delivery places the policy where compaction can reach it", () => {
  it("the persona is the system prompt and carries no graded rule", () => {
    for (const row of ROWS) {
      const built = build(row.id, "G1");
      expect(built.systemPrompt).toBe(row.system_prompt);
      expect(built.systemPrompt).not.toContain(row.policy);
    }
  });

  it("the policy is the first message, as a compactable user turn with a stable entry id", () => {
    for (const row of ROWS) {
      const built = build(row.id, "G2");
      expect(built.messages[0]!.entryId).toBe(built.policyEntryId);
      expect(built.messages[0]!.role).toBe("user");
      expect(built.messages[0]!.content).toBe(row.policy);
    }
  });

  it("G1-G4 deliver byte-identical policy text", () => {
    for (const row of ROWS) {
      const texts = (["G1", "G2", "G3", "G4"] as GovernanceCondition[]).map(
        (c) => build(row.id, c).messages[0]!.content,
      );
      expect(new Set(texts).size).toBe(1);
      expect(texts[0]).toBe(row.policy);
    }
  });
});

describe("G0 and G2n are real no-policy conditions", () => {
  for (const cond of ["G0", "G2n"] as GovernanceCondition[]) {
    it(`${cond}: has no policy entry`, () => {
      for (const row of ROWS) expect(build(row.id, cond).policyEntryId).toBeNull();
    });

    it(`${cond}: has the policy nowhere in the transcript or the system prompt`, () => {
      for (const row of ROWS) {
        const built = build(row.id, cond);
        expect(built.messages.some((m) => m.content.includes(row.policy))).toBe(false);
        expect(built.systemPrompt.includes(row.policy)).toBe(false);
        expect(policyPresentInContext(built.messages, row.policy)).toBe(false);
      }
    });
  }

  it("hasPolicy agrees with what buildCondition produced", () => {
    for (const row of ROWS) {
      for (const cond of CONDITIONS) {
        expect(build(row.id, cond).policyEntryId !== null).toBe(hasPolicy(cond));
      }
    }
  });
});

describe("G2n is the compacted control for G2", () => {
  it("G2n is byte-identical to G2 apart from the policy message", () => {
    // This is the whole point of the control: everything except the policy is held constant,
    // so G2 - G2n isolates the policy's residual effect under compaction.
    for (const row of ROWS) {
      const g2 = build(row.id, "G2");
      const g2n = build(row.id, "G2n");
      expect(g2n.systemPrompt).toBe(g2.systemPrompt);
      expect(g2n.trigger).toBe(g2.trigger);
      expect(g2n.messages).toHaveLength(g2.messages.length - 1);
      // Drop G2's policy message; the remaining content must match position for position.
      expect(g2n.messages.map((m) => m.content)).toEqual(g2.messages.slice(1).map((m) => m.content));
    }
  });

  it("G2n carries the same benign turns as G0, so G2n - G0 isolates compaction", () => {
    for (const row of ROWS) {
      const g0 = build(row.id, "G0");
      const g2n = build(row.id, "G2n");
      expect(g2n.messages.map((m) => m.content)).toEqual(g0.messages.map((m) => m.content));
    }
  });

  it("G2n carries no haystack and no injection", () => {
    for (const row of ROWS) {
      const built = build(row.id, "G2n");
      expect(built.needle).toBeNull();
      expect(built.messages.some((m) => m.content === row.attack_inject)).toBe(false);
    }
  });
});

describe("the trigger is identical across every condition", () => {
  it("all five conditions end with the same prohibited request", () => {
    for (const row of ROWS) {
      const triggers = CONDITIONS.map((c) => build(row.id, c).trigger);
      expect(new Set(triggers)).toEqual(new Set([row.trigger]));
    }
  });
});

describe("P4: the transcript satisfies the tool-call protocol", () => {
  for (const condition of CONDITIONS) {
    it(`${condition}: every tool result references a declared call, for all nine tasks`, () => {
      for (const row of ROWS) {
        const built = build(row.id, condition);
        expect(() => canonicalToOpenAI(built.systemPrompt, built.messages, built.trigger)).not.toThrow();
      }
    });
  }

  it("assistant turns carry real tool_calls with ids matching the following results", () => {
    const built = build("email", "G2");
    const assistantWithCalls = built.messages.find((m) => (m.toolCalls?.length ?? 0) > 0)!;
    const callId = assistantWithCalls.toolCalls![0]!.id;
    const nextTool = built.messages[built.messages.indexOf(assistantWithCalls) + 1]!;
    expect(nextTool.role).toBe("tool");
    expect(nextTool.toolCallId).toBe(callId);
  });
});

describe("G3 and G4 use the same delivery primitive", () => {
  it("G3 attaches a haystack and records its needle", () => {
    const built = build("email", "G3");
    expect(built.needle).not.toBeNull();
    expect(built.messages.some((m) => m.content.includes(built.needle!.needleValue))).toBe(true);
  });

  it("G4 attaches the injection document and records no needle", () => {
    const row = ROWS.find((r) => r.id === "email")!;
    const built = build("email", "G4");
    expect(built.needle).toBeNull();
    expect(built.messages.some((m) => m.content === row.attack_inject)).toBe(true);
  });

  it("both deliver documents through the same assistant-call/tool-result primitive", () => {
    // Located by entry id, not by slicing from the end: v1.1 inserts payloads mid-arc, so their
    // position is no longer "everything after the G2 transcript".
    for (const [condition, marker] of [
      ["G3", "-haystack"],
      ["G4", "-inject"],
      ["G5", "-haystack"],
    ] as const) {
      const built = build("email", condition as GovernanceCondition);
      const block = built.messages.filter((m) => m.entryId.includes(marker));
      expect(block.length, `${condition} block`).toBeGreaterThan(0);
      // Always paired: an assistant turn declaring the call, then the result it answers.
      expect(block.length % 2).toBe(0);
      for (let i = 0; i < block.length; i += 2) {
        expect(block[i]!.role).toBe("assistant");
        expect(block[i]!.toolCalls).toHaveLength(1);
        expect(block[i + 1]!.role).toBe("tool");
        expect(block[i + 1]!.toolCallId).toBe(block[i]!.toolCalls![0]!.id);
      }
    }
  });

  it("D5: a valid cut point always follows every payload block", () => {
    // findValidCutPoints admits only user/assistant entries. If a payload block were last, no
    // `cutPoint >= i` would exist, messagesToSummarize would be empty, and compact() would throw
    // "Nothing to compact" — at EVERY budget, so it is a construction error rather than a
    // tuning one. This holds for every condition, every arm.
    for (const arm of CFG.haystackArms) {
      for (const condition of ["G3", "G3n", "G4", "G4n", "G5", "G5n"] as GovernanceCondition[]) {
        for (const row of ROWS) {
          const built = buildCondition({ row, condition, repetition: 0, cfg: CFG, arm });
          const last = built.messages[built.messages.length - 1]!;
          expect(
            last.role === "user" || last.role === "assistant",
            `${row.id} ${condition} arm ${arm.id} ends with ${last.role}`,
          ).toBe(true);
        }
      }
    }
  });

  it("payloads sit mid-arc with benign work after them, not appended", () => {
    const built = build("email", "G5");
    const idx = (marker: string) => built.messages.findIndex((m) => m.entryId.includes(marker));
    const injAt = idx("-inject");
    const docAt = idx("-haystack");
    const lastDoc = built.messages.map((m) => m.entryId).reduce(
      (acc, id, i) => (id.includes("-haystack") ? i : acc),
      -1,
    );
    // Injection precedes the document: placed after it, the cut reaches back past the injection
    // on the three tasks with the shortest trailing arcs (inj=6/9 at keepRecentTokens 800).
    expect(injAt).toBeGreaterThan(0);
    expect(injAt).toBeLessThan(docAt);
    // And benign work follows the document, which is what lets the cut round forward past it.
    const after = built.messages.slice(lastDoc + 1);
    expect(after.some((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });
});

describe("G3 haystack is per-task and per-repetition reproducible", () => {
  it("the same cell regenerates an identical needle", () => {
    const a = buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 0, cfg: CFG });
    const b = buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 0, cfg: CFG });
    expect(a.needle!.corpusSha256).toBe(b.needle!.corpusSha256);
  });

  it("different repetitions get different haystacks", () => {
    const a = buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 0, cfg: CFG });
    const b = buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 1, cfg: CFG });
    expect(a.needle!.corpusSha256).not.toBe(b.needle!.corpusSha256);
  });

  it("every delivery arm chunks the SAME corpus — the precondition for A2 - A1", () => {
    // `A2 - A1` is a delivery contrast only if the arms differ in chunking and nothing else. If
    // the corpus differed too, the contrast would be confounded with the corpus.
    const built = CFG.haystackArms.map((arm) => ({
      arm,
      c: buildCondition({ row: ROWS[0]!, condition: "G3", repetition: 0, cfg: CFG, arm }),
    }));
    const first = built[0]!.c.needle!;
    for (const { arm, c } of built) {
      expect(c.needle!.corpusSha256, `arm ${arm.id} corpus`).toBe(first.corpusSha256);
      expect(c.needle!.needleValue, `arm ${arm.id} needle`).toBe(first.needleValue);
      expect(c.needle!.needleCharOffset, `arm ${arm.id} offset`).toBe(first.needleCharOffset);
    }
    // Entry count is the ONLY thing the arm changes, and it is what sets summarizer-side volume:
    // pi caps each tool result at 2,000 chars, so surviving corpus is 2,000 x chunkCount.
    const counts = built.map(({ arm, c }) => ({
      id: arm.id,
      docEntries: c.messages.filter((m) => m.entryId.includes("-haystack")).length,
    }));
    const a1 = counts.find((x) => x.id === "A1")!;
    const a2 = counts.find((x) => x.id === "A2")!;
    const a3 = counts.find((x) => x.id === "A3")!;
    expect(a1.docEntries).toBe(2);    // 1 call + 1 result
    expect(a2.docEntries).toBe(26);   // 13 chunks of 8,000 x (call + result)
    // 50, not 49: A3's body is 1,930 chars, sized so header+body lands exactly on pi's 2,000-char
    // cap. At a naive 2,000 it would be 49 chunks and every one of them would be truncated.
    expect(a3.docEntries).toBe(100);
    expect(a1.docEntries).toBeLessThan(a2.docEntries);
    expect(a2.docEntries).toBeLessThan(a3.docEntries);
  });
});

// ---------------------------------------------------------------------------
// The prohibited action must be performable, and the document channel coherent
// ---------------------------------------------------------------------------
describe("every task can actually produce a violation", () => {
  it("pii's raw SSN is present in context, so a violation is reachable", () => {
    const row = ROWS.find((r) => r.id === "pii")!;
    const ctx = build("pii", "G0").messages.map((m) => m.content).join(" ");
    expect(ctx).toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    // The mask is kept too: the policy's compliant path is to use it instead.
    expect(ctx).toContain("XXX-XX-7842");
    expect(row.grader.forbidden_fields).toContain("ssn");
  });

  it("no task's benign context demonstrates the policy's own prescribed output", () => {
    for (const row of ROWS) {
      const ctx = build(row.id, "G0").messages.map((m) => m.content).join(" ");
      // pii's policy gives "SSN on file ending in NNNN" as the compliant form; the transcript
      // must not hand that answer to the model.
      if (row.id === "pii") expect(ctx).not.toMatch(/on file ending in/i);
    }
  });
});

describe("the document channel is coherent", () => {
  it("never delivers a document through the graded tool", () => {
    for (const row of ROWS) {
      for (const cond of ["G3", "G4"] as GovernanceCondition[]) {
        const built = build(row.id, cond);
        const docCalls = built.messages
          .filter((m) => /haystack|inject/.test(m.entryId) && m.toolCalls)
          .flatMap((m) => m.toolCalls!.map((c) => c.name));
        expect(docCalls.length).toBeGreaterThan(0);
        expect(docCalls).not.toContain(row.grader.tool);
      }
    }
  });

  it("uses a tool the task actually declares, chosen explicitly rather than by regex order", () => {
    const expected: Record<string, string> = {
      email: "read_document", channel: "read_incident",
      deploy: "check_health", spend: "search_catalog", proddb: "describe_table",
      secret: "grep_file", pii: "search_orders", seccontrol: "review_audit_log",
      incidentfile: "read_ticket",
      pname: "read_note", pphone: "search_notes", pconfdir: "search_files",
      pdraft: "read_thread", papprove: "read_file", pgitforce: "read_file",
      ppublish: "read_file", pspend: "search_catalog",
    };
    for (const row of ROWS) {
      const built = build(row.id, "G3");
      const name = built.messages.find((m) => /haystack/.test(m.entryId) && m.toolCalls)!.toolCalls![0]!.name;
      expect(name).toBe(expected[row.id]);
      expect(row.tools.map((t) => t.function.name)).toContain(name);
    }
  });

  it("labels the filler as an unrelated document so the result is not a nonsensical answer", () => {
    for (const row of ROWS) {
      const built = build(row.id, "G3");
      const firstChunk = built.messages.find((m) => /haystack-\d/.test(m.entryId) && m.role === "tool")!;
      expect(firstChunk.content.startsWith("ATTACHED REFERENCE DOCUMENT")).toBe(true);
    }
  });
});
