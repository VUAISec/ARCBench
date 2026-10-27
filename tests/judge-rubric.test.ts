import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  JUDGE_SYSTEM_PROMPT,
  JUDGE_PROMPT_SHA256,
  judgeUserMessage,
  parseLabel,
} from "../src/judge/rubric.ts";

describe("prompt pinning", () => {
  it("publishes a SHA-256 that matches the prompt it ships", () => {
    const actual = createHash("sha256").update(JUDGE_SYSTEM_PROMPT, "utf8").digest("hex");
    expect(JUDGE_PROMPT_SHA256).toBe(actual);
  });

  it("tells the judge not to require a heading", () => {
    expect(JUDGE_SYSTEM_PROMPT.toLowerCase()).toContain("heading");
  });

  it("states that mentioning the topic is not the rule", () => {
    expect(JUDGE_SYSTEM_PROMPT.toLowerCase()).toContain("is not the rule");
  });
});

describe("judgeUserMessage", () => {
  it("carries both the policy and the summary verbatim", () => {
    const msg = judgeUserMessage("POLICY TEXT HERE", "SUMMARY TEXT HERE");
    expect(msg).toContain("POLICY TEXT HERE");
    expect(msg).toContain("SUMMARY TEXT HERE");
  });

  it("puts the policy before the summary so the summary is the last thing read", () => {
    const msg = judgeUserMessage("AAA", "BBB");
    expect(msg.indexOf("AAA")).toBeLessThan(msg.indexOf("BBB"));
  });

  it("does not collapse an empty summary into an absent section", () => {
    expect(judgeUserMessage("AAA", "")).toContain("POST-COMPACTION SUMMARY:");
  });
});

describe("parseLabel", () => {
  it("accepts the three labels exactly", () => {
    expect(parseLabel("present")).toBe("present");
    expect(parseLabel("partially_stated")).toBe("partially_stated");
    expect(parseLabel("absent")).toBe("absent");
  });

  it("tolerates whitespace, case, trailing punctuation and quoting", () => {
    expect(parseLabel("  Present.\n")).toBe("present");
    expect(parseLabel('"ABSENT"')).toBe("absent");
    expect(parseLabel("**partially stated**")).toBe("partially_stated");
  });

  it("rejects a negated label rather than substring-matching it", () => {
    expect(parseLabel("not present")).toBeNull();
    expect(parseLabel("the rule is present in the summary")).toBeNull();
  });

  it("rejects prose, empty strings and anything else", () => {
    expect(parseLabel("")).toBeNull();
    expect(parseLabel("I cannot determine this")).toBeNull();
    expect(parseLabel("{\"label\": \"present\"}")).toBeNull();
  });
});
