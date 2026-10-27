import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summaryPreservesPolicy } from "../compaction/pi-native.ts";
import { medianLabel, retentionTier } from "./aggregate.ts";
import { judgeOnce, type JudgeClientOptions } from "./client.ts";
import { JUDGE_PROMPT_SHA256, JUDGE_SYSTEM_PROMPT, judgeUserMessage } from "./rubric.ts";
import { loadPolicies, loadSweep } from "./rows.ts";
import type { JudgeCall, JudgeTask, JudgmentRow } from "./schema.ts";

/**
 * Pinned literally, never via a floating alias.
 *
 * None of the three wrote a summary being graded: gpt-6-luna released 2026-09-23, nine days after
 * the sweep; qwen3.8-flash is a version above the sweep's qwen3.7-flash; Anthropic appears nowhere
 * in the panel. google/gemini-3.8-flash was evaluated and rejected -- it cannot disable reasoning.
 */
export const JUDGE_PANEL: readonly string[] = [
  "openai/gpt-6-luna-pro",
  "qwen/qwen3.8-flash",
  "anthropic/claude-sonnet-4.6",
];

export function cacheKey(runId: string, promptSha256: string): string {
  return `${runId}|${promptSha256}`;
}

/**
 * Rows already judged under the CURRENT rubric AND the current panel.
 *
 * Both have to match. A row judged under a different prompt is not comparable, and neither is a
 * row judged by a different panel -- swapping one judge changes what the majority means. Keying
 * the cache on the prompt alone would have silently reused rows from the old panel when
 * `openai/gpt-6-luna` was replaced by `openai/gpt-6-luna-pro`.
 */
export function readCache(
  path: string,
  panel: readonly string[] = JUDGE_PANEL,
): Map<string, JudgmentRow> {
  const out = new Map<string, JudgmentRow>();
  if (!existsSync(path)) return out;
  const want = panel.join(",");
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as JudgmentRow;
    if (row.provenance.promptSha256 !== JUDGE_PROMPT_SHA256) continue;
    if ((row.provenance.panel ?? []).join(",") !== want) continue;
    out.set(row.runId, row);
  }
  return out;
}

export function scoreTask(
  task: JudgeTask,
  calls: JudgeCall[],
  panel: readonly string[] = JUDGE_PANEL,
): JudgmentRow {
  const median = medianLabel(calls.map((c) => c.label));
  // The cross-check runs over the WHOLE summary, not the labelled section -- scoping it to the
  // section is the defect being replaced. It passes on 93.3% of generative rows, so it is a weak
  // one-sided guard: it catches the easy judge false positive and nothing harder.
  const keywordCrossCheck = summaryPreservesPolicy(task.summary, task.policy);
  return {
    runId: task.runId,
    model: task.model,
    modelDir: task.modelDir,
    arm: task.arm,
    taskId: task.taskId,
    source: "judge",
    calls,
    median,
    keywordCrossCheck,
    tier: retentionTier(median, keywordCrossCheck),
    lexical: task.lexical,
    lexicalSectionParsed: task.lexicalSectionParsed,
    provenance: {
      promptSha256: JUDGE_PROMPT_SHA256,
      panel: [...panel],
      temperature: 0,
      judgedAt: new Date().toISOString(),
    },
  };
}

export interface RunArgs {
  sweepDir: string;
  casesPath: string;
  opts: JudgeClientOptions;
  concurrency: number;
  panel?: readonly string[];
  limit?: number;
  onProgress?: (done: number, total: number, costUsd: number) => void;
}

/**
 * Judge every generative row that is not already cached.
 *
 * Results are appended a row at a time rather than written at the end, so an interrupted pass
 * loses nothing and resumes. This repo has lost a multi-hour sweep to a mid-run crash before.
 */
export async function runJudgePass(
  args: RunArgs,
): Promise<{ written: number; reused: number; failed: number; costUsd: number }> {
  const panel = args.panel ?? JUDGE_PANEL;
  const policies = loadPolicies(args.casesPath);
  const { judged, deterministic } = loadSweep({ sweepDir: args.sweepDir, policies });

  const byModelDir = new Map<string, JudgeTask[]>();
  for (const task of judged) {
    const list = byModelDir.get(task.modelDir) ?? [];
    list.push(task);
    byModelDir.set(task.modelDir, list);
  }

  let written = 0;
  let reused = 0;
  let failed = 0;
  let costUsd = 0;
  let done = 0;
  let considered = 0;
  const total = args.limit ?? judged.length;

  for (const [dir, tasks] of byModelDir) {
    const sidecar = join(args.sweepDir, dir, "judgments.jsonl");
    const cache = readCache(sidecar, panel);

    // The limit caps rows CONSIDERED, not rows judged. Capping pending rows would make a repeat
    // run judge the next N instead of reporting reuse, which would make the resume check
    // unfalsifiable -- and it did, on the first smoke.
    //
    // It is also spread EVENLY across models rather than filled from the first directory. A
    // smoke drawn entirely from one model cannot sanity-check the per-model agreement table,
    // which is the main thing a smoke is for here.
    const perDir = args.limit === undefined
      ? tasks.length
      : Math.ceil(args.limit / byModelDir.size);
    const room = args.limit === undefined
      ? tasks.length
      : Math.min(perDir, Math.max(0, total - considered));
    const window = tasks.slice(0, room);
    considered += window.length;
    const queue = window.filter((t) => !cache.has(t.runId));
    reused += window.length - queue.length;

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= queue.length) return;
        const task = queue[i]!;
        const calls: JudgeCall[] = [];
        for (const slug of panel) {
          calls.push(
            await judgeOnce({
              slug,
              system: JUDGE_SYSTEM_PROMPT,
              user: judgeUserMessage(task.policy, task.summary),
              opts: args.opts,
            }),
          );
        }
        const row = scoreTask(task, calls, panel);
        appendFileSync(sidecar, JSON.stringify(row) + "\n", "utf8");
        written++;
        if (row.tier === "not_measured") failed++;
        costUsd += calls.reduce((s, c) => s + c.costUsd, 0);
        done++;
        args.onProgress?.(done, total, costUsd);
      }
    };
    await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
    if (args.limit !== undefined && considered >= total) break;
  }

  // Deterministic rows carry no model call, so they are rewritten wholesale each pass.
  const detByDir = new Map<string, JudgmentRow[]>();
  for (const row of deterministic) {
    const list = detByDir.get(row.modelDir) ?? [];
    list.push(row);
    detByDir.set(row.modelDir, list);
  }
  for (const [dir, rows] of detByDir) {
    // writeFileSync, not append: these are recomputed in full every pass, and appending
    // duplicated every row on the second run.
    const path = join(args.sweepDir, dir, "judgments-deterministic.jsonl");
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }

  return { written, reused, failed, costUsd };
}
