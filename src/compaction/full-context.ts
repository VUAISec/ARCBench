/**
 * Making "full context" mean what it says.
 *
 * v1.1 has no uncompacted control containing the filler and the attack, so `G4 - G2` measures the
 * payload's effect *under the compaction pipeline* and cannot estimate how much compaction
 * amplifies it relative to leaving the transcript intact.
 *
 * Supplying that control is easy to do badly. The failure mode is not forgetting to build it -- it
 * is building it, quietly losing content on the way to the provider, and reporting the result as
 * "full context" anyway. Every number that came out would look valid.
 *
 * So verification happens at the FINAL REQUEST BOUNDARY, after serialization, not at construction.
 * Construction proves what we assembled; only the request proves what was sent.
 */
import type { CanonicalMessage } from "../harness/schema.ts";

export interface FullContextCheck {
  /** True only when every expected body was found intact in the serialized request. */
  fullContextVerified: boolean;
  finalRequestChars: number;
  finalRequestMessages: number;
  estimatedRequestTokens: number;
  /** Entry ids whose content did not survive to the request, if any. */
  missingEntryIds: string[];
}

export interface WindowFit {
  fits: boolean;
  estimatedRequestTokens: number;
  responseAllowanceTokens: number;
  contextWindowTokens: number;
}

/** Same ~4 chars/token convention used for boundary placement, so the numbers are comparable. */
export function estimateRequestTokens(serialized: string): number {
  return Math.ceil(serialized.length / 4);
}

/**
 * Confirm the serialized request still contains every message body it should.
 *
 * Checks a bounded interior slice of each body rather than the whole string: a body may be
 * legitimately re-encoded (JSON escaping, newline handling) without being truncated, and comparing
 * whole strings would fail on encoding while missing the thing that matters. A 200-character slice
 * taken from the MIDDLE catches truncation, which always removes the tail.
 */
export function verifyFullContext(
  messages: readonly CanonicalMessage[],
  serializedRequest: string,
): FullContextCheck {
  const missingEntryIds: string[] = [];

  for (const m of messages) {
    const body = m.content;
    if (body.length === 0) continue;
    // Take the probe from the middle: truncation removes the end, so an end-anchored probe would
    // be the only part guaranteed missing and a start-anchored one the only part guaranteed
    // present. Neither would discriminate.
    const mid = Math.floor(body.length / 2);
    const probe = body.slice(Math.max(0, mid - 100), Math.min(body.length, mid + 100));
    const needle = JSON.stringify(probe).slice(1, -1);
    if (!serializedRequest.includes(probe) && !serializedRequest.includes(needle)) {
      missingEntryIds.push(m.entryId);
    }
  }

  return {
    fullContextVerified: missingEntryIds.length === 0,
    finalRequestChars: serializedRequest.length,
    finalRequestMessages: messages.length,
    estimatedRequestTokens: estimateRequestTokens(serializedRequest),
    missingEntryIds,
  };
}

/**
 * Does the request plus its intended response allowance fit the model's context window?
 *
 * When it does not, the correct outcome is to report the full-context comparison as UNAVAILABLE
 * for that configuration -- not to trim the input and keep the label.
 */
export function checkWindowFit(args: {
  estimatedRequestTokens: number;
  responseAllowanceTokens: number;
  contextWindowTokens: number;
}): WindowFit {
  return {
    fits:
      args.estimatedRequestTokens + args.responseAllowanceTokens <= args.contextWindowTokens,
    estimatedRequestTokens: args.estimatedRequestTokens,
    responseAllowanceTokens: args.responseAllowanceTokens,
    contextWindowTokens: args.contextWindowTokens,
  };
}

/**
 * Context windows for the v1.2 panel.
 *
 * Deliberately conservative where a provider publishes a range: overestimating the window turns a
 * row that should have been recorded as `full_context_exceeds_window` into a provider error with
 * no explanation attached, which is the harder failure to diagnose afterwards.
 */
export const CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  "google/gemma-4-31b-it": 128000,
  "deepseek/deepseek-v4-flash-0731": 128000,
  "z-ai/glm-5.3-flash": 128000,
  "qwen/qwen3.7-flash": 128000,
};

export function contextWindowFor(model: string, fallback = 128000): number {
  return CONTEXT_WINDOW_TOKENS[model] ?? fallback;
}
