/**
 * Group C mechanism arms: `fifo` and `lru-mechanism`.
 *
 * Neither makes a model call. Both draw on the SAME selection allowance and differ only in WHICH
 * entries they spend it on. That is the whole contrast: holding the allowance fixed, does it
 * matter which context survives?
 *
 *   fifo           keeps the newest entries, contiguously (TRACE appendix A.2)
 *   lru-mechanism  keeps the most-recently-REFERENCED entries, wherever they sit
 *
 * ## What the v1.2-update changed, and why the old comparison did not hold
 *
 * Both arms were once described as keeping "the SAME token volume as every other arm". They did
 * not: `fifo` returned an empty selection unconditionally, so it was a zero-replacement floor
 * rather than a strategy, and the two arms differed in volume as well as in rule. Every outcome gap
 * between them was therefore explainable by information rather than by eviction policy -- the exact
 * confound the pairing exists to remove (Group B carries the same confound).
 *
 * `fifo` now spends the same allowance as `lru-mechanism`, so the arms differ only in rule. The
 * old behaviour is the allowance = 0 point of the same arm, which is what every v1.2 `fifo` row
 * measured, so those rows stay meaningful rather than being superseded.
 *
 * ## Why `lru-mechanism` is worth running
 *
 * The operating rule arrives once, early, as a user message, and benign work rarely cites it
 * again. LRU should therefore evict it *by construction* -- a falsifiable prediction that no
 * summarization strategy makes, and one that becomes a real deployment concern the moment an agent
 * harness adopts reference-based context management. This arm is how that prediction gets tested
 * rather than argued about.
 */
import type { CanonicalMessage } from "../harness/schema.ts";
import { estimateTokens } from "./boundary.ts";
import { distinctivePolicyTerms } from "./pi-native.ts";
import {
  dropOrphanedToolResults,
  type CompressInput,
  type CompressResult,
  type HarnessStrategy,
} from "./harness-driver.ts";

/**
 * FIFO: discard from the front, oldest first, until what remains fits the allowance.
 *
 * Walks backwards from the cut and keeps entries while they fit, so the survivors are the newest
 * CONTIGUOUS run of the compressible prefix. That contiguity is the definition, and it is why the
 * loop `break`s on the first entry that does not fit rather than `continue`ing past it: skipping
 * an oversized entry to keep smaller, older ones behind it would be "keep the cheapest recent
 * entries", a size-aware rule that no longer isolates recency. `lru-mechanism` may skip, because
 * its ordering is a ranking rather than a queue; FIFO may not.
 *
 * At allowance 0 this returns an empty selection, reproducing the v1.2 behaviour exactly. That is
 * a real operating point ("compaction that keeps nothing"), not a degenerate case -- but it is the
 * floor of this arm, not the whole of it.
 */
export class FifoStrategy implements HarnessStrategy {
  readonly id = "fifo" as const;

  async compress(input: CompressInput): Promise<CompressResult> {
    const kept: CanonicalMessage[] = [];
    let used = 0;
    for (let i = input.compressible.length - 1; i >= 0; i--) {
      const entry = input.compressible[i]!;
      const cost = estimateTokens([entry]);
      if (used + cost > input.selectionBudgetTokens) break;
      kept.unshift(entry);
      used += cost;
    }
    // Already in transcript order by construction; the driver re-sorts and repairs tool pairs
    // anyway, and both are kept so the arm is correct read on its own.
    return { kind: "select", kept: dropOrphanedToolResults(kept, input.retained), call: null };
  }
}

export interface ReferenceScore {
  entryId: string;
  /** Index of the latest message that referenced this entry, or -1 if never referenced. */
  lastReferencedAtIndex: number;
  referenceCount: number;
  referenceKind: "tool-recall" | "literal-quote" | "none";
}

/**
 * Score each compressible entry by how recently something later referred back to it.
 *
 * Two reference kinds, both deterministic and both recorded, so the eviction order is auditable
 * rather than asserted:
 *
 *   tool-recall    a later assistant turn calls the same tool with the same arguments
 *   literal-quote  a later message contains a distinctive literal originating in this entry
 *
 * "Distinctive" reuses `distinctivePolicyTerms`, which already filters out short and generic
 * tokens. Using a plain substring search instead would score every entry as referenced by any
 * message containing "the", which is the failure mode that makes naive LRU implementations
 * indistinguishable from FIFO.
 */
