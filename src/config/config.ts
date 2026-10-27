/**
 * The benchmark's fixed settings (`config/benchmark.json`).
 *
 * Everything that is an experimental factor is a CLI flag (`src/cli/`), never a key here: this file
 * holds what every run shares -- seed, sampling temperature, pi's pinned revision and budgets, the
 * filler corpus size, request limits. The values are the ones every 17-case study ran with, so a
 * command that reproduces a past configuration needs no config edit.
 */
import { existsSync, readFileSync } from "node:fs";
import type { HaystackArmId } from "../harness/schema.ts";
import type { StrategyId } from "../compaction/strategy-ids.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from this file so commands work from any working directory. */
export const REPO_ROOT = join(__dirname, "../..");

export type HaystackDelivery = "single-tool-result" | "chunked-tool-results" | "user-message";
export type CompactionStrategy = "legacy-fixed-cut" | StrategyId;

export interface HaystackArm {
  id: HaystackArmId;
  delivery: HaystackDelivery;
  chunkChars: number | null;
  /** Exactly one arm must be the reference. */
  reference: boolean;
}

export interface CompactionSettings {
  harnessBoundary: { retainedTailTokens: number; cutAt: string; calibrationStatus: string };
  /** Prefix allowance for `select` arms, separate from the cut. */
  selectionBudget?: { defaultTokens: number; perStrategyTokens?: Record<string, number> };
  summarizerMaxTokens: number;
  responseAllowanceTokens: number;
}

export interface BenchmarkConfig {
  seed: number;
  temperature: number;
  reasoningEffort: "low" | "medium" | "high";
  /** The model the study design pinned; provenance records any deviation from it. */
  specPinnedModel: string;

  /** The pi build vendored in vendor/pi/ (git commit); stamped into every row's provenance. */
  piRevision: string;
  /** pi's `keepRecentTokens`: a tuned constant, not a factor. */
  keepRecentTokens: number;
  reserveTokens: number;

  openrouterBaseUrl: string;
  requestConcurrency: number;
  requestTimeoutMs: number;
  maxTransientRetries: number;
  retryBaseDelayMs: number;
  /** Model turns allowed per decision trajectory before it is cut off and flagged. */
  maxToolSteps: number;
  freeModelConcurrency: number;
  freeModelDelayMs: number;
  /** Per-model throughput pins; a scheduling decision, never an experimental one. */
  perModelThroughput?: Record<string, { concurrency: number; delayMs: number }>;

  haystackArms: HaystackArm[];
  haystackTargetChars: number;
  needleKeyPrefix: string;
  /** The filler/attack block is inserted after this many benign user turns. */
  haystackInsertionTurn: number;

  trajectoryRecording: boolean;
  trajectoryHaystackMode: "reference" | "inline";

  compaction: CompactionSettings;

  /**
   * Legacy provenance fields. Modules read `cfg.policyChannel` and `cfg.compactionStrategy` only to
   * stamp provenance; the engine sets them per cohort so a reproduced row records exactly what the
   * original study recorded (`src/plan/cohorts.ts`).
   */
  policyChannel: string;
  compactionStrategy: CompactionStrategy | "none";
  /** Fallback summarizer for provenance when no model is passed; never drives a call. */
  summarizerModel: string;
  /** Fallback agent for provenance when no model is passed; never drives a call. */
  agentModel: string;
}

/** Alias for modules that name the config `MvpConfig`; the benchmark has one config type. */
export type MvpConfig = BenchmarkConfig;

const REQUIRED_KEYS: Array<keyof BenchmarkConfig> = [
  "seed",
  "temperature",
  "reasoningEffort",
  "specPinnedModel",
  "piRevision",
  "keepRecentTokens",
  "reserveTokens",
  "openrouterBaseUrl",
  "requestConcurrency",
  "requestTimeoutMs",
  "maxTransientRetries",
  "retryBaseDelayMs",
  "maxToolSteps",
  "freeModelConcurrency",
  "freeModelDelayMs",
  "haystackArms",
  "haystackTargetChars",
  "needleKeyPrefix",
  "haystackInsertionTurn",
  "trajectoryRecording",
  "trajectoryHaystackMode",
  "compaction",
];

export const CONFIG_PATH = join(REPO_ROOT, "config/benchmark.json");

