/**
 * Prompt fidelity.
 *
 * These prompts are DATA reproduced from published sources. An edit changes what a named method
 * is, while the result still gets reported under that method's name -- a failure mode no reviewer
 * would catch by reading a diff of a 200-line string.
 *
 * Two independent checks:
 *
 *   1. sha256 pins, so any edit at all fails the suite.
 *   2. For the one prompt whose upstream is installed as a dependency, a check against pi's ACTUAL
 *      source rather than against our copy of it. A hash pin only proves the text has not changed
 *      since someone typed it; this proves it matches the thing it claims to be.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACON_SYSTEM_PROMPT,
  ACON_UTCO_DEFAULT_MAX_CHARS,
  ACON_UTCO_GUIDELINE,
  ACON_UT_GUIDELINE,
  BASELINE_FIRST_COMPACTION_PROMPT,
  BASELINE_SYSTEM_PROMPT,
  HERMES_PREAMBLE,
  HERMES_REFERENCE_ONLY_PREFIX,
  HERMES_TEMPLATE,
  POLICY_PRESERVING_INSTRUCTION,
  PROMPT_PROVENANCE,
  TRACE_OPTIMIZED_UPDATE_PROMPT,
} from "../src/compaction/prompts.ts";
import { STRATEGY_IDS } from "../src/compaction/strategy-ids.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * If a test here fails after you edited `prompts.ts`, restore the text. Do not update the hash --
 * that would defeat the only mechanism preventing a published method from silently drifting.
 */
const PINS: Record<string, string> = {
  BASELINE_SYSTEM_PROMPT: "c464889dcfa60441e642f291445b49523f263e6fb2725d0c25075543a2ec3f8f",
  BASELINE_FIRST_COMPACTION_PROMPT: "9b00aa68df1a64279bc36e9093367f638701d48ec82e3d08436f65092a515f9b",
  HERMES_PREAMBLE: "d74545be4e1382bf1ae6db913674f07a45a5ecdbb8994e3d521b41e2552888e7",
  HERMES_TEMPLATE: "d8564076774cdb14aaae597a2f803f69583602d449db106ad885c88079d07108",
  HERMES_REFERENCE_ONLY_PREFIX: "f78fe845c8195f9b55b8850f61b5ee85f962888e0edc8bd14202beb58d88a030",
  ACON_SYSTEM_PROMPT: "f9a0a5188d643d0990a422e94557e781e9e4f9c00a6506f699c4956b7096a392",
  ACON_UT_GUIDELINE: "0e6aebd589a5f53bdef2a5c9257739e81c83081a8920df5d0fcd030d0a29d82f",
  ACON_UTCO_GUIDELINE: "99188ac21f29564af74a65c8da99a536e89646a46ddce2fb5f49866f70e14d43",
  TRACE_OPTIMIZED_UPDATE_PROMPT: "948d8a8c33f014c9f5c4530c7d68e9bf00b2de8e610a2472946acbd897762c44",
  POLICY_PRESERVING_INSTRUCTION: "2d4dd79117b3fa653d3bc32c3c81cbe3fa2327a76c90dfdc27f83844e962572d",
};

const VALUES: Record<string, string> = {
  BASELINE_SYSTEM_PROMPT,
  BASELINE_FIRST_COMPACTION_PROMPT,
  HERMES_PREAMBLE,
  HERMES_TEMPLATE,
  HERMES_REFERENCE_ONLY_PREFIX,
  ACON_SYSTEM_PROMPT,
  ACON_UT_GUIDELINE,
  ACON_UTCO_GUIDELINE,
  TRACE_OPTIMIZED_UPDATE_PROMPT,
  POLICY_PRESERVING_INSTRUCTION,
};

describe("prompt fidelity", () => {
  it.each(Object.keys(PINS))("%s matches its pinned sha256", (key) => {
    expect(sha(VALUES[key]!)).toBe(PINS[key]);
  });

  it("pins every exported prompt, so a new one cannot arrive unpinned", () => {
    expect(Object.keys(VALUES).sort()).toEqual(Object.keys(PINS).sort());
  });
});

