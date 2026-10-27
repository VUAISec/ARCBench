/**
 * `arcbench evaluate`: metrics over one or more results directories.
 *
 * The numbers are computed by the Python package `metrics/` (numpy), so bootstrap intervals come
 * from numpy's generator and are reproducible from the seed. This command validates flags, runs the
 * retention judge pass when `--judge_metric retention` needs judgments that are not cached yet,
 * then hands over to `python3 -m metrics`.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { REPO_ROOT, loadConfig, pythonExecutable } from "../config/config.ts";
import { runJudgePass } from "../judge/run.ts";
import { formatViolations } from "../plan/episodes.ts";
import type { RuleViolation } from "../plan/configuration.ts";
import { all, flag, one, type FlagSpec, type ParsedArgs } from "./args.ts";
import { CASES_PATH, CliError } from "./run-commands.ts";

export const EVALUATE_FLAGS: Record<string, FlagSpec> = {
  results: { repeatable: true, allowComma: true },
  judge_metric: {},
  k: {},
  contrast: { repeatable: true, allowComma: true },
  where: { repeatable: true },
  by: {},
  common_support: { boolean: true },
  bootstrap_draws: {},
  seed: {},
  out: { allowComma: true },
  no_judge_calls: { boolean: true },
};

export const JUDGE_METRICS = ["violation", "retention"] as const;

function resolve(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p);
}

/** Directories under a results dir that hold a results.jsonl (the dir itself, or its model dirs). */
function modelDirs(dir: string): string[] {
  if (existsSync(join(dir, "results.jsonl"))) return [dir];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "results.jsonl")))
    .map((d) => join(dir, d.name));
}

export async function evaluateCommand(args: ParsedArgs): Promise<void> {
  const v: RuleViolation[] = [...args.violations];
  const results = all(args, "results").map(resolve);
  if (results.length === 0) {
    v.push({ id: "MISSING-FLAG", reason: "--results is required.", fix: "give --results <dir> (repeatable)" });
  }
  for (const r of results) {
    if (!existsSync(r)) v.push({ id: "MISSING-RESULTS", reason: `--results ${r} does not exist.`, fix: "point --results at a directory written by arcbench run" });
  }
  const metric = one(args, "judge_metric") ?? "violation";
  if (!(JUDGE_METRICS as readonly string[]).includes(metric)) {
    v.push({ id: "UNKNOWN-VALUE", reason: `--judge_metric ${metric} is not a known value.`, fix: `use one of: ${JUDGE_METRICS.join(", ")}` });
  }
  for (const name of ["k", "bootstrap_draws", "seed"]) {
    const raw = one(args, name);
    if (raw !== undefined && !(Number.isInteger(Number(raw)) && Number(raw) >= (name === "seed" ? 0 : 1))) {
      v.push({ id: "UNKNOWN-VALUE", reason: `--${name} ${raw} is not a valid integer.`, fix: `give --${name} an integer` });
    }
  }
  if (v.length > 0) throw new CliError(formatViolations(v));

  if (metric === "retention") {
    const missing = results.flatMap(modelDirs).filter((d) => !existsSync(join(d, "judgments.jsonl")));
    const released = join(REPO_ROOT, "results");
    if (missing.length > 0 && !flag(args, "no_judge_calls") && missing.some((d) => d.startsWith(released + "/"))) {
      throw new CliError(
        "arcbench: the released rows under results/ are never written, and some have no judgments.jsonl. " +
          "Copy the study to runs/ and judge it there (scripts/judges/rule-state/judge.ts), or pass --no_judge_calls.",
      );
    }
    if (missing.length > 0 && !flag(args, "no_judge_calls")) {
      const key = process.env["OPENROUTER_API_KEY"];
      if (!key) {
        throw new CliError(
          `arcbench: ${missing.length} model director${missing.length === 1 ? "y has" : "ies have"} no judgments.jsonl yet, and ` +
            "judging needs OPENROUTER_API_KEY. Export your key, or pass --no_judge_calls to report the lexical metric only.",
        );
      }
      const cfg = loadConfig();
      for (const dir of new Set(missing.map((d) => join(d, "..")))) {
        console.log(`judge pass over ${dir} (cached judgments are reused)`);
        const out = await runJudgePass({
          sweepDir: dir,
          casesPath: CASES_PATH,
          opts: {
            apiKey: key,
            baseUrl: cfg.openrouterBaseUrl,
            requestTimeoutMs: cfg.requestTimeoutMs,
            maxTransientRetries: 3,
            retryBaseDelayMs: cfg.retryBaseDelayMs,
            maxParseRetries: 1,
          },
          concurrency: 6,
        });
        console.log(`  written=${out.written} reused=${out.reused} not_measured=${out.failed} cost=$${out.costUsd.toFixed(2)}`);
      }
    }
  }

  const py: string[] = ["-m", "metrics", "--judge_metric", metric];
  for (const r of results) py.push("--results", r);
  for (const name of ["k", "by", "bootstrap_draws", "seed", "out"]) {
    const raw = one(args, name);
    if (raw !== undefined) py.push(`--${name}`, name === "out" ? resolve(raw) : raw);
  }
  for (const c of all(args, "contrast")) py.push("--contrast", c);
  for (const w of all(args, "where")) py.push("--where", w);
  if (flag(args, "common_support")) py.push("--common_support");

  const code = await new Promise<number>((done) => {
    const child = spawn(pythonExecutable(), py, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, PYTHONPATH: REPO_ROOT },
    });
    child.on("close", (c) => done(c ?? 1));
    child.on("error", () => done(127));
  });
  if (code !== 0) throw new CliError(`arcbench: metrics exited with status ${code}`, code);
}