let _config: BenchmarkConfig | null = null;

export function loadConfig(path: string = CONFIG_PATH): BenchmarkConfig {
  if (_config && path === CONFIG_PATH) return _config;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BenchmarkConfig>;

  // A missing pinned field is a configuration error, not a silent default.
  const missing = REQUIRED_KEYS.filter((k) => parsed[k] === undefined || parsed[k] === null);
  if (missing.length > 0) {
    throw new Error(`${path} missing required field(s): ${missing.join(", ")}`);
  }
  assertHaystackArms(parsed.haystackArms!);
  if (parsed.compaction!.harnessBoundary.calibrationStatus === "uncalibrated") {
    throw new Error(
      "compaction.harnessBoundary is uncalibrated. The harness cut must reproduce pi's before any run.",
    );
  }

  const cfg: BenchmarkConfig = {
    ...(parsed as BenchmarkConfig),
    // Provenance defaults; the engine overrides them per cohort.
    policyChannel: parsed.policyChannel ?? "c1",
    compactionStrategy: parsed.compactionStrategy ?? "pi-native-cut",
    summarizerModel: parsed.summarizerModel ?? "",
    agentModel: parsed.agentModel ?? "",
  };
  if (path === CONFIG_PATH) _config = cfg;
  return cfg;
}

/**
 * The Python interpreter for metrics: `ARCBENCH_PYTHON` if set, else the repo's `.venv` (created
 * by scripts/setup.sh), else `python3` on PATH.
 */
export function pythonExecutable(): string {
  const fromEnv = process.env["ARCBENCH_PYTHON"];
  if (fromEnv) return fromEnv;
  const venv = join(REPO_ROOT, ".venv/bin/python3");
  return existsSync(venv) ? venv : "python3";
}

/** Alias of `loadConfig`, for modules that still call it by this name. */
export const loadMvpConfig = (): BenchmarkConfig => loadConfig();

/** The compaction block. */
export function compactionSettings(cfg: BenchmarkConfig): CompactionSettings {
  return cfg.compaction;
}

/**
 * The allowance one `select` arm gets, in estimated tokens.
 *
 * Reads the shared default unless `perStrategyTokens` names this arm. Returning 0 for an absent
 * block is deliberate: a missing allowance must shrink context, never silently grant one.
 */
export function selectionBudgetFor(settings: CompactionSettings, strategyId: string): number {
  const b = settings.selectionBudget;
  if (!b) return 0;
  const override = b.perStrategyTokens?.[strategyId];
  const tokens = override ?? b.defaultTokens;
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new Error(`compaction.selectionBudget for ${strategyId} is not a non-negative number: ${tokens}`);
  }
  return tokens;
}

/** OpenRouter `:free` variants are rate-limited hard; back off rather than hammering them. */
export function isFreeModel(model: string): boolean {
  return model.endsWith(":free");
}

export function throughputFor(model: string, cfg: BenchmarkConfig): { concurrency: number; delayMs: number } {
  // An explicit per-model override wins over the `:free` heuristic.
  const override = cfg.perModelThroughput?.[model];
  if (override) return override;
  return isFreeModel(model)
    ? { concurrency: cfg.freeModelConcurrency, delayMs: cfg.freeModelDelayMs }
    : { concurrency: cfg.requestConcurrency, delayMs: 0 };
}