describe("baseline prompt really is pi's", () => {
  // The control arm's whole justification is that it carries pi/OpenClaw's DEFAULT prompt. If our
  // copy drifted from pi's actual constant, the control would silently become a fourth method and
  // every Group B contrast would be measured against the wrong reference.
  const PI_SOURCE =
    "node_modules/@earendil-works/pi-coding-agent/src/core/compaction/compaction.ts";

  function piConstant(name: string): string | null {
    let src: string;
    try {
      src = readFileSync(PI_SOURCE, "utf8");
    } catch {
      return null; // pi not installed from source in this checkout
    }
    const m = new RegExp(`const ${name}\\s*=\\s*\`([\\s\\S]*?)\`;`).exec(src);
    return m ? m[1]! : null;
  }

  it("is byte-identical to pi's SUMMARIZATION_PROMPT", () => {
    const upstream = piConstant("SUMMARIZATION_PROMPT");
    if (upstream === null) {
      // Recorded rather than silently passing: the hash pin still covers the text.
      console.warn("pi source not readable; skipping byte-identity check against upstream");
      return;
    }
    expect(BASELINE_FIRST_COMPACTION_PROMPT).toBe(upstream);
  });
});

describe("provenance", () => {
  it("declares provenance for every registered strategy", () => {
    for (const id of STRATEGY_IDS) {
      expect(PROMPT_PROVENANCE[id], `missing provenance for ${id}`).toBeDefined();
    }
  });

  it("marks only genuinely native implementations as native", () => {
    // A locally written imitation must never be labelled as the other system's native
    // implementation. Only pi's own session qualifies.
    const native = Object.entries(PROMPT_PROVENANCE)
      .filter(([, p]) => p.nativeImplementation)
      .map(([id]) => id)
      .sort();
    expect(native).toEqual(["pi-native-cut"]);
  });

  it("marks every harness-boundary arm as having replaced its upstream boundary", () => {
    for (const id of ["prompting-h", "acon-ut", "acon-utco", "trace-optimized", "fifo"]) {
      expect(PROMPT_PROVENANCE[id]!.upstreamBoundaryReplaced).toBe(true);
    }
    // The pi arms use pi's own cut, so nothing was replaced.
    for (const id of ["pi-native-cut", "pi-native-policy-preserving"]) {
      expect(PROMPT_PROVENANCE[id]!.upstreamBoundaryReplaced).toBe(false);
    }
  });

  it("flags trace-optimized as domain-mismatched", () => {
    expect(PROMPT_PROVENANCE["trace-optimized"]!.domainMismatch).toBe(true);
  });
});

describe("bindings", () => {
  it("ACON guidelines declare the three bindings the renderer must supply", () => {
    for (const g of [ACON_UT_GUIDELINE, ACON_UTCO_GUIDELINE]) {
      expect(g).toContain("{{ task }}");
      expect(g).toContain("{{ prev_summary }}");
      expect(g).toContain("{{ history }}");
    }
    expect(ACON_UTCO_GUIDELINE).toContain("{{ max_chars }}");
    expect(ACON_UTCO_DEFAULT_MAX_CHARS).toBe(1500);
  });

  it("the Hermes template declares its budget binding", () => {
    expect(HERMES_TEMPLATE).toContain("{summary_budget}");
  });

  it("the policy-preserving instruction names no fixture and quotes no rule", () => {
    // It must be generic. An instruction that restored the fixture's correct rule would be a
    // different method -- rule restoration -- and would have to be named and tested as one.
    const lowered = POLICY_PRESERVING_INSTRUCTION.toLowerCase();
    for (const leak of ["email", "external", "ssn", "production", "credential", "region"]) {
      expect(lowered, `instruction leaks fixture term "${leak}"`).not.toContain(leak);
    }
  });
});
