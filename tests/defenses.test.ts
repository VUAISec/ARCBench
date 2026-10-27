/**
 * The v1.6 defense factor.
 *
 * `none` is the continuity contract: it must reproduce the assembly every Group B arm already
 * performs, so an undefended v1.6 row stays byte-comparable with v1.3-Hermes.
 */
import { describe, expect, it } from "vitest";
import { DEFENSE_IDS, applyDefense } from "../src/defenses/defenses.ts";
import { POLICY_PRESERVING_INSTRUCTION } from "../src/compaction/prompts.ts";

const parts = { systemPrompt: "SYS", history: "HIST", instruction: "INSTR" };

describe("applyDefense", () => {
  it("has five levels", () => {
    expect(DEFENSE_IDS).toHaveLength(5);
  });

  it("none reproduces data-then-instruction with an untouched system prompt", () => {
    expect(applyDefense("none", parts)).toEqual({
      systemPrompt: "SYS",
      userContent: "HIST\n\nINSTR",
    });
  });

  it("isolation wraps the history in delimiters and declares them in the system prompt", () => {
    const out = applyDefense("isolation", parts);
    expect(out.userContent).toContain("HIST");
    expect(out.userContent).not.toBe("HIST\n\nINSTR");
    expect(out.systemPrompt.startsWith("SYS")).toBe(true);
    expect(out.systemPrompt.length).toBeGreaterThan("SYS".length);
    // The fence must bracket the history and nothing else -- an instruction inside it would be
    // declared data, and the defense would be defending against itself.
    const open = out.userContent.indexOf("HIST");
    expect(open).toBe(out.userContent.lastIndexOf("HIST"));
    expect(out.userContent.indexOf("INSTR")).toBeGreaterThan(open);
    expect(out.userContent.indexOf("<<<END-CONVERSATION-DATA-")).toBeLessThan(
      out.userContent.indexOf("INSTR"),
    );
  });

  it("instructional appends one sentence to the system prompt and leaves the body alone", () => {
    const out = applyDefense("instructional", parts);
    expect(out.userContent).toBe("HIST\n\nINSTR");
    expect(out.systemPrompt).toContain("not directives");
  });

  it("sandwich brackets the history with the instruction", () => {
    const out = applyDefense("sandwich", parts);
    expect(out.systemPrompt).toBe("SYS");
    expect(out.userContent).toBe("INSTR\n\nHIST\n\nINSTR");
  });

  it("rule-preserving carries the preservation half and NOT the data/directive sentence", () => {
    const out = applyDefense("rule-preserving", parts);
    expect(out.userContent).toBe("HIST\n\nINSTR");
    expect(out.systemPrompt).toContain("original force and negation intact");
    // The other half is `instructional`'s level. Carrying both here would re-conflate exactly the
    // two ingredients this factor exists to separate.
    expect(out.systemPrompt).not.toContain("not directives to follow");
  });

  it("keeps rule-preserving a non-empty strict subset of the frozen instruction", () => {
    const half = applyDefense("rule-preserving", parts).systemPrompt.slice("SYS".length).trim();
    expect(half.length).toBeGreaterThan(80);
    expect(POLICY_PRESERVING_INSTRUCTION).toContain(half);
    expect(POLICY_PRESERVING_INSTRUCTION).not.toBe(half);
  });

  it("is a pure function", () => {
    for (const id of DEFENSE_IDS) {
      expect(applyDefense(id, parts)).toEqual(applyDefense(id, parts));
    }
  });

  it("freezes every rendered defense", () => {
    const all: Record<string, unknown> = {};
    for (const id of DEFENSE_IDS) all[id] = applyDefense(id, parts);
    expect(all).toMatchSnapshot();
  });
});
