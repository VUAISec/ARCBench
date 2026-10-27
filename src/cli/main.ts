/**
 * `arcbench` -- the ARCBench (Agent Rule Compliance Benchmark)'s single entry point.
 *
 *   ./arcbench preflight
 *   ./arcbench plan     <factor flags>
 *   ./arcbench smoke    <factor flags> [--live --limit N]
 *   ./arcbench run      <factor flags> [--out DIR] [--resume]
 *   ./arcbench evaluate --results DIR [--judge_metric violation|retention] [--contrast "a=x - a=y"]
 */
import { parseArgs, type FlagSpec } from "./args.ts";
import { EXECUTION_FLAGS, FACTOR_FLAGS, FACTOR_HELP } from "./configuration-flags.ts";
import { EVALUATE_FLAGS, evaluateCommand, JUDGE_METRICS } from "./evaluate.ts";
import { preflightCommand } from "./preflight.ts";
import { CliError, planCommand, runCommand, smokeCommand } from "./run-commands.ts";

const HELP = `arcbench -- ARCBench (Agent Rule Compliance Benchmark)

Commands:
  preflight                 check key, pi build and revision, cases, python (no model calls)
  plan <flags>              validate one configuration and print its episodes (no model calls)
  smoke <flags>             run every stage against an offline fake model (no model calls)
  smoke <flags> --live --limit N
                            run N episodes for real (uses OPENROUTER_API_KEY)
  run <flags>               run one configuration (uses OPENROUTER_API_KEY)
  evaluate --results DIR    metrics over recorded runs

${FACTOR_HELP}

Run flags:
  --out <dir>               results directory (default runs/<cohort>); rows go to
                            <dir>/<agent-model-slug>/results.jsonl
  --resume                  skip episodes already recorded in that results.jsonl
  --concurrency <n>         raise per-model request concurrency for this run
  --batch_size <n>          episodes per prepare/decide cycle (default 64)

Evaluate flags:
  --results <dir>           a results directory (repeatable)
  --judge_metric <m>        ${JUDGE_METRICS.join(" | ")} (default violation)
  --k <n>                   violation@k / all-k repetitions (default: the repetitions present)
  --contrast "<a> - <b>"    matched difference, e.g. "injection_attack_method=escape - injection_attack_method=none"
  --by <factor>             split every metric by a factor, scenario or case
  --where <flag=value>      keep only episodes with that factor value (repeatable)
  --common_support          violation@k over settings complete in every compared configuration
  --bootstrap_draws <n>     case-cluster bootstrap draws (default 20000)
  --seed <n>                bootstrap seed (default 20260924)
  --no_judge_calls          retention from cached judgments and the lexical metric only

The OpenRouter key is read from OPENROUTER_API_KEY only; set it yourself.`;

const RUN_FLAGS: Record<string, FlagSpec> = { ...FACTOR_FLAGS, ...EXECUTION_FLAGS };
const SMOKE_FLAGS: Record<string, FlagSpec> = { ...RUN_FLAGS, live: { boolean: true }, limit: {} };
const PLAN_FLAGS: Record<string, FlagSpec> = { ...FACTOR_FLAGS, list: { boolean: true } };

async function main(argv: string[]): Promise<number> {
  const command = argv[0] !== undefined && !argv[0].startsWith("-") ? argv[0] : null;
  if (command === null || argv.includes("--help") || argv.includes("-h") || command === "help") {
    console.log(HELP);
    return 0;
  }
  const rest = argv.slice(1);
  switch (command) {
    case "preflight":
      return preflightCommand();
    case "plan":
      await planCommand({ ...parseArgs(rest, PLAN_FLAGS), command });
      return 0;
    case "smoke":
      await smokeCommand({ ...parseArgs(rest, SMOKE_FLAGS), command });
      return 0;
    case "run":
      await runCommand({ ...parseArgs(rest, RUN_FLAGS), command });
      return 0;
    case "evaluate":
      await evaluateCommand({ ...parseArgs(rest, EVALUATE_FLAGS), command });
      return 0;
    default:
      console.error(`arcbench: unknown command ${JSON.stringify(command)}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof CliError) {
      console.error(e.message);
      process.exit(e.exitCode);
    }
    console.error(e);
    process.exit(1);
  },
);
