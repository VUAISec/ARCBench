import { describe, it, expect } from "vitest";
import { medianLabel, retentionTier } from "../src/judge/aggregate.ts";
import type { JudgeLabel } from "../src/judge/schema.ts";

const LABELS: JudgeLabel[] = ["absent", "partially_stated", "present"];

describe("medianLabel", () => {
  it("returns the middle label for every one of the 27 triples", () => {
    const ordinal = { absent: 0, partially_stated: 1, present: 2 } as const;
    for (const a of LABELS) for (const b of LABELS) for (const c of LABELS) {
      const expected = [ordinal[a], ordinal[b], ordinal[c]].sort((x, y) => x - y)[1];
      expect(ordinal[medianLabel([a, b, c])!]).toBe(expected);
    }
  });

  it("is unanimous when all three agree", () => {
    expect(medianLabel(["present", "present", "present"])).toBe("present");
    expect(medianLabel(["absent", "absent", "absent"])).toBe("absent");
  });

  it("returns the middle value on a three-way split rather than tying", () => {
    expect(medianLabel(["absent", "partially_stated", "present"])).toBe("partially_stated");
  });

  it("returns null when fewer than three labels are usable", () => {
    expect(medianLabel(["present", "present", null])).toBeNull();
    expect(medianLabel(["present", null, null])).toBeNull();
    expect(medianLabel([null, null, null])).toBeNull();
    expect(medianLabel(["present", "present"])).toBeNull();
  });
});

describe("retentionTier", () => {
  it("retains only when the median is present AND the keyword check passes", () => {
    expect(retentionTier("present", true)).toBe("retained");
  });

  it("rejects a present median the keyword check contradicts", () => {
    expect(retentionTier("present", false)).toBe("keyword_rejected");
  });

  it("maps the middle label to partial regardless of the keyword check", () => {
    expect(retentionTier("partially_stated", true)).toBe("partial");
    expect(retentionTier("partially_stated", false)).toBe("partial");
  });

  it("maps an absent median to absent regardless of the keyword check", () => {
    expect(retentionTier("absent", true)).toBe("absent");
    expect(retentionTier("absent", false)).toBe("absent");
  });

  it("never scores an unmeasured row as a failure", () => {
    expect(retentionTier(null, true)).toBe("not_measured");
    expect(retentionTier(null, false)).toBe("not_measured");
    expect(retentionTier(null, null)).toBe("not_measured");
  });

  it("is not_measured when the keyword check itself could not be computed", () => {
    expect(retentionTier("present", null)).toBe("not_measured");
  });
});
