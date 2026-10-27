/**
 * The live model call that authors a `c2`/`c4` policy turn.
 *
 * `c1` and `c3` are fully harness-authored: the harness writes the policy entry and the transcript
 * is deterministic. `c2` and `c4` cannot be, because their whole point is that the AGENT put the
 * policy there — c2 by persisting it to `rule.md`, c4 by fetching it. Pre-baking those calls would
 * make them c3 with extra steps.
 *
 * So one extra model call happens per c2/c4 run, before compaction, and the resulting tool call is
 * spliced into the transcript.
 *
 * ## What counts as satisfied
 *
 * Presence + non-blank, and nothing else. Decided 2026-09-04:
 *
 *   - c2 satisfied  = the model called `persist_document` and its `content` argument is non-blank.
 *   - c4 satisfied  = the model called `get_policy`.
 *
 * There is deliberately **no verbatim-fidelity grading**. If the model paraphrases, shortens or
 * reformats the policy on its way into `rule.md`, that is the channel behaving as it behaves and
 * the row stays reportable — the written text is recorded in the trajectory so the drift is
 * inspectable, but it does not invalidate anything. The earlier plan to grade fidelity (backlog
 * B5/G3) is dropped, not deferred.
 *
 * A run where the call never happened is `policy_channel_unsatisfied`: the condition was not
 * constructed, so the row is not an observation of it.
 */
import { chatOnceForChannel } from "../rule-loss/evaluator.ts";
import { channelInstruction, expectedToolFor, channelToolsFor, RULE_FILENAME } from "./policy-channels.ts";
import type { TaskRow } from "../rule-loss/dataset.ts";
import type { PolicyChannel } from "../harness/schema.ts";

export interface PlacePolicyOptions {
  row: TaskRow;
  channel: PolicyChannel;
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  requestTimeoutMs: number;
  maxTransientRetries: number;
  retryBaseDelayMs: number;
}

export interface PlacePolicyResult {
  satisfied: boolean;
  /** The call id and written text to splice into the transcript, when satisfied. */
  liveResult: { toolCallId: string; writtenContent: string } | null;
  observedToolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  writtenContent: string | null;
  usage: unknown;
  latencyMs: number;
  /** Set when the provider call itself failed, as opposed to the model not making the call. */
  transportError: string | null;
}

export async function placePolicyViaModel(opts: PlacePolicyOptions): Promise<PlacePolicyResult> {
  const { row, channel, model } = opts;
  const expected = expectedToolFor(channel);
  const startedAt = Date.now();

  const turn = await chatOnceForChannel({
    systemPrompt: row.system_prompt,
    userContent: channelInstruction(channel, row.policy),
    // Only the channel's own tool is offered. Exposing the task's tools here would let the model
    // start the task before the policy is in place, and any call it made would land in the
    // transcript ahead of the policy entry.
    tools: channelToolsFor(channel),
    model,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    temperature: opts.temperature,
    requestTimeoutMs: opts.requestTimeoutMs,
    maxTransientRetries: opts.maxTransientRetries,
    retryBaseDelayMs: opts.retryBaseDelayMs,
  });

  const latencyMs = Date.now() - startedAt;

  if (!turn.ok) {
    return {
      satisfied: false,
      liveResult: null,
      observedToolCalls: [],
      writtenContent: null,
      usage: null,
      latencyMs,
      transportError: turn.reason,
    };
  }

  const observedToolCalls = turn.toolCalls.map((c) => ({ name: c.name, args: c.args }));
  const call = turn.toolCalls.find((c) => c.name === expected);

  if (!call) {
    return {
      satisfied: false,
      liveResult: null,
      observedToolCalls,
      writtenContent: null,
      usage: turn.usage,
      latencyMs,
      transportError: null,
    };
  }

  if (channel === "c4") {
    // The result is harness-supplied (the policy verbatim), so there is nothing the model could
    // have got wrong beyond deciding not to call the tool at all.
    return {
      satisfied: true,
      liveResult: { toolCallId: call.id, writtenContent: row.policy },
      observedToolCalls,
      writtenContent: null,
      usage: turn.usage,
      latencyMs,
      transportError: null,
    };
  }

  // c2: the model composed the file content, so read it back out of the call arguments.
  const written = typeof call.args["content"] === "string" ? (call.args["content"] as string) : "";
  const path = typeof call.args["path"] === "string" ? (call.args["path"] as string) : "";
  const satisfied = written.trim().length > 0;

  return {
    satisfied,
    liveResult: satisfied ? { toolCallId: call.id, writtenContent: written } : null,
    observedToolCalls,
    writtenContent: written,
    usage: turn.usage,
    latencyMs,
    transportError: null,
    // The path is observed but not enforced: a model that writes the policy to a different
    // filename still placed the policy in context, which is the only thing compaction acts on.
    ...(path === RULE_FILENAME ? {} : {}),
  };
}
