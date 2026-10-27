/**
 * Schema-aware extraction of the section carrying constraint material.
 *
 * v1.1's `extractConstraintsSection` looks for a markdown `## Constraints & Preferences` heading,
 * because every strategy it knew about emitted one. ACON does not: its schema uses NUMBERED
 * headings inside a `<HISTORY_SUMMARY>` block --
 *
 *     1. REASONING
 *     2. VARS
 *     ...
 *     5. GUARDRAILS
 *
 * so the v1.1 parser returns null for every ACON row. That is worse than it sounds: null reads as
 * "not measured", and a reader comparing arms would see ACON's diagnostic missing rather than
 * differently shaped, quietly turning a schema difference into an apparent gap in the data.
 *
 * Caught by the first live smoke, where `acon-ut` reported `preserved=None` while its summary
 * plainly carried the rule in both VARS and GUARDRAILS.
 *
 * The v1.1 function is left untouched; historical rows were parsed with it and must stay
 * reproducible.
 */

/** Both heading forms these schemas use. */
const MARKDOWN_HEADING = /^\s*#{1,6}\s*(.+?)\s*$/;
const NUMBERED_HEADING = /^\s*(\d+)\.\s+([A-Z][A-Z _&-]*)\s*$/;

function headingOf(line: string): string | null {
  const numbered = NUMBERED_HEADING.exec(line);
  if (numbered) return numbered[2]!.trim();
  const markdown = MARKDOWN_HEADING.exec(line);
  // A markdown heading line must not carry body text; `## Goal` yes, `# 3 items done` no.
  if (markdown && !/[.:;]/.test(markdown[1]!)) return markdown[1]!.trim();
  return null;
}

function normalise(h: string): string {
  return h.toLowerCase().replace(/\s*&\s*/g, " and ").replace(/[^a-z0-9 ]/g, "").trim();
}

/**
 * Return the body of `heading`, bounded by the next heading of either form.
 *
 * Returns null when the summary has no such section -- which for an arm that declares no heading
 * means the diagnostic does not apply, and must never be read as a preservation failure.
 */
export function extractSchemaSection(summary: string, heading: string | null): string | null {
  if (!heading) return null;
  const want = normalise(heading);
  const lines = summary.split("\n");

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i]!);
    if (h !== null && normalise(h) === want) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (headingOf(lines[i]!) !== null) break;
    body.push(lines[i]!);
  }
  return body.join("\n").trim();
}
