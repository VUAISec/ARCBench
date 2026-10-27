import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATIVE_ARMS, loadPolicies, loadSweep } from "../src/judge/rows.ts";

function sweepFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "judge-rows-"));
  mkdirSync(join(dir, "m-a"));
  copyFileSync("tests/fixtures/judge/results-sample.jsonl", join(dir, "m-a", "results.jsonl"));
  return dir;
}

describe("loadPolicies", () => {
  it("keys policy text by taskId", () => {
    const p = loadPolicies("tests/fixtures/judge/cases-sample.jsonl");
    expect(p.get("email")).toContain("@nexus-corp.com");
    expect(p.size).toBe(2);
  });
});

describe("loadSweep", () => {
  const policies = () => loadPolicies("tests/fixtures/judge/cases-sample.jsonl");

  it("judges only valid rows on generative arms", () => {
    const { judged } = loadSweep({ sweepDir: sweepFixture(), policies: policies() });
    expect(judged.map((t) => t.runId).sort()).toEqual(["r-gen-1", "r-gen-2"]);
  });

  it("attaches the policy text for the row's task", () => {
    const { judged } = loadSweep({ sweepDir: sweepFixture(), policies: policies() });
    const email = judged.find((t) => t.runId === "r-gen-1")!;
    expect(email.policy).toContain("@nexus-corp.com");
  });

  it("records whether the lexical section parsed, separately from its verdict", () => {
    const { judged } = loadSweep({ sweepDir: sweepFixture(), policies: policies() });
    expect(judged.find((t) => t.runId === "r-gen-1")!.lexicalSectionParsed).toBe(false);
    expect(judged.find((t) => t.runId === "r-gen-1")!.lexical).toBeNull();
    expect(judged.find((t) => t.runId === "r-gen-2")!.lexicalSectionParsed).toBe(true);
    expect(judged.find((t) => t.runId === "r-gen-2")!.lexical).toBe(true);
  });

  it("scores selection arms without a model call", () => {
    const { deterministic } = loadSweep({ sweepDir: sweepFixture(), policies: policies() });
    const kept = deterministic.find((r) => r.runId === "r-sel-kept")!;
    const evicted = deterministic.find((r) => r.runId === "r-sel-evicted")!;
    expect(kept.tier).toBe("retained");
    expect(kept.source).toBe("tail_credit");
    expect(kept.calls).toEqual([]);
    expect(evicted.tier).toBe("absent");
    expect(evicted.source).toBe("selection");
  });

  it("excludes full-context rows entirely", () => {
    const { judged, deterministic } = loadSweep({ sweepDir: sweepFixture(), policies: policies() });
    const all = [...judged.map((t) => t.runId), ...deterministic.map((r) => r.runId)];
    expect(all).not.toContain("r-full");
  });

  it("throws rather than guessing when a taskId has no policy", () => {
    const empty = new Map<string, string>();
    expect(() => loadSweep({ sweepDir: sweepFixture(), policies: empty })).toThrow(/email/);
  });

  it("carries anchors whose recorded truth matches what the summaries say", () => {
    const anchors = JSON.parse(readFileSync("tests/fixtures/judge/anchors.json", "utf8")) as
      Record<string, { summary: string; truth: string; lexicalSectionParsed: boolean }>;
    // The unparsed-section case: lexical scores it zero because no section parsed, yet the rule
    // is there.
    expect(anchors["unparsed_rule_present"]!.lexicalSectionParsed).toBe(false);
    expect(anchors["unparsed_rule_present"]!.truth).toBe("present");
    expect(anchors["unparsed_rule_present"]!.summary.toLowerCase()).toContain("nexus-corp.com");
    // The negative: a parsed section that does not carry this task's rule.
    expect(anchors["parsed_rule_absent"]!.truth).toBe("absent");
    expect(anchors["parsed_rule_absent"]!.lexicalSectionParsed).toBe(true);
  });

  it("records how each anchor's truth was established, never inheriting the lexical verdict", () => {
    // The first cut set truth=present because the lexical metric said kept. That is circular --
    // the lexical metric is the thing under test -- so every truth is now read from the summary.
    const anchors = JSON.parse(readFileSync("tests/fixtures/judge/anchors.json", "utf8")) as
      Record<string, { truth: string; acceptable: string[]; truth_basis: string }>;
    for (const [name, a] of Object.entries(anchors)) {
      expect(a.truth_basis, name).toMatch(/human-read/);
      expect(a.acceptable, name).toContain(a.truth);
    }
    // Only the genuine boundary case admits two labels.
    expect(anchors["parsed_rule_present"]!.acceptable).toEqual(["present", "partially_stated"]);
    expect(anchors["unparsed_rule_present"]!.acceptable).toEqual(["present"]);
    expect(anchors["parsed_rule_absent"]!.acceptable).toEqual(["absent"]);
  });

  it("carries the directory it read from, rather than slugifying the model name", () => {
    // Regression: `~openai/gpt-luna-latest` slugifies to `-openai-gpt-luna-latest` while the
    // real directory is `openai-gpt-luna-latest`. Deriving the path crashed the first smoke run.
    const { judged, deterministic } = loadSweep({ sweepDir: sweepFixture(), policies: policies() });
    expect(judged.every((t) => t.modelDir === "m-a")).toBe(true);
    expect(deterministic.every((r) => r.modelDir === "m-a")).toBe(true);
  });

  it("names the seven generative arms", () => {
    expect(GENERATIVE_ARMS.size).toBe(7);
    expect(GENERATIVE_ARMS.has("prompting-h")).toBe(true);
    expect(GENERATIVE_ARMS.has("fifo")).toBe(false);
  });
});
