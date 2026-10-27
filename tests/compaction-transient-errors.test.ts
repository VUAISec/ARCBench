import { describe, it, expect } from "vitest";
import { isProviderRefusal, isTransientProviderError } from "../src/compaction/pi-native.ts";

/**
 * Classifier cases, pinned from real provider output.
 *
 * This function has now been wrong twice in the same direction, and both times the consequence
 * was the same: a transient condition filed as a permanent compaction failure, the row marked
 * invalid, and the loss removed from the behavioural denominator with no distinguishing label.
 * Neither was visible in an aggregate — the rows simply were not there.
 *
 * So the cases below are verbatim strings observed in the v1.1 sweep and the 945-run panel, not
 * invented examples.
 */
describe("transient vs permanent summarizer failures", () => {
  it("real transient messages observed in the sweep", () => {
    const transient = [
      // qwen/qwen3.7-flash, v1.1 sweep — 30 of these in one minute at concurrency 4.
      'Summarization failed: 429: {"message":"Provider returned error","code":429}',
      // inclusionai/ling-3.0-flash, v1.1 sweep — an AbortSignal.timeout. The FIRST version of
      // this classifier matched "timeout" but not "aborted", so this one slipped through.
      "Summarization failed: The operation was aborted",
      "Summarization failed: 503 Service Unavailable",
      "Summarization failed: 502 Bad Gateway",
      "request failed: fetch failed",
      "AbortError: This operation was aborted",
      "Error: socket hang up",
      "read ECONNRESET",
      "connect ETIMEDOUT",
      "rate limit exceeded",
      "Too Many Requests",
    ];
    for (const m of transient) {
      expect(isTransientProviderError(m), `must be transient: ${m}`).toBe(true);
      // A transient error must never also read as a refusal, or it would skip retries entirely.
      expect(isProviderRefusal(m), `must not be a refusal: ${m}`).toBe(false);
    }
  });

  it("a content refusal is permanent and must not consume retries", () => {
    const refusals = [
      // Observed in the 945-run panel: the provider declined the content itself.
      'Summarization failed: 403: {"message":"violation of provider Terms Of Service"}',
      "blocked by content policy",
      "prohibited due to safety",
      "flagged by moderation",
    ];
    for (const m of refusals) {
      expect(isProviderRefusal(m), `must be a refusal: ${m}`).toBe(true);
    }
  });

  it("a genuine compaction fault is neither — it must keep its own label", () => {
    // These are the messages that SHOULD end up as `missing_native_compaction`. If the transient
    // regex widened far enough to swallow them, a real defect would be retried and then
    // mislabelled as a rate limit, which is the mirror-image error.
    const permanent = [
      "Nothing to compact",
      "First kept entry has no UUID - session may need migration",
      "pi returned an empty summary",
      "pi reported firstKeptEntryId abc123, which is not one of the seeded entries",
    ];
    for (const m of permanent) {
      expect(isTransientProviderError(m), `must not be transient: ${m}`).toBe(false);
      expect(isProviderRefusal(m), `must not be a refusal: ${m}`).toBe(false);
    }
  });

  it("erring wide is the safe direction, and the asymmetry is why", () => {
    // Misfiling transient-as-permanent silently shrinks the sample. Misfiling
    // permanent-as-transient costs a few retries and then fails with an accurate label. The
    // second is recoverable; the first is invisible.
    expect(isTransientProviderError("429")).toBe(true);
    expect(isTransientProviderError("Nothing to compact")).toBe(false);
  });
});
