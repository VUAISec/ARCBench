/**
 * Per-run trajectory recording.
 *
 * The v1 design already required this — *"Each run writes a JSONL trajectory and a normalized
 * record"* — and it was never built. What `raw/` held instead was per-message `role`, `side` and
 * `chars`: a character COUNT, not the text. That made several questions unanswerable after the
 * fact:
 *
 *   - What did the summarizer actually read? (pi truncates each tool result to 2,000 chars
 *     inside `serializeConversation`, and the only trace is a marker in a prompt nobody stored.
 *     An entry-level record cannot show it.)
 *   - What did the agent see when it decided? (`[summary + tail]` was built in memory, used, and
 *     dropped.)
 *   - How did it get there? (Only a flat tool-call list and the final assistant text survived.)
 *   - G0/G1 produced no artifact at all — the directory was created by the compaction adapter,
 *     so 378 uncompacted runs had zero raw record.
 *
 * ## Cost
 *
 * Zero additional model calls. Every field is already in memory or derivable from a pure
 * function, and the haystack is stored by reference rather than inlined, so a run costs
 * ~10 KB and about a millisecond against 2-5 model calls taking seconds.
 *
 * ## Two honest limits, both recorded in the payload rather than papered over
 *
 * 1. `prepareCompaction` internally uses `getMessageFromEntryForCompaction`, which pi does not
 *    export. The reconstruction below is faithful but not proven byte-identical, so every
 *    `summarizer_input` carries `reconstructed: true`.
 * 2. `SUMMARIZATION_PROMPT` is not exported either. Copying the constant into the harness would
 *    drift silently on a pi upgrade, so the event records `promptTemplateRef: piRevision`
 *    instead of the prompt text.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompactionStrategy, HaystackDelivery } from "../config/config.ts";
import type {
  CanonicalMessage,
  GovernanceCondition,
  GradeResult,
  HaystackArmId,
  InvalidReason,
  PolicyChannel,
  RelinkCondition,
} from "./schema.ts";

export const TRAJECTORY_FILENAME = "trajectory.jsonl";

/**
 * A stored reference to haystack bytes instead of the bytes themselves.
 *
 * The corpus is ~96,339 chars and fully deterministic from `(seed, taskId, repetition)`, and its
 * SHA-256 is already recorded. Inlining it would make the trajectory set ~550 MB against ~57 MB
 * by reference. `sliceStart`/`sliceEnd` locate this entry's chunk within the corpus, so a
 * 50-chunk A3 trajectory is 50 small refs rather than 50 copies.
 *
 * `scripts/rehydrate-trajectory.ts` expands these and VERIFIES the SHA-256, so a drift in
 * `src/context/haystack.ts` is caught rather than silently producing different text.
 */
export interface HaystackRef {
  kind: "haystack";
  corpusId: string;
  corpusSha256: string;
  corpusChars: number;
  seed: number;
  taskId: string;
  repetition: number;
  /** Byte range of this entry's chunk within the corpus. */
  sliceStart: number;
  sliceEnd: number;
  /** Chars of `HAYSTACK_HEADER` prepended to the slice, so rehydration reproduces the entry. */
  headerChars: number;
  /** Length of the stored-away content, for a cheap round-trip check. */
  chars: number;
}

export interface RunMetaEvent {
  type: "run_meta";
  runId: string;
  condition: GovernanceCondition | RelinkCondition;
  policyChannel: PolicyChannel | null;
  haystackArm: HaystackArmId | null;
  taskId: string;
  repetition: number;
  model: string;
  startedAt: string;
  config: {
    keepRecentTokens: number;
    reserveTokens: number;
    compactionStrategy: CompactionStrategy | null;
    haystackDelivery: HaystackDelivery | null;
    haystackChunkChars: number | null;
    haystackCharsReachingSummarizer: number | null;
    haystackInsertionTurn: number;
    /** pi's per-tool-result cap. Outside the harness's control; see config.PI_TOOL_RESULT_MAX_CHARS. */
    toolResultMaxChars: number;
    piRevision: string;
    seed: number;
    temperature: number;
  };
}

/**
 * The `c2`/`c4` live model call that places the policy, recorded because it is the only part of
 * the transcript the harness did not author.
 *
 * `satisfied` is presence + non-blank ONLY. There is deliberately no verbatim-fidelity check: a
 * paraphrased policy is the channel behaving as it behaves, and the row stays reportable.
 */
export interface PolicyChannelStepEvent {
  type: "policy_channel_step";
  channel: PolicyChannel;
  expectedTool: string;
  observedToolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** What the model actually wrote, verbatim, so drift is inspectable even though it is not graded. */
  writtenContent: string | null;
  satisfied: boolean;
  usage: unknown;
  latencyMs: number;
}

