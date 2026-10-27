/**
 * "Full context" must mean it.
 *
 * The failure these tests exist to catch is not a missing control. It is a control that was built,
 * quietly lost content on the way to the provider, and got reported as full context anyway --
 * every number it produced looking perfectly valid.
 */
import { describe, expect, it } from "vitest";
import {
  checkWindowFit,
  contextWindowFor,
  estimateRequestTokens,
  verifyFullContext,
} from "../src/compaction/full-context.ts";
import { canonicalToOpenAI } from "../src/rule-loss/evaluator.ts";
import { buildConditionV12 } from "../src/context/transcript-v12.ts";
import { loadMvpConfig } from "../src/config/config.ts";
import { loadTaskRows } from "../src/rule-loss/dataset.ts";
import type { ConditionSpec } from "../src/plan/spec.ts";

const cfg = loadMvpConfig();
const row = loadTaskRows("data/rule-loss/cases.jsonl").find((r) => r.id === "email")!;

const FULL_WITH_FILLER: ConditionSpec = {
  policyPresent: true,
  fillerPresent: true,
  attackPresent: true,
  contextHandling: "full",
  compactionStrategy: null,
  compactionBackend: null,
  haystackArm: "A3",
  attackInsertion: "after-benign-block-1",
  policyChannel: "c1",
  protocolVersion: "v1.2",
  legacyLabel: null,
};

function serialize(spec: ConditionSpec) {
  const built = buildConditionV12({ row, spec, repetition: 0, cfg });
  const request = canonicalToOpenAI(built.systemPrompt, built.messages, built.trigger);
  return { built, serialized: JSON.stringify(request) };
}

describe("the filler really reaches the request", () => {
  it("verifies a genuinely untouched full-context request", () => {
    const { built, serialized } = serialize(FULL_WITH_FILLER);
    const check = verifyFullContext(built.messages, serialized);
    expect(check.missingEntryIds).toEqual([]);
    expect(check.fullContextVerified).toBe(true);
  });

  it("carries the whole ~96k-char corpus, not a 2,000-char prefix of each chunk", () => {
    // The specific requirement: the full-context arm must NOT inherit pi's tool-result cap.
    const { built, serialized } = serialize(FULL_WITH_FILLER);
    const fillerChars = built.messages
      .filter((m) => m.entryId.includes("-haystack") && m.role === "tool")
      .reduce((n, m) => n + m.content.length, 0);
    expect(fillerChars).toBeGreaterThan(90000);
    expect(serialized.length).toBeGreaterThan(90000);
  });

  it("catches a filler body that was truncated on the way to the provider", () => {
    const { built, serialized } = serialize(FULL_WITH_FILLER);
    // Simulate exactly the silent loss this check exists for: one chunk clipped to 2,000 chars.
    const victim = built.messages.find(
      (m) => m.entryId.includes("-haystack") && m.role === "tool" && m.content.length > 1500,
    )!;
    const damaged = serialized.replace(
      JSON.stringify(victim.content).slice(1, -1),
      JSON.stringify(victim.content.slice(0, 200)).slice(1, -1),
    );
    const check = verifyFullContext(built.messages, damaged);
    expect(check.fullContextVerified).toBe(false);
    expect(check.missingEntryIds).toContain(victim.entryId);
  });

  it("records the request size whether or not it verified", () => {
    const { built, serialized } = serialize(FULL_WITH_FILLER);
    const check = verifyFullContext(built.messages, serialized);
    expect(check.finalRequestChars).toBe(serialized.length);
    expect(check.finalRequestMessages).toBe(built.messages.length);
    expect(check.estimatedRequestTokens).toBe(estimateRequestTokens(serialized));
  });
});

describe("window fit gate", () => {
  it("passes a request that fits with its response allowance", () => {
    expect(
      checkWindowFit({
        estimatedRequestTokens: 30000,
        responseAllowanceTokens: 4096,
        contextWindowTokens: 128000,
      }).fits,
    ).toBe(true);
  });

  it("fails rather than trimming when the request does not fit", () => {
    // Do not silently trim the input and still label the result "full".
    const fit = checkWindowFit({
      estimatedRequestTokens: 126000,
      responseAllowanceTokens: 4096,
      contextWindowTokens: 128000,
    });
    expect(fit.fits).toBe(false);
    expect(fit.estimatedRequestTokens + fit.responseAllowanceTokens).toBeGreaterThan(
      fit.contextWindowTokens,
    );
  });

  it("the real full-context request fits every panel model's window", () => {
    // If this ever fails, the full-context comparison is unavailable for that model and the run
    // must say so via full_context_exceeds_window rather than quietly shrinking the input.
    const { serialized } = serialize(FULL_WITH_FILLER);
    const tokens = estimateRequestTokens(serialized);
    for (const model of [
      "google/gemma-4-31b-it",
      "deepseek/deepseek-v4-flash-0731",
      "z-ai/glm-5.3-flash",
      "qwen/qwen3.7-flash",
    ]) {
      const fit = checkWindowFit({
        estimatedRequestTokens: tokens,
        responseAllowanceTokens: 4096,
        contextWindowTokens: contextWindowFor(model),
      });
      expect(fit.fits, `${model} cannot hold the full-context request (${tokens} tok)`).toBe(true);
    }
  });
});
