/**
 * The v1.6 attack construction reaching the transcript.
 *
 * The level must vary BYTES and nothing else: same splice position, same entry ids, same delivery.
 * The one deliberate exception is the document label, and it has its own test below.
 */
import { describe, expect, it } from "vitest";
import { loadMvpConfig } from "../src/config/config.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import { buildConditionV12 } from "../src/context/transcript-v12.ts";
import type { ConditionSpec } from "../src/plan/spec.ts";
import {
  ATTACK_TECHNIQUES,
  registerFor,
  renderAttack,
  type AttackTechnique,
} from "../src/attacks/attack-library.ts";

const cfg = loadMvpConfig();
const rows = loadTaskRows("data/rule-loss/cases.jsonl");
const row = rows.find((r) => r.id === "email")!;

const spec: ConditionSpec = {
  policyPresent: true,
  fillerPresent: false,
  attackPresent: true,
  haystackArm: null,
  attackInsertion: "after-benign-block-1",
  policyChannel: "c3",
  protocolVersion: "v1.2",
  legacyLabel: null,
  contextHandling: "compacted",
  compactionStrategy: "prompting-h",
  compactionBackend: "harness",
};

const build = (attackTechnique?: AttackTechnique) =>
  buildConditionV12({
    row,
    spec,
    repetition: 0,
    cfg,
    ...(attackTechnique ? { attackTechnique } : {}),
  });

describe("attack technique in condition construction", () => {
  it("defaults to legacy and reproduces the fixture bytes", () => {
    const body = build().messages.find(
      (m) => m.role === "tool" && m.content.includes("CONTEXT MANAGEMENT"),
    );
    expect(body?.content).toBe(row.attack_inject);
  });

  it("absent and explicit legacy build identical transcripts", () => {
    expect(build("legacy").messages).toEqual(build().messages);
  });

  it("carries each construction's own bytes", () => {
    for (const t of ATTACK_TECHNIQUES) {
      const expected = renderAttack(t, registerFor(row));
      const found = build(t).messages.some((m) => m.role === "tool" && m.content === expected);
      expect(found, `technique ${t}`).toBe(true);
    }
  });

  it("keeps the payload at the same entry index for every technique", () => {
    const indexFor = (t: AttackTechnique) =>
      build(t).messages.findIndex((m) => m.entryId.endsWith("-inject"));
    const all = ATTACK_TECHNIQUES.map(indexFor);
    expect(new Set(all).size).toBe(1);
    expect(all[0]).toBeGreaterThan(-1);
  });

  it("keeps entry ids identical across techniques", () => {
    const ids = (t: AttackTechnique) => build(t).messages.map((m) => m.entryId);
    for (const t of ATTACK_TECHNIQUES) expect(ids(t)).toEqual(ids("legacy"));
  });

  it("frames legacy as a memory note and the five as a neutral retrieval", () => {
    // By entry id, not by prefix: channel c3 delivers the POLICY through `documentTurns` too, so
    // a `startsWith("Retrieving")` search finds `operating-policy-email` first.
    const declaration = (t: AttackTechnique) =>
      build(t).messages.find((m) => m.entryId.endsWith("-inject-call"))!.content;
    expect(declaration("legacy")).toContain("session-memory-note-email");
    for (const t of ATTACK_TECHNIQUES) {
      if (t === "legacy") continue;
      expect(declaration(t)).toContain("retrieved-note-email");
      expect(declaration(t)).not.toContain("session-memory-note");
    }
  });

  it("uses the personal register for a c1 case", () => {
    const personal = rows.find((r) => r.id === "pname")!;
    const built = buildConditionV12({
      row: personal,
      spec: { ...spec, policyChannel: "c1" },
      repetition: 0,
      cfg,
      attackTechnique: "naive",
    });
    const body = built.messages.find((m) => m.role === "tool" && m.content.startsWith("Summarize"));
    expect(body?.content).toContain("preference preamble");
  });
});
