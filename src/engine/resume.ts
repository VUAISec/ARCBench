/**
 * Restartability for the v1.2 sweep.
 *
 * Preparing every run, then evaluating every run, then writing `results.jsonl` once means a sweep
 * that dies before that final write produces nothing, however many hours it had spent -- and the
 * models in this harness run for 2 to 21 hours each. This is the manifest-and-`--resume` idiom,
 * reached by batching the two-phase loop rather than by checkpointing it.
 *
 * `results.jsonl` is the ledger, and the only one. A separate progress file could disagree with
 * the rows actually on disk, and then resume would be deciding from bookkeeping rather than from
 * the results themselves.
 */
import { readFile } from "node:fs/promises";

/**
 * Every runId already recorded in a results file.
 *
 * Tolerant by design. A process killed mid-append leaves a half-written final line, and that is
 * exactly the moment this function is called -- throwing on it would make the crash unrecoverable,
 * which is the opposite of the point. Unparseable and runId-less lines are skipped; the run they
 * belong to is simply treated as not done and gets executed again.
 */
export async function completedRunIds(resultsPath: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(resultsPath, "utf8");
  } catch {
    // No file yet: nothing has been recorded, which is not an error.
    return new Set();
  }

  const done = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const runId = (parsed as { runId?: unknown }).runId;
    if (typeof runId === "string" && runId) done.add(runId);
  }
  return done;
}

/** The planned runs that are not yet on disk, in planning order. */
export function remainingRuns<T extends { runId: string }>(
  planned: readonly T[],
  done: ReadonlySet<string>,
): T[] {
  return planned.filter((r) => !done.has(r.runId));
}

/**
 * Split runs into the units the pipeline prepares and evaluates together.
 *
 * Batching is what makes run-level resume mean anything. The pipeline's two phases are
 * sequential -- nothing is a complete row until every preparation in its group has finished -- so
 * with one batch per model a crash loses the whole model. With batches, a crash loses at most one
 * batch, and the rows land on disk as the sweep proceeds rather than all at the end.
 */
export function batches<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`batch size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs per prepare/evaluate cycle.
 *
 * Trades a little throughput for durability: each batch boundary is a sync point where the
 * concurrency pool drains. At 64 a crash costs at most ~64 runs -- a few minutes -- against the
 * 2,040 a model's single batch would cost.
 */
export const DEFAULT_BATCH_SIZE = 64;
