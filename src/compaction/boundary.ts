/**
 * The harness-owned boundary, shared by Groups B and C.
 *
 * ## Why this is not `keepRecentTokens`
 *
 * An earlier draft gave every strategy pi's `keepRecentTokens`. That was wrong, and not merely by
 * a naming convention: these methods do not share a knob. pi's is a token budget for the retained
 * tail; FIFO's is a ceiling the whole history must fit under; Hermes has three; and ACON and
 * TRACE have none at all, because they are summarization guidelines with no cut rule.
 *
 * `keepRecentTokens` therefore stays pi's, under pi's name, used only by the pi arms. Groups B and
 * C share `retainedTailTokens`, which belongs to this harness -- named differently precisely so a
 * later reader cannot mistake a harness operating point for pi's tuned constant.
 *
 * ## Why one boundary for both groups
 *
 * ACON and TRACE define no boundary, so one must be supplied. The TRACE appendix records what its
 * authors did: they preserved each method's schema and prompt text "while integrating them into
 * the same recurrent-compaction harness". One boundary, prompt swapped.
 *
 * That arrangement is what makes Group B a *component* comparison: with the prefix and tail
 * identical, a difference between two Group B arms is attributable to their prompts. Group C then
 * shares the same boundary so that what is REMOVED is matched too, and only what replaces it
 * differs.
 *
 * The consequence is that `findHarnessCut` must be a pure function of `(messages, budget)`. If it
 * consulted the strategy at all, the arms would stop being comparable and nobody would notice.
 */
import type { CanonicalMessage } from "../harness/schema.ts";

export class RetentionFloorError extends Error {}

/**
 * pi's own estimator, mirrored: ~4 characters per token.
 *
 * Deliberately the same convention pi uses for its cut arithmetic, so a calibrated
 * `retainedTailTokens` and pi's `keepRecentTokens` are measured on the same scale. This is an
 * estimate for boundary placement, never a claim about provider token accounting -- the realized
 * sizes reported per row are what a comparison should rest on.
 */
export function estimateTokens(messages: readonly CanonicalMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    for (const c of m.toolCalls ?? []) {
      chars += c.name.length + JSON.stringify(c.arguments ?? {}).length;
    }
  }
  return Math.ceil(chars / 4);
}

export interface HarnessCutOptions {
  retainedTailTokens: number;
}

export interface HarnessCut {
  /** Index of the first RETAINED message. Everything before it is compressible history. */
  firstKeptIndex: number;
  /** What the tail actually came to. Calibration matches on average, not per task. */
  realizedTailTokens: number;
  realizedTailEntries: number;
}

/**
 * A valid cut point: a `user` or `assistant` entry.
 *
 * Cutting at a `tool` entry would leave the retained tail opening with a tool result whose call was
 * never declared. That is the orphaned-tool-result defect which made every tool-using request fail
 * with HTTP 400 -- and pi's own `findValidCutPoints` admits only user/assistant entries for the
 * same reason.
 */
function isValidCutPoint(m: CanonicalMessage | undefined): boolean {
  return m !== undefined && (m.role === "user" || m.role === "assistant");
}

/**
 * Walk back from the end until the tail reaches the budget, then land on a turn boundary.
 *
 * Always leaves at least one message on each side: a cut at 0 would compact nothing, and a cut at
 * `length` would leave no tail for the decision agent to act on.
 */
export function findHarnessCut(
  messages: readonly CanonicalMessage[],
  opts: HarnessCutOptions,
): HarnessCut {
  if (messages.length < 2) {
    throw new RetentionFloorError(
      `cannot cut a transcript of ${messages.length} message(s): nothing would remain on one side`,
    );
  }

  // Candidate cut points, in transcript order. Index 0 is excluded so something is always
  // compacted; `messages.length` is excluded so something is always retained.
  const candidates: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (isValidCutPoint(messages[i])) candidates.push(i);
  }
  if (candidates.length === 0) {
    // Better to fail loudly here than to return a tool index and have the decision request die
    // with an opaque HTTP 400 that gets filed as a protocol failure.
    throw new RetentionFloorError(
      `no valid cut point: every entry after index 0 is a tool result, so any tail would open ` +
        `with a tool result whose call was never declared (P4)`,
    );
  }

  // The smallest tail that still meets the budget, i.e. the LAST candidate that does. When the
  // budget exceeds the whole transcript, fall back to the earliest candidate -- the largest tail
  // available -- rather than silently returning something under budget with no record of it.
  const meeting = candidates.filter(
    (i) => estimateTokens(messages.slice(i)) >= opts.retainedTailTokens,
  );
  const index = meeting.length > 0 ? meeting[meeting.length - 1]! : candidates[0]!;

  const tail = messages.slice(index);
  return {
    firstKeptIndex: index,
    realizedTailTokens: estimateTokens(tail),
    realizedTailEntries: tail.length,
  };
}

export function splitAtCut(
  messages: readonly CanonicalMessage[],
  firstKeptIndex: number,
): { compressible: CanonicalMessage[]; retained: CanonicalMessage[] } {
  return {
    compressible: messages.slice(0, firstKeptIndex),
    retained: messages.slice(firstKeptIndex),
  };
}

export interface RetentionFloorInput {
  original: readonly CanonicalMessage[];
  retained: readonly CanonicalMessage[];
  /** Generated or extracted text standing in for the removed history. Empty for mechanism arms. */
  replacement: string;
  /** Entry id of the fixture's benign task instruction. */
  originalTaskInstructionId: string;
}

/**
 * TRACE appendix A.2's floor: system prompt, original task instruction and most recent turn are
 * retained verbatim by every strategy.
 *
 * The system prompt is structurally safe -- pi has no system-role message and the persona is passed
 * separately, so no strategy can reach it. The other two are checked here.
 *
 * A violation is a hard failure rather than a recorded outcome. An arm that dropped the agent's own
 * task instruction is not a compaction strategy performing badly; it is a broken construction, and
 * recording its prohibited-action rate would put a meaningless number in the denominator.
 */
export function assertRetentionFloor(input: RetentionFloorInput): void {
  const { original, retained, replacement, originalTaskInstructionId } = input;

  const last = original[original.length - 1];
  if (!last) throw new RetentionFloorError("empty transcript");
  if (!retained.some((m) => m.entryId === last.entryId)) {
    throw new RetentionFloorError(
      `retention floor: the most recent turn (${last.entryId}) was not retained verbatim`,
    );
  }

  const instruction = original.find((m) => m.entryId === originalTaskInstructionId);
  if (!instruction) {
    throw new RetentionFloorError(
      `retention floor: original task instruction ${originalTaskInstructionId} is not in the transcript`,
    );
  }
  const survivedVerbatim = retained.some((m) => m.entryId === instruction.entryId);
  // A summary arm may legitimately carry the instruction forward as generated text instead of
  // retaining the entry. A mechanism arm produces no text, so for it the entry itself must survive.
  const survivedInReplacement = replacement.trim().length > 0;
  if (!survivedVerbatim && !survivedInReplacement) {
    throw new RetentionFloorError(
      `retention floor: original task instruction ${originalTaskInstructionId} was dropped and ` +
        `no replacement text carries it forward`,
    );
  }
}
