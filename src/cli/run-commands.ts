/**
 * `arcbench plan`, `arcbench smoke` and `arcbench run`: one configuration, from flags to episodes to rows.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { loadConfig, modelSlug, REPO_ROOT, type BenchmarkConfig } from "../config/config.ts";
import { loadTaskRows, type TaskRow } from "../rule-loss/dataset.ts";
import { buildConditionV12 } from "../context/transcript-v12.ts";
import { buildCondition, referenceArm } from "../context/transcript-v11.ts";
import { computeFloorTokens, MIN_SUMMARY_TOKENS } from "../compaction/budget.ts";
import { makeSummarizerCall, validateSelection, type StrategyDeps } from "../compaction/registry.ts";
import { completedRunIds } from "../engine/resume.ts";
import { executeEpisodes, type ResultRow } from "../engine/pipeline.ts";
import { installFakeOpenRouter } from "../harness/fake-openrouter.ts";
import { formatViolations, planEpisodes, validateConfiguration, type Episode } from "../plan/episodes.ts";
import type { Configuration } from "../plan/configuration.ts";
import { flag, one, type ParsedArgs } from "./args.ts";
import { configurationFromFlags, describeConfiguration } from "./configuration-flags.ts";

export const CASES_PATH = join(REPO_ROOT, "data/rule-loss/cases.jsonl");

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
  }
}

export interface Setup {
  cfg: BenchmarkConfig;
  rows: TaskRow[];
  configuration: Configuration;
  episodes: Episode[];
}

/** Parse, validate and plan. Throws a CliError carrying every broken rule. */
export function setupFromArgs(args: ParsedArgs): Setup {
  if (args.violations.length > 0) throw new CliError(formatViolations(args.violations));
  const { configuration, violations } = configurationFromFlags(args);
  if (!configuration) throw new CliError(formatViolations(violations));
  const ruleViolations = validateConfiguration(configuration);
  if (ruleViolations.length > 0) throw new CliError(formatViolations(ruleViolations));
  const cfg = loadConfig();
  const rows = loadTaskRows(CASES_PATH);
  return { cfg, rows, configuration, episodes: planEpisodes(configuration, rows, cfg) };
}

function outDirFor(args: ParsedArgs, c: Configuration): string {
  const out = one(args, "out") ?? join("runs", c.cohort);
  return isAbsolute(out) ? out : join(process.cwd(), out);
}

/** How many episodes a budget cannot fit: protected context + the 64-token minimum exceeds it. */
function infeasibleBudgetCount(s: Setup): number | null {
  const c = s.configuration;
  if (c.budget === null) return null;
  const byId = new Map(s.rows.map((r) => [r.id, r]));
  let n = 0;
  for (const e of s.episodes) {
    const row = byId.get(e.caseId)!;
    const built =
      e.layout === "v1.1"
        ? buildCondition({ row, condition: e.legacyCondition!, repetition: e.repetition, cfg: s.cfg, arm: referenceArm(s.cfg), ...(e.channel ? { channel: e.channel } : {}) })
        : buildConditionV12({ row, spec: e.spec!, repetition: e.repetition, cfg: s.cfg, ...(c.attack !== "none" ? { attackTechnique: c.attack } : {}) });
    const floor = computeFloorTokens({
      messages: built.messages,
      taskInstructionEntryId: built.taskInstructionEntryId,
      retainedTailTokens: s.cfg.compaction.harnessBoundary.retainedTailTokens,
    });
    if (c.budget - floor < MIN_SUMMARY_TOKENS) n++;
  }
  return n;
}

function summarize(s: Setup): string {
  const c = s.configuration;
  const byChannel = new Map<string, number>();
  for (const e of s.episodes) byChannel.set(e.channel ?? "none", (byChannel.get(e.channel ?? "none") ?? 0) + 1);
  const lines = [
    `configuration: ${describeConfiguration(c)}`,
    `episodes: ${s.episodes.length} (${s.rows.length} cases x channels x ${c.repetitions} reps; ` +
      [...byChannel].map(([ch, n]) => `${ch}=${n}`).join(", ") + ")",
    `cohort ${c.cohort}: ${s.episodes[0]!.rowShape} rows, ${s.episodes[0]!.layout} layout`,
    `first runId: ${s.episodes[0]!.runId}`,
  ];
  const infeasible = infeasibleBudgetCount(s);
  if (infeasible !== null) {
    lines.push(
      `budget ${c.budget}: ${infeasible} of ${s.episodes.length} episodes cannot fit the protected context plus the ` +
        `${MIN_SUMMARY_TOKENS}-token minimum summary; they run with budgetFeasible=false`,
    );
  }
  return lines.join("\n");
}

function buildDeps(cfg: BenchmarkConfig, apiKey: string, c: Configuration): StrategyDeps {
  const deps: StrategyDeps = { summarizerCall: makeSummarizerCall(cfg, apiKey) };
  if (c.strategy !== "none") validateSelection([c.strategy], deps);
  return deps;
}

export async function planCommand(args: ParsedArgs): Promise<void> {
  const s = setupFromArgs(args);
  console.log(summarize(s));
  if (flag(args, "list")) for (const e of s.episodes) console.log(e.runId);
}

