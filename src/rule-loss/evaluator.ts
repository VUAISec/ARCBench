/**
 * Downstream evaluation of the graded decision turn.
 *
 * Two defects compounded here into the harness's worst failure mode:
 *
 *   1. `CanonicalMessage` had no field for an assistant's tool calls, so converting the
 *      dataset produced an assistant message with no `tool_calls` declared, immediately
 *      followed by a `role: "tool"` message referencing a call that was never declared.
 *      OpenAI-compatible endpoints reject that with HTTP 400.
 *
 *   2. The response reader went straight to `body.choices` without checking for an error or
 *      a non-2xx status, so any failure yielded `toolCalls = []`, graded `no_action`, and was
 *      counted as a normal zero-violation observation.
 *
 * Together they guaranteed every tool-using request failed and every failure was recorded as
 * compliance. A 0% violation rate produced that way is indistinguishable in `results.jsonl`
 * from an agent that ran and chose not to violate anything.
 *
 * **Transport.** This calls `/chat/completions` directly rather than the batch API. The
 * originally specified batch endpoint requires a provider-published `:batch` model variant, and
 * the frozen model (`z-ai/glm-5.3-flash`) has none — a live calibration surfaced this as
 * `Model '...' does not have a :batch endpoint`. Batch bought a discount and async throughput;
 * at this matrix size neither is material, and per-request status codes make the failure handling
 * more direct than reconciling batch items against submitted runs.
 */
import type { CanonicalMessage } from "../harness/schema.ts";

export interface EvalRun {
  runId: string;
  systemPrompt: string;
  messages: CanonicalMessage[];
  trigger: string;
  tools: unknown[];
  /** The tool whose use is graded. Reaching it ends the loop: the effect has been observed. */
  gradedTool: string;
  /** Deterministic canned result for a non-graded tool call (src/harness/toolstub.ts). */
  stubToolResult: (name: string, args: Record<string, unknown>) => string;
  /** This run's model. Set per run so a panel sweep can put a different model on each row. */
  model: string;
  /**
   * Per-turn sink. Without it the trajectory is flattened to a tool-call list and the
   * FINAL assistant text -- intermediate turns, the stub results the harness fed back, and step
   * ordering were all lost, and `rawResponse` was captured then dropped at normalization. Typed
   * loosely so the evaluator does not depend on the writer's module.
   */
  trajectory?: { record(event: unknown): void } | null;
}

export interface EvalSuccess {
  ok: true;
  /** This trajectory's own latency, summed over its turns. Excludes queue wait. */
  latencyMs: number;
  /** Every tool call across the whole trajectory, in order. */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  terminalText: string;
  rawResponse: unknown;
  /** Model turns taken before a terminal state. 1 means it answered the trigger directly. */
  toolSteps: number;
  /** True if the step cap was reached while the model was still calling tools. */
  hitStepCap: boolean;
}

/** A protocol failure is a distinct outcome, never an empty tool-call list. */
export interface EvalFailure {
  ok: false;
  reason: string;
  rawResponse: unknown;
  latencyMs?: number;
}

export type EvalResult = EvalSuccess | EvalFailure;

export class ProtocolError extends Error {}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export function canonicalToOpenAI(
  systemPrompt: string,
  messages: CanonicalMessage[],
  trigger: string,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });

  // Track what the preceding assistant turn actually declared, so an orphaned tool result
  // is caught here rather than as an HTTP 400 during a paid run.
  let declared = new Set<string>();

  for (const m of messages) {
    if (m.role === "system") {
      // The persona is already the system message; a second one would change the request shape
      // between conditions.
      throw new ProtocolError(`message ${m.entryId} has role "system"; the persona is passed separately`);
    }

    if (m.role === "assistant") {
      declared = new Set((m.toolCalls ?? []).map((c) => c.id));
      const msg: OpenAIMessage = { role: "assistant", content: m.content || null };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }));
      }
      out.push(msg);
      continue;
    }

    if (m.role === "tool") {
      // No shared `"tc"` default. A literal fallback collides the moment a conversation has
      // more than one tool-result turn, which every one of these tasks does.
      const id = m.toolCallId;
      if (!id) throw new ProtocolError(`tool result ${m.entryId} has no tool_call_id`);
      if (!declared.has(id)) {
        throw new ProtocolError(
          `tool result ${m.entryId} references tool_call_id ${JSON.stringify(id)}, which the preceding ` +
            `assistant message never declared`,
        );
      }
      out.push({ role: "tool", content: m.content, tool_call_id: id, name: m.toolName });
      continue;
    }

    out.push({ role: "user", content: m.content });
  }

  out.push({ role: "user", content: trigger });
  return out;
}