export interface InputMessageEvent {
  type: "input_message";
  index: number;
  entryId: string;
  role: CanonicalMessage["role"];
  /** Exactly one of `content` / `contentRef` is set. */
  content?: string;
  contentRef?: HaystackRef;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: CanonicalMessage["toolCalls"];
  chars: number;
  /** pi's own estimator is chars/4; recorded as an estimate, not a tokenizer result. */
  estTokens: number;
}

export interface CutDecisionEvent {
  type: "cut_decision";
  firstKeptEntryId: string | null;
  firstKeptIndex: number | null;
  compactedEntryIds: string[];
  retainedEntryIds: string[];
  isSplitTurn: boolean;
  turnStartIndex: number | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
}

/**
 * A split turn produces TWO summarizer calls with DIFFERENT prompts —
 * `SUMMARIZATION_PROMPT` over `messagesToSummarize`, and `TURN_PREFIX_SUMMARIZATION_PROMPT` over
 * `turnPrefixMessages`, concatenated. The turn-prefix prompt has no `## Constraints & Preferences`
 * heading at all, so `summaryPolicyPreserved` is only measurable on the history half. `part`
 * exists so a reader can tell which half a number came from.
 */
export type SummarizerPart = "history" | "turn_prefix";

export interface SummarizerInputEvent {
  type: "summarizer_input";
  part: SummarizerPart;
  entryIds: string[];
  /** The post-truncation text — what the model receives, not what the prefix contains. */
  serializedConversation: string;
  charsBeforeTruncation: number;
  charsAfterTruncation: number;
  truncatedEntryIds: string[];
  charsDiscardedPerEntry: Record<string, number>;
  isSplitTurn: boolean;
  /** See the module docblock: faithful, not proven byte-identical. */
  reconstructed: true;
  /** pi's prompt constant is unexported; the revision pins it instead of a copy that would drift. */
  promptTemplateRef: string;
}

/**
 * The summarizer call did not return a usable summary.
 *
 * Added after a live gap: six `xiaomi/mimo-v2.5-pro` rows failed with `missing_native_compaction`
 * and their trajectories jumped straight from `summarizer_input` to `run_end`. The invalid reason
 * was recorded, the provider message was not — so the one fact needed to tell a retryable timeout
 * from a permanent fault was missing from the very artefact built to answer that question.
 *
 * `classifiedTransient` distinguishes "gave up after N attempts" from "was never eligible for
 * retry", which is the difference between a real rate limit and an unrecognised error string.
 */
export interface SummarizerFailureEvent {
  type: "summarizer_failure";
  reason: string;
  message: string;
  attempts: number;
  classifiedTransient: boolean;
  elapsedMs: number;
}

/** Emitted per retry attempt, so a slow-but-recovered run is distinguishable from a fast one. */
export interface SummarizerRetryEvent {
  type: "summarizer_retry";
  attempt: number;
  delayMs: number;
  message: string;
}

export interface SummarizerOutputEvent {
  type: "summarizer_output";
  part: SummarizerPart;
  summary: string;
  /** Null by construction on `part: "turn_prefix"` — that prompt has no such section. */
  constraintsSection: string | null;
  usage: unknown;
  model: string;
  latencyMs: number | null;
}

export interface PostCompactionContextEvent {
  type: "post_compaction_context";
  messages: Array<{ entryId: string; role: string; chars: number; content?: string; contentRef?: HaystackRef }>;
  totalChars: number;
}

export interface DecisionStepEvent {
  type: "decision_step";
  step: number;
  assistantText: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  /** What the harness answered non-graded calls with, so the trajectory is replayable. */
  stubResults: Array<{ toolCallId: string; name: string; content: string }>;
  latencyMs: number | null;
  rawResponse: unknown;
}

export interface OutcomeEvent {
  type: "outcome";
  grade: GradeResult | null;
  binaryLabel: "violation" | "not_violation" | null;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  terminalText: string;
  toolSteps: number | null;
  hitStepCap: boolean | null;
}

export interface RunEndEvent {
  type: "run_end";
  durationMs: number;
  valid: boolean;
  invalidReason: InvalidReason | null;
}

/**
 * v1.2 events.
 *
 * Added as their own variants rather than by loosening the union: the point of a typed event log
 * is that a recorder cannot silently emit a field nothing reads, and widening the type to
 * `Record<string, unknown>` would give that up for every event at once.
 */
export interface V12RunMetaEvent {
  type: "v12_run_meta";
  runId: string;
  protocolVersion: "v1.2";
  configCohort: string;
  sourceTranscriptId: string;
  spec: unknown;
  taskId: string;
  model: string;
  repetition: number;
  retainedTailTokens: number;
  summarizerMaxTokens: number;
}