function requireKey(): string {
  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) {
    throw new CliError(
      "arcbench: OPENROUTER_API_KEY is not set. Export your own OpenRouter key before a live run:\n" +
        "  export OPENROUTER_API_KEY=sk-or-...\n" +
        "One key runs every experiment; nothing else is read.",
    );
  }
  return key;
}

async function execute(s: Setup, episodes: Episode[], apiKey: string, modelDir: string, args: ParsedArgs): Promise<ResultRow[]> {
  const deps = buildDeps(s.cfg, apiKey, s.configuration);
  const resultsPath = join(modelDir, "results.jsonl");
  return await executeEpisodes(episodes, {
    cfg: s.cfg,
    apiKey,
    resultsDir: modelDir,
    rows: new Map(s.rows.map((r) => [r.id, r])),
    deps,
    onProgress: (m) => console.log(m),
    onResults: async (batch) => {
      await appendFile(resultsPath, batch.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    },
    ...(one(args, "batch_size") ? { batchSize: Number(one(args, "batch_size")) } : {}),
    ...(one(args, "concurrency") ? { concurrencyOverride: Number(one(args, "concurrency")) } : {}),
  });
}

function tally(rows: ResultRow[]): string {
  const grades = new Map<string, number>();
  let valid = 0;
  for (const r of rows) {
    if (r.valid) valid++;
    const g = r.valid ? (r.outcome?.grade ?? "none") : `invalid:${r.invalidReason}`;
    grades.set(g, (grades.get(g) ?? 0) + 1);
  }
  return `${rows.length} episodes, ${valid} valid; ` + [...grades].map(([g, n]) => `${g}=${n}`).join(", ");
}

export async function smokeCommand(args: ParsedArgs): Promise<void> {
  const s = setupFromArgs(args);
  console.log(summarize(s));
  const limitRaw = one(args, "limit");
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new CliError(`arcbench: --limit ${limitRaw} is not a positive integer`);
  const episodes = limit !== undefined ? s.episodes.slice(0, limit) : s.episodes;

  if (flag(args, "live")) {
    const key = requireKey();
    const modelDir = join(outDirFor(args, s.configuration), modelSlug(s.configuration.agentModel));
    await mkdir(modelDir, { recursive: true });
    console.log(`live smoke: ${episodes.length} episode(s), real model calls, rows -> ${modelDir}`);
    console.log(tally(await execute(s, episodes, key, modelDir, args)));
    return;
  }

  // Offline: every stage runs against the fake transport; nothing leaves the machine.
  const dir = await mkdtemp(join(tmpdir(), "arcbench-smoke-"));
  const modelDir = join(dir, modelSlug(s.configuration.agentModel));
  await mkdir(modelDir, { recursive: true });
  const fake = installFakeOpenRouter();
  try {
    const rows = await execute(s, episodes, "fake-key", modelDir, args);
    console.log(`offline smoke (fake model, no network): ${tally(rows)}`);
    console.log(`${fake.requests.length} model requests built; rows and trajectories in ${modelDir}`);
  } finally {
    fake.restore();
  }
}

export async function runCommand(args: ParsedArgs): Promise<void> {
  const s = setupFromArgs(args);
  const apiKey = requireKey();
  const modelDir = join(outDirFor(args, s.configuration), modelSlug(s.configuration.agentModel));
  await mkdir(modelDir, { recursive: true });
  const resultsPath = join(modelDir, "results.jsonl");

  const done = await completedRunIds(resultsPath);
  const already = s.episodes.filter((e) => done.has(e.runId));
  if (already.length > 0 && !flag(args, "resume")) {
    throw new CliError(
      `arcbench: ${already.length} of ${s.episodes.length} episodes of this configuration are already recorded in ${resultsPath}.\n` +
        `  Pass --resume to run only the remaining ${s.episodes.length - already.length}, or --out to write elsewhere.`,
    );
  }
  const todo = s.episodes.filter((e) => !done.has(e.runId));
  console.log(summarize(s));

  // The plan and the resolved configuration are recorded next to the rows, one line per command.
  const planPath = join(modelDir, "plan.jsonl");
  const planned = existsSync(planPath)
    ? new Set((await readFile(planPath, "utf8")).split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { runId: string }).runId))
    : new Set<string>();
  const newPlan = s.episodes.filter((e) => !planned.has(e.runId));
  if (newPlan.length > 0) {
    await appendFile(
      planPath,
      newPlan
        .map((e) => JSON.stringify({ runId: e.runId, caseId: e.caseId, channel: e.channel, repetition: e.repetition, configuration: e.configuration }))
        .join("\n") + "\n",
    );
  }
  await appendFile(
    join(modelDir, "resolved-config.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), argv: process.argv.slice(2), configuration: s.configuration, config: s.cfg }) + "\n",
  );

  if (todo.length === 0) {
    console.log("nothing left to run: every episode of this configuration is recorded");
    return;
  }
  if (already.length > 0) console.log(`resume: ${already.length} recorded, ${todo.length} remaining`);
  console.log(tally(await execute(s, todo, apiKey, modelDir, args)));
  console.log(`rows: ${resultsPath}`);
}
