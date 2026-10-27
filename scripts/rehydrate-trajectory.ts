/**
 * Expand a trajectory's haystack references back into bytes, verifying the corpus hash.
 *
 * Trajectories store the ~96,339-char haystack by reference — seed, task, repetition and slice
 * bounds — rather than inline: ~57 MB across the sweep instead of ~550 MB. That is only safe if the
 * corpus is genuinely reproducible, so this script REGENERATES it from the recorded seed and checks
 * the SHA-256 against the one the run recorded. A drift in `src/context/haystack.ts` then fails
 * loudly here rather than silently handing back different filler than the run actually used.
 *
 * Usage:
 *   npx tsx scripts/rehydrate-trajectory.ts <trajectory.jsonl> [--out <file>] [--verify-only]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildHaystack } from "../src/context/haystack.ts";
import { loadMvpConfig } from "../src/config/config.ts";
import { parseTrajectory, type HaystackRef, type TrajectoryEvent } from "../src/harness/trajectory.ts";

export class RehydrationError extends Error {}

interface CorpusCacheEntry {
  text: string;
  sha256: string;
}

/**
 * Regenerate a corpus from its reference and verify the hash.
 *
 * `reservedValues` is deliberately omitted: it only constrains the needle VALUE draw, and the
 * recorded SHA-256 is the authority on whether the regenerated text matches. If a task's graded
 * ceiling ever changed the draw, the hash check below is what catches it.
 */
export function regenerateCorpus(ref: HaystackRef, targetChars: number, needleKeyPrefix: string): CorpusCacheEntry {
  const built = buildHaystack({ seed: ref.seed, targetChars, needleKeyPrefix });
  const sha256 = createHash("sha256").update(built.text, "utf8").digest("hex");
  if (sha256 !== ref.corpusSha256) {
    throw new RehydrationError(
      `corpus hash mismatch for ${ref.corpusId} seed=${ref.seed} task=${ref.taskId} ` +
        `rep=${ref.repetition}\n  recorded: ${ref.corpusSha256}\n  regenerated: ${sha256}\n` +
        `the haystack generator (src/context/haystack.ts) has changed since this run, so the stored reference no longer reproduces ` +
        `the text the summarizer actually saw. Re-run, or read the run's own results bundle.`,
    );
  }
  if (built.text.length !== ref.corpusChars) {
    throw new RehydrationError(
      `corpus length mismatch for ${ref.corpusId}: recorded ${ref.corpusChars}, got ${built.text.length}`,
    );
  }
  return { text: built.text, sha256 };
}

export interface RehydrateResult {
  events: TrajectoryEvent[];
  refsExpanded: number;
  corporaVerified: number;
}

/**
 * Replace every `contentRef` with the `content` it stands for.
 *
 * `header` is the `HAYSTACK_HEADER` each chunk carried. It is stored as a length rather than as
 * text, because it is a harness constant, and reproducing it exactly is what makes the expanded
 * entry byte-identical to the one pi received — including the 70 chars that count against pi's
 * 2,000-char cap and pushed a naive 2,000-char chunk over it.
 */
export function rehydrate(events: TrajectoryEvent[], header: string): RehydrateResult {
  const cfg = loadMvpConfig();
  const cache = new Map<string, CorpusCacheEntry>();
  let refsExpanded = 0;

  const expand = (ref: HaystackRef): string => {
    const key = `${ref.corpusId}|${ref.seed}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = regenerateCorpus(ref, cfg.haystackTargetChars, cfg.needleKeyPrefix);
      cache.set(key, entry);
    }
    const body = entry.text.slice(ref.sliceStart, ref.sliceEnd);
    const content = header.slice(0, ref.headerChars) + body;
    if (content.length !== ref.chars) {
      throw new RehydrationError(
        `expanded entry length ${content.length} does not match recorded ${ref.chars} ` +
          `(slice ${ref.sliceStart}..${ref.sliceEnd}, header ${ref.headerChars})`,
      );
    }
    refsExpanded++;
    return content;
  };

  const out = events.map((e) => {
    if (e.type === "input_message" && e.contentRef) {
      const { contentRef, ...rest } = e;
      return { ...rest, content: expand(contentRef) };
    }
    if (e.type === "post_compaction_context") {
      return {
        ...e,
        messages: e.messages.map((m) => {
          if (!m.contentRef) return m;
          const { contentRef, ...rest } = m;
          return { ...rest, content: expand(contentRef) };
        }),
      };
    }
    return e;
  });

  return { events: out as TrajectoryEvent[], refsExpanded, corporaVerified: cache.size };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("usage: rehydrate-trajectory.ts <trajectory.jsonl> [--out <file>] [--verify-only]");
    process.exit(2);
  }
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const verifyOnly = args.includes("--verify-only");

  // Imported lazily so the module stays usable from tests without pulling in transcript-v11.ts.
  const { HAYSTACK_HEADER } = await import("../src/context/transcript-v11.ts");
  const result = rehydrate(parseTrajectory(readFileSync(path, "utf8")), HAYSTACK_HEADER);

  console.log(
    `verified ${result.corporaVerified} corpus/corpora, expanded ${result.refsExpanded} reference(s)`,
  );
  if (verifyOnly) return;

  const text = result.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  if (outPath) {
    writeFileSync(outPath, text, "utf8");
    console.log(`wrote ${outPath}`);
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
