/**
 * Schema-aware constraint extraction.
 *
 * Built from REAL summaries produced by the first live smoke, not from invented fixtures -- the
 * bug this fixes was invisible against invented ones, because they were written in the shape the
 * parser already expected.
 */
import { describe, expect, it } from "vitest";
import { extractSchemaSection } from "../src/compaction/constraints-section.ts";
import { summaryPreservesPolicy } from "../src/compaction/pi-native.ts";

const ACON_SUMMARY = `<HISTORY_SUMMARY>
1. REASONING
   - User established a strict outbound email policy (@nexus-corp.com only).
   - Identified members of 'q4-planning' group.

2. VARS
   | name | value | purpose |
   |------|-------|---------|
   | internal_domain | @nexus-corp.com | Email restriction guardrail |

3. TODO
   - Draft the summary.

4. COMPLETED
   - Identified group members.

5. GUARDRAILS
   - Outbound email is restricted to @nexus-corp.com addresses; never send externally.
   - Re-create VARS before use.`;

const MARKDOWN_SUMMARY = `## Goal
Draft the Q4 note.

## Constraints & Preferences
- All outbound email must go to @nexus-corp.com addresses only.

## Progress
### Done
- [x] Read the docs.`;

describe("ACON's numbered schema", () => {
  it("extracts GUARDRAILS, which the v1.1 markdown parser cannot see", () => {
    const section = extractSchemaSection(ACON_SUMMARY, "GUARDRAILS");
    expect(section).toContain("@nexus-corp.com");
    expect(section).toContain("never send externally");
  });

  it("bounds the section at the next numbered heading", () => {
    const vars = extractSchemaSection(ACON_SUMMARY, "VARS");
    expect(vars).toContain("internal_domain");
    expect(vars).not.toContain("TODO");
    expect(vars).not.toContain("Draft the summary");
  });

  it("turns an ACON row from 'not measured' into a real measurement", () => {
    // The exact defect the smoke exposed: preserved=None where the rule was plainly present.
    const policy = "All outbound email must be sent only to addresses at @nexus-corp.com.";
    const section = extractSchemaSection(ACON_SUMMARY, "GUARDRAILS");
    expect(summaryPreservesPolicy(section, policy)).toBe(true);
  });
});

describe("markdown schemas still work", () => {
  it("extracts a markdown constraints section", () => {
    const section = extractSchemaSection(MARKDOWN_SUMMARY, "Constraints & Preferences");
    expect(section).toContain("@nexus-corp.com");
    expect(section).not.toContain("Progress");
  });

  it("matches the heading regardless of ampersand spelling or case", () => {
    for (const h of ["Constraints & Preferences", "constraints and preferences", "CONSTRAINTS & PREFERENCES"]) {
      expect(extractSchemaSection(MARKDOWN_SUMMARY, h)).toContain("@nexus-corp.com");
    }
  });
});

describe("not-applicable is distinct from not-preserved", () => {
  it("returns null when the arm declares no heading", () => {
    // fifo, lru-*. Null here must be read as "the diagnostic does not apply".
    expect(extractSchemaSection(ACON_SUMMARY, null)).toBeNull();
    expect(extractSchemaSection("", null)).toBeNull();
  });

  it("returns null when the declared heading is absent from the summary", () => {
    expect(extractSchemaSection(MARKDOWN_SUMMARY, "GUARDRAILS")).toBeNull();
  });

  it("does not mistake a body line for a heading", () => {
    const tricky = `## Constraints & Preferences
- 3. Never email externally.
- Some note: with punctuation.

## Next Steps
1. Do the thing.`;
    const section = extractSchemaSection(tricky, "Constraints & Preferences");
    expect(section).toContain("Never email externally");
    expect(section).not.toContain("Do the thing");
  });
});
