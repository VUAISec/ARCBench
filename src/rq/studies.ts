/**
 * The seven studies of the paper (Table "studies"), grouped by research question, as lists of
 * `./arcbench run` commands.
 *
 * Each study is the configuration its sweep ran, one configuration per command. The run scripts
 * scripts/rqN/sM-<name>/run.sh are generated from this file (`npm run rq:scripts`), and
 * tests/golden-plan.test.ts plans every command and compares the episodes with the rows the study
 * holds in results/rqN/sM-<name>/. So this file is both the recipe and the thing the equivalence
 * proof checks.
 *
 * Every run is stored once, in the first study that uses it. A study that reuses another study's
 * runs lists them under `borrowed` (commands it does not run itself; SKIP_BORROWED=1 leaves them
 * out of its script) and names the study under `reads`.
 */
export type Flags = Record<string, string>;

export interface Study {
  /** "s1-baseline" ... "s7-defense". */
  id: string;
  /** "S1 Baseline", as in the paper's study table. */
  label: string;
  rq: "RQ1" | "RQ2" | "RQ3";
  /** Directory under results/ (the released rows) and under runs/ (a re-run). */
  dir: string;
  title: string;
  commands: Flags[];
  /** Cells this study uses but does not run: they were run by the studies in `reads`. */
  borrowed: Flags[];
  /** Other study directories whose rows this study's analysis reads. */
  reads: string[];
}

export const MODELS = [
  "~openai/gpt-luna-latest",
  "deepseek/deepseek-v4-flash-0731",
  "z-ai/glm-5.3-flash",
  "qwen/qwen3.7-flash",
];
export const BUDGET_MODELS = ["deepseek/deepseek-v4-flash-0731", "z-ai/glm-5.3-flash"];
export const ATTACK_MODEL = "z-ai/glm-5.3-flash";

export const STRATEGIES = [
  "pi-native-cut",
  "pi-native-policy-preserving",
  "baseline-structured-summary",
  "prompting-h",
  "acon-ut",
  "acon-utco",
  "trace-optimized",
  "fifo",
  "lru-mechanism",
  "lru-prompting",
];
export const GENERATIVE_STRATEGIES = STRATEGIES.slice(0, 7);
export const BUDGETS = ["200", "300", "750", "1200", "2500"];
export const ATTACKS = ["none", "legacy", "naive", "escape", "ignore", "fake-completion", "combined"];
export const DEFENSES = ["isolation", "instructional", "sandwich", "rule-preserving"];

/** Ladder conditions as factor flags: G1 full context, G2 compacted, G3 + volume injection, G4 + the
 * compactor-targeted injection, G5 both. All with the rule present, on each case's two home channels. */
function ladder(model: string, conditions: Array<"G1" | "G2" | "G3" | "G4" | "G5">): Flags[] {
  const rule = { agent_model: model, repetitions: "3", cohort: "v1.1-ladder", rule_present: "yes", rule_channel: "home-paired" };
  const hermes = { compaction_strategies: "prompting-h" };
  const all: Record<string, Flags> = {
    G1: { ...rule, compaction_strategies: "none" },
    G2: { ...rule, ...hermes },
    G3: { ...rule, ...hermes, filler: "yes" },
    G4: { ...rule, ...hermes, injection_attack_method: "legacy" },
    G5: { ...rule, ...hermes, filler: "yes", injection_attack_method: "legacy" },
  };
  return conditions.map((c) => all[c]!);
}

const ADDED_CONTENT = [
  { filler: "no", injection_attack_method: "none" },
  { filler: "no", injection_attack_method: "legacy" },
  { filler: "yes", injection_attack_method: "none" },
  { filler: "yes", injection_attack_method: "legacy" },
];

function strategies(): { commands: Flags[]; borrowed: Flags[] } {
  const commands: Flags[] = [];
  const borrowed: Flags[] = [];
  for (const model of MODELS) {
    const base = { agent_model: model, repetitions: "3", cohort: "v1.3-newcase-v1.2strategies", rule_channel: "home" };
    for (const s of ["none", ...STRATEGIES]) {
      for (const fa of ADDED_CONTENT) {
        const cmd = { ...base, compaction_strategies: s, ...fa };
        // Cells S1 and S5 already measured identically (plan/layout-equivalence.ts): full context
        // without added content (G1) and Hermes without added content / with volume injection / with
        // both injections (G2, G3, G5). Hermes with the injection alone (G4) is NOT one of them.
        const plain = fa.filler === "no" && fa.injection_attack_method === "none";
        const coveredByLadder =
          (s === "none" && plain) ||
          (s === "prompting-h" && !(fa.filler === "no" && fa.injection_attack_method === "legacy"));
        (coveredByLadder ? borrowed : commands).push(cmd);
      }
    }
  }
  return { commands, borrowed };
}