// ---------------------------------------------------------------------------
// Response interpretation
// ---------------------------------------------------------------------------

interface ChatBody {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    /** v1.4: `"length"` means the `max_tokens` cap fired. See `ChatTurn.finishReason`. */
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}

/**
 * Every failure mode is checked before `choices` is read, and each produces an explicit
 * failure rather than an empty tool-call list.
 */
export interface RawToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatTurn {
  ok: true;
  toolCalls: RawToolCall[];
  text: string;
  raw: unknown;
  /** Decision-turn usage was once never captured. Now it is, per turn. */
  usage: unknown;
  /**
   * v1.4: the provider's `finish_reason`, or null when it reported none.
   *
   * `"length"` is the only value this harness acts on: it means the `max_tokens` cap fired. Without
   * it, a summary that came in under budget because the model complied is indistinguishable from
   * one that was cut off -- and under v1.4's single enforcement mode (prompt AND mechanism) that
   * is the one distinction nothing else can recover.
   *
   * Null, never a default `"stop"`: a transport that reports nothing has not told us the model
   * finished, and recording that it did would be a measurement we never made.
   */
  finishReason: string | null;
}

/** One model turn, or an explicit failure. Never an empty tool-call list standing in for one. */
export function interpretChatResponse(status: number, body: unknown): ChatTurn | EvalFailure {
  if (typeof status !== "number" || status < 200 || status >= 300) {
    const detail = (body as ChatBody | undefined)?.error?.message;
    return { ok: false, reason: `HTTP ${String(status)}${detail ? `: ${detail}` : ""}`, rawResponse: body };
  }

  const parsed = body as ChatBody | undefined;
  if (!parsed) return { ok: false, reason: "2xx response had no body", rawResponse: body };

  if (parsed.error) {
    return { ok: false, reason: `provider error: ${parsed.error.message ?? "unknown"}`, rawResponse: body };
  }

  const choices = parsed.choices;
  if (!choices || choices.length === 0) {
    // A 2xx with no choices is a malformed response, not an agent that chose to do nothing.
    return { ok: false, reason: "2xx response contained no choices", rawResponse: body };
  }

  const message = choices[0]?.message;
  const toolCalls = (message?.tool_calls ?? [])
    .map((tc, i) => {
      const name = tc.function?.name ?? "";
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        // Unparseable arguments are the grader's problem, not a protocol failure: the model
        // did emit a call, it just emitted bad JSON for it.
      }
      return { id: tc.id ?? `call_${i}`, name, args };
    })
    .filter((tc) => tc.name.length > 0);

  return {
    ok: true,
    toolCalls,
    text: message?.content ?? "",
    raw: body,
    finishReason: choices[0]?.finish_reason ?? null,
    usage: (body as { usage?: unknown } | undefined)?.usage ?? null,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429 and 5xx are worth retrying; any other 4xx is a deterministic fault in our request. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface EvalOptions {
  apiKey: string;
  baseUrl: string;
  temperature: number;
  requestConcurrency: number;
  requestTimeoutMs: number;
  maxTransientRetries: number;
  retryBaseDelayMs: number;
  /** Model turns allowed before the trajectory is cut off. */
  maxToolSteps: number;
  /** Pause between requests. Non-zero for rate-limited `:free` slugs. */
  requestDelayMs: number;
  /**
   * v1.4: a hard cap on generated tokens, sent as `max_tokens`.
   *
   * Omitted leaves the body byte-identical to what every earlier sweep sent, which is what keeps
   * an unconstrained v1.4 row comparable with a v1.2 one rather than merely similar to it.
   */
  maxTokens?: number;
}

/** One request/response round trip, with transient-failure retry. */
/**
 * One model turn against `/chat/completions`, for the `c2`/`c4` policy-placing call.
 *
 * Exported separately from the decision loop because it is a different thing: a single turn, only
 * the channel's own tool offered, and its result is spliced into the transcript rather than
 * graded. Sharing `chatOnce`'s retry and status handling matters more than sharing the loop --
 * the lesson of the unchecked-response defect was that a failure must never come back as an empty
 * tool-call list.
 */
export async function chatOnceForChannel(args: {
  systemPrompt: string;
  userContent: string;
  tools: unknown[];
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  requestTimeoutMs: number;
  maxTransientRetries: number;
  retryBaseDelayMs: number;
  /** v1.4: hard cap on generated tokens. Omitted sends no `max_tokens` key. */
  maxTokens?: number;
}): Promise<ChatTurn | EvalFailure> {
  const messages: OpenAIMessage[] = [
    ...(args.systemPrompt ? [{ role: "system", content: args.systemPrompt }] : []),
    { role: "user", content: args.userContent },
  ];
  return chatOnce(messages, args.tools, args.model, {
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    temperature: args.temperature,
    requestConcurrency: 1,
    requestDelayMs: 0,
    requestTimeoutMs: args.requestTimeoutMs,
    maxTransientRetries: args.maxTransientRetries,
    retryBaseDelayMs: args.retryBaseDelayMs,
    maxToolSteps: 1,
    ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
  });
}

async function chatOnce(
  messages: OpenAIMessage[],
  tools: unknown[],
  model: string,
  opts: EvalOptions,
): Promise<ChatTurn | EvalFailure> {
  const body = JSON.stringify({
    model,
    messages,
    tools,
    // Read from config instead of a hardcoded literal that silently drifts from it.
    temperature: opts.temperature,
    tool_choice: "auto",
    // Spread rather than `max_tokens: opts.maxTokens`: an explicit `undefined` would serialize
    // away here but the intent matters -- an unbudgeted request must send no such key at all.
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
  });

  let delay = opts.retryBaseDelayMs;

  for (let attempt = 0; ; attempt++) {
    let status: number;
    let parsed: unknown;

    try {
      const resp = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(opts.requestTimeoutMs),
      });
      status = resp.status;
      const text = await resp.text();
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = { error: { message: `non-JSON response: ${text.slice(0, 300)}` } };
      }
    } catch (e) {
      // Network error or timeout. Retryable up to the configured bound, then an explicit
      // failure — never a silent empty result.
      if (attempt < opts.maxTransientRetries) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      return { ok: false, reason: `request failed after ${attempt + 1} attempt(s): ${String(e)}`, rawResponse: null };
    }

    if (isRetryableStatus(status) && attempt < opts.maxTransientRetries) {
      await sleep(delay);
      delay *= 2;
      continue;
    }

    return interpretChatResponse(status, parsed);
  }
}

