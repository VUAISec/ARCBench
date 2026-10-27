/**
 * Write scripts/rqN/sM-<name>/run.sh for every study in src/rq/studies.ts.
 *
 *   tsx src/rq/generate-scripts.ts           # (re)write the scripts
 *   tsx src/rq/generate-scripts.ts --check   # exit 1 if any script is out of date
 *
 * The scripts are plain lists of `./arcbench run` commands so they can be read, edited and resumed
 * by hand. tests/rq-scripts.test.ts fails if they drift from studies.ts. Each study's analyze.py
 * (next to its run.sh) is written by hand, not generated.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../config/config.ts";
import { STUDIES, type Flags, type Study } from "./studies.ts";

const FLAG_ORDER = [
  "agent_model",
  "compactor_model",
  "compaction_strategies",
  "compaction_budget",
  "rule_present",
  "rule_channel",
  "filler",
  "injection_attack_method",
  "defense_method",
  "repetitions",
  "cohort",
];

function command(flags: Flags): string {
  const parts = FLAG_ORDER.filter((k) => flags[k] !== undefined).map((k) => `--${k} ${flags[k]}`);
  return `./arcbench run ${parts.join(" ")} --out "$OUT" --resume`;
}

function labelOf(dir: string): string {
  return STUDIES.find((s) => s.dir === dir)!.label;
}

export function studyScript(study: Study): string {
  const head = [
    "#!/usr/bin/env bash",
    `# ${study.label} (${study.rq}): ${study.title}`,
    "#",
    "# Generated from src/rq/studies.ts by src/rq/generate-scripts.ts -- edit that file, not this one.",
  ];
  if (study.commands.length === 0) {
    // A study with no runs of its own (S2): its runs are another study's.
    const source = study.reads[0]!;
    return [
      ...head,
      `# ${study.label} has no runs of its own: it re-runs ${labelOf(source)}. Needs OPENROUTER_API_KEY.`,
      "set -euo pipefail",
      'cd "$(dirname "${BASH_SOURCE[0]}")/../../.."',
      `exec scripts/${source}/run.sh "$@"`,
      "",
    ].join("\n");
  }
  const lines = [
    ...head,
    `# Re-runs the configuration of results/${study.dir}/ into runs/${study.dir}/ (override with OUT=...).`,
    `# ${study.commands.length} commands${study.borrowed.length ? ` + ${study.borrowed.length} borrowed` : ""}. Needs OPENROUTER_API_KEY.`,
    "# Every command is --resume, so an interrupted script can simply be run again.",
    "set -euo pipefail",
    'cd "$(dirname "${BASH_SOURCE[0]}")/../../.."',
    `OUT="\${OUT:-runs/${study.dir}}"`,
    "",
    ...study.commands.map(command),
  ];
  if (study.borrowed.length > 0) {
    const from = study.reads.map(labelOf).join(" and ");
    lines.push(
      "",
      `# Cells this study uses but does not run: its released rows for them are ${from}'s. They run here`,
      "# so the study stands alone; SKIP_BORROWED=1 leaves them out (and reuses the other study's rows).",
      'if [ "${SKIP_BORROWED:-0}" != "1" ]; then',
      ...study.borrowed.map((f) => `  ${command(f)}`),
      "fi",
    );
  }
  lines.push("", "# Metrics over this run:", `./arcbench evaluate --results "$OUT"`);
  return lines.join("\n") + "\n";
}

export function expectedScripts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of STUDIES) out.set(join("scripts", s.dir, "run.sh"), studyScript(s));
  return out;
}

const check = process.argv.includes("--check");
if (process.argv[1]?.endsWith("generate-scripts.ts")) {
  let stale = 0;
  for (const [rel, text] of expectedScripts()) {
    const path = join(REPO_ROOT, rel);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === text) continue;
    if (check) {
      console.error(`stale: ${rel}`);
      stale++;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, { mode: 0o755 });
      console.log(`wrote ${rel}`);
    }
  }
  process.exit(stale === 0 ? 0 : 1);
}