function budget(): { commands: Flags[]; borrowed: Flags[] } {
  const commands: Flags[] = [];
  const borrowed: Flags[] = [];
  for (const model of BUDGET_MODELS) {
    const base = { agent_model: model, repetitions: "3", cohort: "v1.4-token-constraint", rule_channel: "home", filler: "yes", injection_attack_method: "none" };
    for (const s of GENERATIVE_STRATEGIES) {
      for (const b of BUDGETS) commands.push({ ...base, compaction_strategies: s, compaction_budget: b });
      // No compaction budget constraint: S3's runs with volume injection.
      borrowed.push({ ...base, compaction_strategies: s, compaction_budget: "none" });
    }
    // The full-context baseline: S3's full-context runs with volume injection.
    borrowed.push({ ...base, compaction_strategies: "none" });
  }
  return { commands, borrowed };
}

function attacks(defenses: string[], attackList: string[]): Flags[] {
  const base = { agent_model: ATTACK_MODEL, repetitions: "6", cohort: "v1.6-ipi-attack-defense", rule_channel: "home", compaction_strategies: "prompting-h" };
  return attackList.flatMap((attack) => defenses.map((defense) => ({ ...base, injection_attack_method: attack, defense_method: defense })));
}

function attackBaselines(): Flags[] {
  const base = { agent_model: ATTACK_MODEL, repetitions: "6", cohort: "v1.6-ipi-attack-defense", rule_channel: "home", compaction_strategies: "none" };
  return ATTACKS.map((attack) => ({ ...base, injection_attack_method: attack }));
}

const s3 = strategies();
const s4 = budget();
const S1_DIR = "rq1/s1-baseline";
const S3_DIR = "rq2/s3-strategy";
const S5_DIR = "rq3/s5-injection";
const S6_DIR = "rq3/s6-attack";

export const STUDIES: Study[] = [
  {
    id: "s1-baseline",
    label: "S1 Baseline",
    rq: "RQ1",
    dir: S1_DIR,
    title: "Hermes, four agent models, c1-c4, full context and compacted, no added content",
    commands: MODELS.flatMap((m) => ladder(m, ["G1", "G2"])),
    borrowed: [],
    reads: [],
  },
  {
    id: "s2-channel",
    label: "S2 Channel",
    rq: "RQ2",
    dir: "rq2/s2-channel",
    title: "Rule delivery channel: S1's runs grouped by delivery channel (no runs of its own)",
    commands: [],
    borrowed: MODELS.flatMap((m) => ladder(m, ["G1", "G2"])),
    reads: [S1_DIR],
  },
  {
    id: "s3-strategy",
    label: "S3 Strategy",
    rq: "RQ2",
    dir: S3_DIR,
    title: "Ten compaction strategies x added content (none, I, V, V+I), four agent models, c1/c3",
    commands: s3.commands,
    borrowed: s3.borrowed,
    reads: [S1_DIR, S5_DIR],
  },
  {
    id: "s4-budget",
    label: "S4 Budget",
    rq: "RQ2",
    dir: "rq2/s4-budget",
    title: "Seven generative strategies x five compaction budgets, volume injection, DeepSeek and GLM, c1/c3",
    commands: s4.commands,
    borrowed: s4.borrowed,
    reads: [S3_DIR],
  },
  {
    id: "s5-injection",
    label: "S5 Injection",
    rq: "RQ3",
    dir: S5_DIR,
    title: "Hermes with volume injection, the compactor-targeted injection, and both, four agent models, c1-c4",
    commands: MODELS.flatMap((m) => ladder(m, ["G3", "G4", "G5"])),
    borrowed: MODELS.flatMap((m) => ladder(m, ["G1", "G2"])),
    reads: [S1_DIR],
  },
  {
    id: "s6-attack",
    label: "S6 Attack",
    rq: "RQ3",
    dir: S6_DIR,
    title: "Six compactor-targeted injection attacks and no attack, no defense, with full-context baselines, GLM, k = 6",
    commands: [...attackBaselines(), ...attacks(["none"], ATTACKS)],
    borrowed: [],
    reads: [],
  },
  {
    id: "s7-defense",
    label: "S7 Defense",
    rq: "RQ3",
    dir: "rq3/s7-defense",
    title: "Four defenses with no attack and under escape, GLM, k = 6",
    commands: attacks(DEFENSES, ["none", "escape"]),
    borrowed: [
      ...attackBaselines().filter((f) => ["none", "escape"].includes(f["injection_attack_method"]!)),
      ...attacks(["none"], ["none", "escape"]),
    ],
    reads: [S6_DIR],
  },
];

export function studyById(id: string): Study {
  const study = STUDIES.find((x) => x.id === id);
  if (!study) throw new Error(`unknown study ${id}`);
  return study;
}