/** The full-context control's proof that nothing was lost on the way to the provider. */
export interface FullContextCheckEvent {
  type: "full_context_check";
  fullContextVerified: boolean;
  finalRequestChars: number;
  finalRequestMessages: number;
  estimatedRequestTokens: number;
  missingEntryIds: string[];
  fits: boolean;
  responseAllowanceTokens: number;
  contextWindowTokens: number;
}

/** The limit that actually binds, rather than the two fields it is derived from. */
export interface SummarizerLimitsEvent {
  type: "summarizer_limits";
  modelMaxTokens: number;
  reserveTokens: number;
  effectiveHistoryMaxTokens: number;
  effectiveTurnPrefixMaxTokens: number;
  customInstructionsSha256: string | null;
}

export type TrajectoryEvent =
  | V12RunMetaEvent
  | FullContextCheckEvent
  | SummarizerLimitsEvent
  | RunMetaEvent
  | PolicyChannelStepEvent
  | InputMessageEvent
  | CutDecisionEvent
  | SummarizerInputEvent
  | SummarizerRetryEvent
  | SummarizerFailureEvent
  | SummarizerOutputEvent
  | PostCompactionContextEvent
  | DecisionStepEvent
  | OutcomeEvent
  | RunEndEvent;

/**
 * Buffered append-only writer, one per run.
 *
 * Events are collected in memory and flushed once, because a run's whole trajectory is ~10 KB
 * and one write beats a dozen. `enabled: false` makes every method a no-op so the recording can
 * be switched off without the call sites growing conditionals.
 */
export class TrajectoryWriter {
  private readonly events: TrajectoryEvent[] = [];

  constructor(
    private readonly dir: string,
    private readonly enabled: boolean = true,
  ) {}

  get path(): string {
    return join(this.dir, TRAJECTORY_FILENAME);
  }

  record(event: TrajectoryEvent): void {
    if (!this.enabled) return;
    this.events.push(event);
  }

  /** Convenience: emit one `input_message` per canonical message, refs supplied by the caller. */
  recordInputMessages(
    messages: CanonicalMessage[],
    refFor?: (m: CanonicalMessage, index: number) => HaystackRef | null,
  ): void {
    if (!this.enabled) return;
    messages.forEach((m, index) => {
      const ref = refFor?.(m, index) ?? null;
      const event: InputMessageEvent = {
        type: "input_message",
        index,
        entryId: m.entryId,
        role: m.role,
        ...(ref ? { contentRef: ref } : { content: m.content }),
        ...(m.toolName ? { toolName: m.toolName } : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        chars: m.content.length,
        estTokens: Math.ceil(m.content.length / 4),
      };
      this.events.push(event);
    });
  }

  /** In-memory view, for tests and for callers that assemble before flushing. */
  snapshot(): readonly TrajectoryEvent[] {
    return this.events;
  }

  async flush(): Promise<string | null> {
    if (!this.enabled) return null;
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path, this.events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    return this.path;
  }

  /** Append without rewriting, for a late event after a flush has already happened. */
  async append(event: TrajectoryEvent): Promise<void> {
    if (!this.enabled) return;
    this.events.push(event);
    await appendFile(this.path, JSON.stringify(event) + "\n", "utf8");
  }
}

/** Parse a trajectory file back into typed events. Used by tests and the rehydrate script. */
export function parseTrajectory(text: string): TrajectoryEvent[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as TrajectoryEvent;
      } catch (e) {
        throw new Error(`trajectory line ${i + 1} is not valid JSON: ${String(e)}`);
      }
    });
}

/**
 * The event order. Asserted by `tests/harness-trajectory.test.ts` so a reordering that
 * would confuse a reader is caught rather than discovered while reading one.
 */
export const EVENT_ORDER: ReadonlyArray<TrajectoryEvent["type"]> = [
  "run_meta",
  "policy_channel_step",
  "input_message",
  "cut_decision",
  "summarizer_input",
  "summarizer_retry",
  "summarizer_failure",
  "summarizer_output",
  "post_compaction_context",
  "decision_step",
  "outcome",
  "run_end",
];

export function assertEventOrder(events: TrajectoryEvent[]): void {
  let floor = 0;
  for (const [i, e] of events.entries()) {
    const rank = EVENT_ORDER.indexOf(e.type);
    if (rank === -1) throw new Error(`event ${i} has unknown type ${e.type}`);
    if (rank < floor) {
      throw new Error(`event ${i} (${e.type}) appears after a later-stage event`);
    }
    floor = rank;
  }
}
