/**
 * Any 5xx from the provider is transient, on both compaction paths.
 *
 * Found live in the v1.4 sweep: `provider error: error code: 520` was classified
 * `missing_native_compaction`, so the row went invalid and dropped out of the behavioural
 * denominator. 520-527 are Cloudflare origin errors that OpenRouter proxies -- infrastructure, not
 * compaction behaviour, and exactly what the comment above `isTransientProviderError` says must
 * never be recorded as the latter.
 *
 * The decision turn already got this right: `interpretChatResponse` treats `status >= 500` as
 * transient. Only the two compaction classifiers enumerated a subset.
 */
import { describe, expect, it } from "vitest";
import { isTransientProviderError } from "../src/compaction/pi-native.ts";
import { classifySummarizerFailure } from "../src/compaction/strategies-summary.ts";

describe("isTransientProviderError", () => {
  it("covers the 5xx codes it always did", () => {
    for (const code of [500, 502, 503, 504]) {
      expect(isTransientProviderError(`provider error: error code: ${code}`)).toBe(true);
    }
  });

  it("covers the Cloudflare 52x family seen live", () => {
    for (const code of [520, 521, 522, 523, 524, 525, 526, 527]) {
      expect(isTransientProviderError(`provider error: error code: ${code}`)).toBe(true);
    }
  });

  it("still covers 429 and the socket errors", () => {
    expect(isTransientProviderError("HTTP 429 too many requests")).toBe(true);
    expect(isTransientProviderError("socket hang up")).toBe(true);
  });

  it("does not swallow a 4xx that is genuinely the request's fault", () => {
    // 400 is the orphaned-tool-result defect and must stay a hard failure -- retrying it would hide
    // a construction bug behind four identical rejections.
    expect(isTransientProviderError("HTTP 400 invalid tool_call_id")).toBe(false);
    expect(isTransientProviderError("HTTP 403 content policy")).toBe(false);
  });
});

describe("classifySummarizerFailure", () => {
  it("routes any 5xx to rate-limited rather than to a compaction failure", () => {
    for (const code of [500, 503, 520, 524]) {
      expect(classifySummarizerFailure(`provider error: error code: ${code}`).reason).toBe(
        "summarizer_rate_limited",
      );
    }
  });

  it("keeps a refusal distinct from a transient", () => {
    expect(classifySummarizerFailure("HTTP 403: content policy").reason).toBe(
      "summarizer_refused",
    );
  });

  it("leaves anything unrecognised as a genuine compaction failure", () => {
    expect(classifySummarizerFailure("malformed response").reason).toBe(
      "missing_native_compaction",
    );
  });
});
