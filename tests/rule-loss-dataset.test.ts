import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTaskRows, DatasetError } from "../src/rule-loss/dataset.ts";

/**
 * v1.3 adds two per-row fields the case taxonomy requires.
 *
 * `provenance` is NOT folded into `source_fidelity`. Fidelity answers "how faithful is this to a
 * published release"; provenance answers "where did this case come from". An authored case has no
 * release to be faithful to, so one field carrying both would make one value mean two things.
 *
 * `channel_affinity` is the one delivery channel a case would plausibly arrive through. `c2` is
 * never a valid affinity: `channelInstruction()` hands the model the policy in a user turn and
 * then asks it to persist the text, so `c2` structurally CONTAINS `c1` and is a transform over a
 * personal case rather than a case's home channel.
 */
const DATASET = "data/rule-loss/cases.jsonl";

function rows(): Array<Record<string, unknown>> {
  return readFileSync(DATASET, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Write a mutated copy of the shipped dataset and load it, so the test exercises real rows. */
function loadWithFirstRowPatched(patch: Record<string, unknown>): ReturnType<typeof loadTaskRows> {
  const all = rows();
  all[0] = { ...all[0], ...patch };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (all[0] as Record<string, unknown>)[k];
  }
  const dir = mkdtempSync(join(tmpdir(), "constraintrot-"));
  const path = join(dir, "constraintrot.jsonl");
  writeFileSync(path, all.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return loadTaskRows(path);
}

describe("provenance", () => {
  it("every shipped row declares one of GD / CI / DER / NEW", () => {
    for (const row of loadTaskRows(DATASET)) {
      expect(["GD", "CI", "DER", "NEW"]).toContain(row.provenance);
    }
  });

  it("rejects an unrecognised value rather than running an unlabelled case", () => {
    expect(() => loadWithFirstRowPatched({ provenance: "paper" })).toThrow(DatasetError);
  });

  it("rejects a missing value; there is no default provenance", () => {
    expect(() => loadWithFirstRowPatched({ provenance: undefined })).toThrow(DatasetError);
  });

  it("stays separate from source_fidelity, which answers a different question", () => {
    for (const row of loadTaskRows(DATASET)) {
      expect(["reconstructed-from-paper", "exact-release", "authored"]).toContain(row.source_fidelity);
    }
  });

  it("an authored case never claims to have been reconstructed from a paper", () => {
    for (const row of loadTaskRows(DATASET)) {
      if (row.provenance === "NEW" || row.provenance === "DER") {
        expect(row.source_fidelity).toBe("authored");
      } else {
        expect(row.source_fidelity).not.toBe("authored");
      }
    }
  });
});

describe("channel_affinity", () => {
  it("every shipped row names its home channel", () => {
    for (const row of loadTaskRows(DATASET)) {
      expect(["c1", "c3", "c4"]).toContain(row.channel_affinity);
    }
  });

  it("rejects c2, which structurally contains c1 and is a transform rather than a home", () => {
    expect(() => loadWithFirstRowPatched({ channel_affinity: "c2" })).toThrow(/c2/);
  });

  it("rejects an unknown channel", () => {
    expect(() => loadWithFirstRowPatched({ channel_affinity: "c9" })).toThrow(DatasetError);
  });

  it("rejects a missing value rather than falling back to the global channel", () => {
    expect(() => loadWithFirstRowPatched({ channel_affinity: undefined })).toThrow(DatasetError);
  });

  it("personal-authority cases are all c1; the organizational ones never are", () => {
    // Affinity derives from authority first, so this is the shape it has to have.
    // Listed explicitly rather than inferred from the id: `pii` and `proddb` are organizational.
    const PERSONAL = new Set([
      "pname", "pphone", "pconfdir", "pdraft", "papprove", "pgitforce", "ppublish", "pspend",
    ]);
    for (const row of loadTaskRows(DATASET)) {
      if (PERSONAL.has(row.id)) expect(row.channel_affinity).toBe("c1");
      else expect(row.channel_affinity === "c3" || row.channel_affinity === "c4").toBe(true);
    }
  });
});