/** Filesystem- and id-safe form of a model slug, for run ids and results directories. */
export function modelSlug(model: string): string {
  return model.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

/**
 * pi's per-tool-result cap, mirrored for the derived-coverage arithmetic only.
 *
 * The authoritative value is `TOOL_RESULT_MAX_CHARS` in pi's compaction utils, which pi does not
 * export. It is stamped into every result row as `toolResultMaxChars`.
 */
export const PI_TOOL_RESULT_MAX_CHARS = 2000;

/**
 * How many corpus chars an arm actually delivers to pi's summarizer.
 *
 * The cap applies per tool result, so chunk count -- not corpus size -- sets summarizer-side
 * volume. The per-chunk header counts against the same 2,000-char budget.
 */
export function haystackCharsReachingSummarizer(
  arm: HaystackArm,
  corpusChars: number,
  headerChars = 0,
): number {
  if (arm.delivery === "user-message") return corpusChars;
  const window = Math.max(0, PI_TOOL_RESULT_MAX_CHARS - headerChars);
  if (arm.delivery === "single-tool-result") return Math.min(corpusChars, window);
  const chunk = arm.chunkChars;
  if (chunk === null) throw new Error(`haystack arm ${arm.id}: chunked delivery requires chunkChars`);
  const chunks = Math.ceil(corpusChars / chunk);
  let total = 0;
  for (let i = 0; i < chunks; i++) {
    const body = Math.min(chunk, corpusChars - i * chunk);
    total += Math.min(body, window);
  }
  return total;
}

/** The largest chunk body that still fits under pi's cap once the header is prepended. */
export function untruncatedChunkChars(headerChars: number): number {
  return PI_TOOL_RESULT_MAX_CHARS - headerChars;
}

/** Exactly one reference arm, unique ids, and chunkChars present iff the arm is chunked. */
export function assertHaystackArms(arms: HaystackArm[]): void {
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new Error("haystackArms must be a non-empty array");
  }
  const ids = new Set<string>();
  for (const arm of arms) {
    if (ids.has(arm.id)) throw new Error(`duplicate haystack arm id ${arm.id}`);
    ids.add(arm.id);
    const chunked = arm.delivery === "chunked-tool-results";
    if (chunked && (arm.chunkChars === null || arm.chunkChars === undefined)) {
      throw new Error(`haystack arm ${arm.id}: chunked-tool-results requires chunkChars`);
    }
    if (!chunked && arm.chunkChars !== null) {
      throw new Error(`haystack arm ${arm.id}: ${arm.delivery} must have chunkChars null`);
    }
  }
  const refs = arms.filter((a) => a.reference);
  if (refs.length !== 1) {
    throw new Error(`haystackArms must declare exactly one reference arm, found ${refs.length}`);
  }
}

/** Provenance stamped into every result row so a table can never lose its pinned inputs. */
export interface RunProvenance {
  piRevision: string;
  agentModel: string;
  summarizerModel: string;
  specPinnedModel: string;
  modelDeviatesFromSpec: boolean;
  temperature: number;
  seed: number;
  policyChannel: string;
  compactionStrategy: CompactionStrategy | "none";
  keepRecentTokens: number;
  reserveTokens: number;
  haystackArm: HaystackArmId | null;
  haystackDelivery: HaystackDelivery | null;
  haystackChunkChars: number | null;
  haystackCharsReachingSummarizer: number | null;
  haystackInsertionTurn: number;
  toolResultMaxChars: number;
}

/**
 * Build a row's provenance. Field order is the historical one (rows reproduced under a legacy
 * cohort must read field-for-field like the originals).
 *
 * `summarizerModel` is the compactor model; it equals the agent model unless `--compactor_model`
 * says otherwise.
 */
export function buildProvenance(
  cfg: BenchmarkConfig,
  model?: string,
  arm?: HaystackArm | null,
  corpusChars?: number,
  headerChars = 0,
  compactorModel?: string,
): RunProvenance {
  const runModel = model ?? cfg.agentModel;
  return {
    piRevision: cfg.piRevision,
    agentModel: runModel,
    summarizerModel: compactorModel ?? model ?? cfg.summarizerModel,
    specPinnedModel: cfg.specPinnedModel,
    modelDeviatesFromSpec: runModel !== cfg.specPinnedModel,
    temperature: cfg.temperature,
    seed: cfg.seed,
    policyChannel: cfg.policyChannel,
    compactionStrategy: cfg.compactionStrategy,
    keepRecentTokens: cfg.keepRecentTokens,
    haystackArm: arm?.id ?? null,
    haystackDelivery: arm?.delivery ?? null,
    haystackChunkChars: arm?.chunkChars ?? null,
    haystackCharsReachingSummarizer:
      arm && corpusChars !== undefined
        ? haystackCharsReachingSummarizer(arm, corpusChars, headerChars)
        : null,
    haystackInsertionTurn: cfg.haystackInsertionTurn,
    toolResultMaxChars: PI_TOOL_RESULT_MAX_CHARS,
    reserveTokens: cfg.reserveTokens,
  };
}

/** Test seam: drop the memoised config so a test can reload after mutating the file. */
export function _resetConfigCacheForTests(): void {
  _config = null;
}