/**
 * Run one decision trajectory to a terminal state.
 *
 * The loop exists because a single turn was not enough: every task ships two or three
 * non-graded lookup tools, and a model that verifies before acting spends its only turn on
 * one, never reaching the graded action. That produced a false `not_violation` for G0 in the
 * 2026-08-26 calibration.
 *
 * Terminal states, in priority order:
 *   - the graded tool is called       → the prohibited-or-permitted effect has been observed
 *   - the model returns no tool calls → it has answered
 *   - the step cap is reached         → recorded as `hitStepCap`, visible in the results
 *
 * Tool calls are never executed. Non-graded calls receive a deterministic canned result that
 * is identical across conditions, so the loop cannot become an uncontrolled variable on the
 * compaction axis.
 */
export async function evaluateRun(run: EvalRun, opts: EvalOptions): Promise<EvalResult> {
  const messages = canonicalToOpenAI(run.systemPrompt, run.messages, run.trigger);
  const allCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let lastText = "";
  let latencyMs = 0;
  const traj = run.trajectory ?? null;

  const steps = Math.max(1, opts.maxToolSteps);
  for (let step = 1; step <= steps; step++) {
    if (opts.requestDelayMs > 0) await sleep(opts.requestDelayMs);
    const startedAt = Date.now();
    const turn = await chatOnce(messages, run.tools, run.model, opts);
    latencyMs += Date.now() - startedAt;
    if (!turn.ok) {
      // A failed turn is still a step that happened. Recording it is what lets a protocol
      // failure be distinguished from an agent that chose to do nothing.
      traj?.record({
        type: "decision_step",
        step,
        assistantText: "",
        toolCalls: [],
        stubResults: [],
        latencyMs: Date.now() - startedAt,
        rawResponse: turn.rawResponse,
      });
      return { ...turn, latencyMs };
    }

    lastText = turn.text || lastText;
    for (const c of turn.toolCalls) allCalls.push({ name: c.name, args: c.args });

    // Stub results are computed here rather than below so the recorded step carries exactly what
    // was fed back, including on the terminal turn where nothing is fed back at all.
    const isTerminal =
      turn.toolCalls.length === 0 ||
      turn.toolCalls.some((c) => c.name === run.gradedTool) ||
      step === steps;
    const stubResults = isTerminal
      ? []
      : turn.toolCalls.map((c) => ({
          toolCallId: c.id,
          name: c.name,
          content: run.stubToolResult(c.name, c.args),
        }));
    traj?.record({
      type: "decision_step",
      step,
      assistantText: turn.text,
      toolCalls: turn.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      stubResults,
      latencyMs: Date.now() - startedAt,
      rawResponse: turn.raw,
    });

    if (turn.toolCalls.length === 0) {
      return { ok: true, toolCalls: allCalls, terminalText: lastText, rawResponse: turn.raw, toolSteps: step, hitStepCap: false, latencyMs };
    }
    if (turn.toolCalls.some((c) => c.name === run.gradedTool)) {
      return { ok: true, toolCalls: allCalls, terminalText: lastText, rawResponse: turn.raw, toolSteps: step, hitStepCap: false, latencyMs };
    }
    if (step === steps) {
      return { ok: true, toolCalls: allCalls, terminalText: lastText, rawResponse: turn.raw, toolSteps: step, hitStepCap: true, latencyMs };
    }

    messages.push({
      role: "assistant",
      content: turn.text || null,
      tool_calls: turn.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    });
    for (const stub of stubResults) {
      messages.push({
        role: "tool",
        content: stub.content,
        tool_call_id: stub.toolCallId,
        name: stub.name,
      });
    }
  }

  /* c8 ignore next */
  return { ok: true, toolCalls: allCalls, terminalText: lastText, rawResponse: null, toolSteps: steps, hitStepCap: true, latencyMs };
}

/** Run the decision trajectories with bounded concurrency, one result per run, always. */
export async function evaluateGovernance(
  runs: EvalRun[],
  opts: EvalOptions,
): Promise<Map<string, EvalResult>> {
  const results = new Map<string, EvalResult>();
  if (runs.length === 0) return results;

  const concurrency = Math.max(1, Math.min(opts.requestConcurrency, runs.length));
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      const run = runs[index];
      if (!run) return;
      try {
        results.set(run.runId, await evaluateRun(run, opts));
      } catch (e) {
        // A conversion fault or anything else unexpected is still a protocol failure for
        // this run, not an exception that abandons the rest of the matrix.
        results.set(run.runId, { ok: false, reason: String(e), rawResponse: null });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  // A run that produced nothing at all must surface as a protocol failure rather than
  // silently disappearing from the results file.
  for (const run of runs) {
    if (!results.has(run.runId)) {
      results.set(run.runId, { ok: false, reason: "no result produced for this run", rawResponse: null });
    }
  }

  return results;
}
