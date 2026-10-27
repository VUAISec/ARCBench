import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  AUDIT_SYSTEM_PROMPT,
  AUDIT_PROMPT_SHA256,
  parseAuditReply,
  spanIsVerbatim,
  selectAuditSlice,
} from "../src/judge/audit.ts";
import type { JudgeTask } from "../src/judge/schema.ts";

const task = (runId: string, parsed: boolean): JudgeTask => ({
  runId, model: "m/a", modelDir: "m-a", arm: "acon-ut", taskId: "email",
  summary: "s", policy: "p", lexical: null, lexicalSectionParsed: parsed,
});

describe("audit prompt", () => {
  it("publishes a SHA-256 matching the prompt it ships", () => {
    expect(AUDIT_PROMPT_SHA256).toBe(
      createHash("sha256").update(AUDIT_SYSTEM_PROMPT, "utf8").digest("hex"),
    );
  });

  it("differs from the scoring rubric, so audit rows can never be mistaken for metric rows", async () => {
    const { JUDGE_PROMPT_SHA256 } = await import("../src/judge/rubric.ts");
    expect(AUDIT_PROMPT_SHA256).not.toBe(JUDGE_PROMPT_SHA256);
  });
});

describe("parseAuditReply", () => {
  it("reads the label and the span from a JSON object", () => {
    const out = parseAuditReply('{"label":"present","span":"only @nexus-corp.com"}');
    expect(out.label).toBe("present");
    expect(out.span).toBe("only @nexus-corp.com");
  });

  it("returns a null label on prose", () => {
    expect(parseAuditReply("I think it is present").label).toBeNull();
  });

  it("tolerates a fenced JSON block", () => {
    const out = parseAuditReply('```json\n{"label":"absent","span":""}\n```');
    expect(out.label).toBe("absent");
  });
});

describe("spanIsVerbatim", () => {
  const summary = "Policy: only @nexus-corp.com addresses may be emailed.";

  it("accepts a substring of the summary", () => {
    expect(spanIsVerbatim("only @nexus-corp.com", summary)).toBe(true);
  });

  it("accepts an empty span, which pairs with an absent label", () => {
    expect(spanIsVerbatim("", summary)).toBe(true);
  });

  it("rejects a span the summary does not contain -- a confabulated citation", () => {
    expect(spanIsVerbatim("never email customers", summary)).toBe(false);
  });

  it("ignores whitespace differences rather than failing on reflow", () => {
    expect(spanIsVerbatim("only   @nexus-corp.com", summary)).toBe(true);
  });
});

describe("selectAuditSlice", () => {
  it("over-weights unparsed-section rows, which are the adversarial slice", () => {
    const tasks = [
      ...Array.from({ length: 100 }, (_, i) => task(`u-${i}`, false)),
      ...Array.from({ length: 100 }, (_, i) => task(`p-${i}`, true)),
    ];
    const slice = selectAuditSlice(tasks, 100);
    expect(slice).toHaveLength(100);
    expect(slice.filter((t) => !t.lexicalSectionParsed).length).toBe(50);
  });

  it("is deterministic across calls", () => {
    const tasks = Array.from({ length: 200 }, (_, i) => task(`t-${i}`, i % 2 === 0));
    expect(selectAuditSlice(tasks, 40).map((t) => t.runId))
      .toEqual(selectAuditSlice(tasks, 40).map((t) => t.runId));
  });

  it("returns everything available when asked for more than exists", () => {
    expect(selectAuditSlice([task("a", true), task("b", false)], 100)).toHaveLength(2);
  });
});
