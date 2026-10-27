import { parseLabel } from "./rubric.ts";
import type { JudgeCall } from "./schema.ts";

export interface JudgeClientOptions {
  apiKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
  maxTransientRetries: number;
  retryBaseDelayMs: number;
  /** Re-asks when the model replies with something that is not one of the three labels. */
  maxParseRetries: number;
}

export interface JudgeArgs {
  slug: string;
  system: string;
  user: string;
  opts: JudgeClientOptions;
  /**
   * Output cap. 16 is right for the metric, whose reply is one word, and it also bounds the
   * damage if a provider ignores `reasoning: {enabled: false}`. The audit slice asks for a JSON
   * object carrying a verbatim span, which cannot fit in 16 tokens, so it raises this.
   */
  maxTokens?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

function readUsage(body: Record<string, unknown>): Usage {
  const u = (body["usage"] ?? {}) as Record<string, unknown>;
  const details = (u["completion_tokens_details"] ?? {}) as Record<string, unknown>;
  return {
    promptTokens: Number(u["prompt_tokens"] ?? 0),
    completionTokens: Number(u["completion_tokens"] ?? 0),
    reasoningTokens: Number(details["reasoning_tokens"] ?? 0),
    costUsd: Number(u["cost"] ?? 0),
  };
}

/**
 * One request, with every assertion applied but no label parsing.
 *
 * Split out so the audit slice (which asks for JSON, not a bare label) reuses the transport and
 * the three assertions without weakening `parseLabel`. The strict parser is load-bearing for the
 * metric and must never learn to read JSON.
 */
async function requestOnce(
  args: JudgeArgs,
): Promise<{ content: string | null; failure: string | null; usage: Usage }> {
  const { slug, system, user, opts } = args;
  const body = JSON.stringify({
    model: slug,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    max_tokens: args.maxTokens ?? 16,
    reasoning: { enabled: false },
  });

  let usage: Usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
  let failure = "no attempt was made";
  let parsed: Record<string, unknown> | null = null;
  let delay = opts.retryBaseDelayMs;

  for (let attempt = 0; ; attempt++) {
    let status: number;
    let text: string;
    try {
      const resp = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(opts.requestTimeoutMs),
      });
      status = resp.status;
      text = await resp.text();
    } catch (e) {
      failure = `request failed: ${String(e)}`;
      if (attempt < opts.maxTransientRetries) {
        await sleep(delay);
        delay = delay === 0 ? 0 : delay * 2;
        continue;
      }
      return { content: null, failure, usage };
    }

    if (isRetryableStatus(status) && attempt < opts.maxTransientRetries) {
      failure = `HTTP ${status}`;
      await sleep(delay);
      delay = delay === 0 ? 0 : delay * 2;
      continue;
    }
    if (status >= 400) {
      return { content: null, failure: `HTTP ${status}: ${text.slice(0, 200)}`, usage };
    }
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { content: null, failure: `non-JSON response: ${text.slice(0, 200)}`, usage };
    }
    break;
  }

  if (parsed === null) return { content: null, failure, usage };
  usage = readUsage(parsed);

  if (parsed["model"] !== slug) {
    return {
      content: null,
      failure: `model mismatch: asked ${slug}, got ${String(parsed["model"])}`,
      usage,
    };
  }
  if (usage.reasoningTokens !== 0) {
    return {
      content: null,
      failure: `provider billed ${usage.reasoningTokens} reasoning tokens with reasoning disabled`,
      usage,
    };
  }

  const choices = parsed["choices"] as Array<{ message?: { content?: string } }> | undefined;
  return { content: choices?.[0]?.message?.content ?? "", failure: null, usage };
}

/**
 * One judged call, returning a parsed label.
 *
 * Three rules this function exists to enforce, all of which turn a silent wrong number into a
 * loud failure:
 *
 *  1. A call that did not happen is a FAILURE, never a label. This is the rule the decision-turn
 *     evaluator holds (`src/rule-loss/evaluator.ts`), and the reason the metric it replaces was
 *     wrong.
 *  2. `reasoning_tokens` must be zero. Requesting `reasoning: {enabled: false}` is not enough --
 *     some providers reject the parameter and think anyway, and reasoning tokens are billed while
 *     going unrecorded, which is how the v1.5 cost floor came in 3.2x low.
 *  3. The responding `model` must be the slug we asked for. Retention is only reproducible if the
 *     judge that produced it is known, and floating aliases resolve differently over time.
 */
export async function judgeOnce(args: JudgeArgs): Promise<JudgeCall> {
  const started = Date.now();
  let usage: Usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
  let failure = "no attempt was made";

  const attempts = Math.max(1, args.opts.maxParseRetries + 1);
  for (let i = 0; i < attempts; i++) {
    const out = await requestOnce(args);
    usage = out.usage;
    if (out.content === null) {
      failure = out.failure ?? "unknown failure";
      break; // Transport failures are already retried inside requestOnce.
    }
    const label = parseLabel(out.content);
    if (label !== null) {
      return { slug: args.slug, label, failure: null, ...usage, latencyMs: Date.now() - started };
    }
    failure = `unparseable label: ${JSON.stringify(out.content).slice(0, 120)}`;
  }
  return { slug: args.slug, label: null, failure, ...usage, latencyMs: Date.now() - started };
}

/** The same call and the same assertions, returning the message text unparsed. */
export async function judgeRawOnce(args: JudgeArgs): Promise<JudgeCall & { content: string }> {
  const started = Date.now();
  const out = await requestOnce(args);
  return {
    slug: args.slug,
    label: null,
    failure: out.failure,
    content: out.content ?? "",
    ...out.usage,
    latencyMs: Date.now() - started,
  };
}