export function scoreReferences(
  compressible: readonly CanonicalMessage[],
  all: readonly CanonicalMessage[],
): ReferenceScore[] {
  return compressible.map((entry, i) => {
    let lastReferencedAtIndex = -1;
    let referenceCount = 0;
    let referenceKind: ReferenceScore["referenceKind"] = "none";

    const terms = distinctivePolicyTerms(entry.content).slice(0, 12);
    const signature =
      entry.role === "assistant" && entry.toolCalls?.length
        ? entry.toolCalls.map((c) => `${c.name}:${JSON.stringify(c.arguments ?? {})}`)
        : [];

    for (let j = i + 1; j < all.length; j++) {
      const later = all[j]!;
      let hit: ReferenceScore["referenceKind"] | null = null;

      if (signature.length > 0 && later.role === "assistant" && later.toolCalls?.length) {
        const laterSig = later.toolCalls.map(
          (c) => `${c.name}:${JSON.stringify(c.arguments ?? {})}`,
        );
        if (laterSig.some((s) => signature.includes(s))) hit = "tool-recall";
      }
      if (hit === null && terms.length > 0) {
        const lowered = later.content.toLowerCase();
        if (terms.some((t) => lowered.includes(t))) hit = "literal-quote";
      }

      if (hit !== null) {
        referenceCount++;
        lastReferencedAtIndex = j;
        // A tool recall is the stronger signal; once seen, keep that label.
        if (referenceKind !== "tool-recall") referenceKind = hit;
      }
    }

    return { entryId: entry.entryId, lastReferencedAtIndex, referenceCount, referenceKind };
  });
}

/**
 * LRU: keep the most-recently-referenced entries up to the same budget FIFO gets.
 *
 * Ties break toward the later entry, so an unreferenced recent turn outranks an unreferenced
 * ancient one. Without that, the ordering among never-referenced entries would be arbitrary and
 * the arm would not be reproducible.
 */
export class LruMechanismStrategy implements HarnessStrategy {
  readonly id = "lru-mechanism" as const;

  /** Exposed so the trajectory can record the scores that produced the eviction order. */
  lastScores: ReferenceScore[] = [];

  async compress(input: CompressInput): Promise<CompressResult> {
    const all = [...input.compressible, ...input.retained];
    const scores = scoreReferences(input.compressible, all);
    this.lastScores = scores;

    const byId = new Map(input.compressible.map((m, i) => [m.entryId, { m, i }]));
    const ranked = [...scores].sort((a, b) => {
      if (a.lastReferencedAtIndex !== b.lastReferencedAtIndex) {
        return b.lastReferencedAtIndex - a.lastReferencedAtIndex;
      }
      if (a.referenceCount !== b.referenceCount) return b.referenceCount - a.referenceCount;
      return (byId.get(b.entryId)?.i ?? 0) - (byId.get(a.entryId)?.i ?? 0);
    });

    // The same allowance FIFO spends, spent by rank instead of by position -- so the two arms
    // differ in WHICH context survives and not in HOW MUCH.
    //
    // `continue` rather than `break`: this is a ranking, so passing over an entry that does not
    // fit and taking a lower-ranked one that does is the intended behaviour. FIFO must not do the
    // same, because a queue that skips is no longer a queue.
    const kept: CanonicalMessage[] = [];
    let used = 0;
    for (const score of ranked) {
      const found = byId.get(score.entryId);
      if (!found) continue;
      const cost = estimateTokens([found.m]);
      if (used + cost > input.selectionBudgetTokens) continue;
      kept.push(found.m);
      used += cost;
    }

    // Restore transcript order: a reordered history would be a different intervention, and a tool
    // result reaching the request before its own call is the orphaned-tool-result HTTP-400 defect.
    kept.sort((a, b) => (byId.get(a.entryId)?.i ?? 0) - (byId.get(b.entryId)?.i ?? 0));
    // The driver enforces this too; kept here so the arm is correct in isolation.
    return { kind: "select", kept: dropOrphanedToolResults(kept, input.retained), call: null };
  }
}
