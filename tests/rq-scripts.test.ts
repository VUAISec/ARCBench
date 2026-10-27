/** scripts/rqN/sM-<name>/run.sh are generated from src/rq/studies.ts and must not drift from it. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { expectedScripts } from "../src/rq/generate-scripts.ts";
import { STUDIES } from "../src/rq/studies.ts";

describe("RQ scripts", () => {
  it.each([...expectedScripts()])("%s is up to date (regenerate: tsx src/rq/generate-scripts.ts)", (path, text) => {
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("every study command is a valid single-configuration command", () => {
    for (const s of STUDIES) {
      for (const flags of [...s.commands, ...s.borrowed]) {
        for (const v of Object.values(flags)) expect(v).not.toContain(",");
      }
    }
  });

  it("command counts are the studies' cell counts", () => {
    const n = (id: string) => STUDIES.find((s) => s.id === id)!;
    expect(STUDIES.map((s) => s.label)).toEqual(["S1 Baseline", "S2 Channel", "S3 Strategy", "S4 Budget", "S5 Injection", "S6 Attack", "S7 Defense"]);
    expect(n("s1-baseline").commands).toHaveLength(2 * 4);
    expect(n("s2-channel").commands).toHaveLength(0);
    expect(n("s2-channel").borrowed).toHaveLength(2 * 4);
    expect(n("s3-strategy").commands).toHaveLength(40 * 4);
    expect(n("s3-strategy").borrowed).toHaveLength(4 * 4);
    expect(n("s4-budget").commands).toHaveLength(35 * 2);
    expect(n("s4-budget").borrowed).toHaveLength(8 * 2);
    expect(n("s5-injection").commands).toHaveLength(3 * 4);
    expect(n("s6-attack").commands).toHaveLength(7 + 7);
    expect(n("s7-defense").commands).toHaveLength(2 * 4);
    expect(n("s7-defense").borrowed).toHaveLength(2 + 2);
  });
});
