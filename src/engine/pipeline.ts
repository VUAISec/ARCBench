/**
 * The episode pipeline: one path from rule delivery to a graded, recorded row.
 *
 *   channels.deliver → context.assemble → compaction.compact → rule-loss.decide → grade → record
 *
 * One path serves both row shapes: the v1.1 ladder and v1.2 onward (with the v1.4 budget and v1.6
 * attack/defense hooks). The steps run in one fixed order; what differs by cohort is kept to a few
 * places, each marked `[v1.1 rows]` or `[v1.2 rows]`:
 *
 *   - transcript layout (G4's attack position)                 context.assemble
 *   - the trajectory's meta events                             after assembly
 *   - full-context request verification                        [v1.2 rows]
 *   - needle probe, rule-visibility check                      [v1.1 rows]
 *   - a refused summarizer still reaches the agent (invalid)   [v1.1 rows]
 *   - row shape and validity rules                             record
 *
 * Two deliberate unifications, both inert for every past study:
 *   - c2/c4 placement is always a live agent call. v1.2-onward sweeps only used c1/c3.
 *   - the compactor model is a separate input. Every past study used the agent model.
 */
import { join } from "node:path";
import {
  buildProvenance,
  compactionSettings,
  haystackCharsReachingSummarizer,
  PI_TOOL_RESULT_MAX_CHARS,
  selectionBudgetFor,
  throughputFor,
  type BenchmarkConfig,
  type HaystackArm,
} from "../config/config.ts";
import {
  buildCondition,
  hasPolicy,
  HAYSTACK_HEADER_CHARS,
  policyPresentInContext,
  referenceArm,
} from "../context/transcript-v11.ts";
import { buildConditionV12 } from "../context/transcript-v12.ts";
import { placePolicyViaModel } from "../channels/live-placement.ts";
import { expectedToolFor, isLiveChannel } from "../channels/policy-channels.ts";
import { TrajectoryWriter, type HaystackRef } from "../harness/trajectory.ts";
import { buildToolStub } from "../harness/toolstub.ts";
import type {
  CanonicalMessage,
  CompactionArtifact,
  InvalidReason,
  NeedleRecord,
  NormalizedResult,
} from "../harness/schema.ts";
import type { TaskRow } from "../rule-loss/dataset.ts";
import {
  canonicalToOpenAI,
  evaluateGovernance,
  ProtocolError,
  type EvalResult,
  type EvalRun,
} from "../rule-loss/evaluator.ts";
import { gradeGovernance } from "../rule-loss/grader.ts";
import {
  CompactionFailure,
  PiNativeCompactor,
  summaryPreservesPolicy,
} from "../compaction/pi-native.ts";
import { driveHarnessCompaction, HarnessCompactionError } from "../compaction/harness-driver.ts";
import { buildHarnessStrategy, definitionFor, type StrategyDeps } from "../compaction/registry.ts";
import {
  checkWindowFit,
  contextWindowFor,
  estimateRequestTokens,
  verifyFullContext,
  type FullContextCheck,
} from "../compaction/full-context.ts";
import { estimateTokens } from "../compaction/boundary.ts";
import {
  computeFloorTokens,
  piBudgetRequestFields,
  piNativeImplementation,
  resolveBudget,
  truncateToBudget,
  type BudgetBinding,
} from "../compaction/budget.ts";
import { usesPiSessionPath, type StrategyId } from "../compaction/strategy-ids.ts";
import { extractSchemaSection } from "../compaction/constraints-section.ts";
import { buildNormalizedResult, type CompactionRecord, type RunRecord } from "../record/row-v11.ts";
import type { V12Result } from "../record/row-v12.ts";
import { cohortFor } from "../plan/cohorts.ts";
import type { Episode } from "../plan/episodes.ts";
import { batches, DEFAULT_BATCH_SIZE } from "./resume.ts";

export type ResultRow = V12Result | NormalizedResult;

export interface EngineOptions {
  cfg: BenchmarkConfig;
  apiKey: string;
  /** The agent model's directory: `<out>/<model-slug>`. Trajectories go under `raw/`. */
  resultsDir: string;
  rows: ReadonlyMap<string, TaskRow>;
  deps: StrategyDeps;
  onProgress?: (message: string) => void;
  /** Handed each batch's rows as soon as they exist, so they are on disk before the next batch. */
  onResults?: (rows: ResultRow[]) => Promise<void> | void;
  batchSize?: number;
  /** Raise per-model request concurrency for this run; never widens a pinned model. */
  concurrencyOverride?: number;
}

/** `throughputFor`, plus an optional per-run raise that never widens a pinned model. */
function resolveThroughput(
  model: string,
  cfg: BenchmarkConfig,
  override: number | undefined,
): { concurrency: number; delayMs: number } {
  const base = throughputFor(model, cfg);
  if (override === undefined || cfg.perModelThroughput?.[model]) return base;
  return { concurrency: override, delayMs: base.delayMs };
}

interface Built {
  systemPrompt: string;
  messages: CanonicalMessage[];
  policyEntryId: string | null;
  taskInstructionEntryId: string;
  taskInstruction: string;
  trigger: string;
  tools: TaskRow["tools"];
  needle: Omit<NeedleRecord, "needleInSummary"> | null;
}

interface Prepared {
  episode: Episode;
  row: TaskRow;
  built: Built;
  /** The provenance-facing config: shared settings with this cohort's legacy provenance fields. */
  cohortCfg: BenchmarkConfig;
  arm: HaystackArm | null;
  artifact: CompactionArtifact | null;
  decisionMessages: CanonicalMessage[];
  fullContext: FullContextCheck | null;
  failedReason: InvalidReason | null;
  failureDetail: string | null;
  needle: NeedleRecord | null;
  policyPresentAtDecision: boolean | null;
  policyChannelSatisfied: boolean | null;
  prepareMs: number;
  trajectory: TrajectoryWriter;
}

/**
 * The haystack corpus is deterministic from (seed, task, repetition), so a v1.1 trajectory stores a
 * reference plus each entry's slice bounds rather than the bytes.
 */
function haystackRefFactory(
  built: Built,
  episode: Episode,
): ((m: CanonicalMessage) => HaystackRef | null) | undefined {
  const needle = built.needle;
  if (!needle) return undefined;
  let cursor = 0;
  return (m) => {
    if (m.role !== "tool" || !m.entryId.includes("-haystack")) return null;
    const body = Math.max(0, m.content.length - HAYSTACK_HEADER_CHARS);
    const ref: HaystackRef = {
      kind: "haystack",
      corpusId: needle.corpusId,
      corpusSha256: needle.corpusSha256,
      corpusChars: needle.corpusChars,
      seed: needle.seed,
      taskId: episode.caseId,
      repetition: episode.repetition,
      sliceStart: cursor,
      sliceEnd: cursor + body,
      headerChars: HAYSTACK_HEADER_CHARS,
      chars: m.content.length,
    };
    cursor += body;
    return ref;
  };
}

function placeholderBuilt(row: TaskRow): Built {
  return {
    systemPrompt: row.system_prompt,
    messages: [],
    policyEntryId: null,
    taskInstructionEntryId: "",
    taskInstruction: "",
    trigger: row.trigger,
    tools: row.tools,
    needle: null,
  };
}

async function executeBatch(episodes: Episode[], opts: EngineOptions): Promise<ResultRow[]> {
  const { cfg, apiKey, resultsDir } = opts;
  const log = opts.onProgress ?? (() => {});
  const settings = compactionSettings(cfg);
  const agentModel = episodes[0]!.configuration.agentModel;
  const { concurrency, delayMs } = resolveThroughput(agentModel, cfg, opts.concurrencyOverride);
  const prepared: Prepared[] = new Array(episodes.length);

  async function prepareOne(index: number): Promise<void> {
    const episode = episodes[index];
    if (!episode) return;
    const c = episode.configuration;
    const row = opts.rows.get(episode.caseId);
    if (!row) throw new Error(`episode ${episode.runId} references unknown case ${episode.caseId}`);
    const startedAt = Date.now();
    const cohortCfg: BenchmarkConfig = { ...cfg, ...cohortFor(c.cohort).provenance(c, episode.channel) } as BenchmarkConfig;
    const arm = c.filler ? referenceArm(cfg) : null;
    const trajectory = new TrajectoryWriter(join(resultsDir, "raw", episode.runId), cfg.trajectoryRecording !== false);
    const v11 = episode.rowShape === "v1.1";

    const base: Omit<Prepared, "built" | "artifact" | "decisionMessages" | "failedReason" | "failureDetail" | "prepareMs"> = {
      episode, row, cohortCfg, arm, fullContext: null, needle: null,
      policyPresentAtDecision: null, policyChannelSatisfied: null, trajectory,
    };

    // ---- 1. deliver the rule: c2/c4 need the agent to place it, before anything else ----
    let liveChannelResult: { toolCallId: string; writtenContent: string } | null = null;
    let policyChannelSatisfied: boolean | null = null;
    try {
      if (c.rulePresent && episode.channel && isLiveChannel(episode.channel)) {
        const placed = await placePolicyViaModel({
          row,
          channel: episode.channel,
          model: c.agentModel,
          apiKey,
          baseUrl: cfg.openrouterBaseUrl,
          temperature: cfg.temperature,
          requestTimeoutMs: cfg.requestTimeoutMs,
          maxTransientRetries: cfg.maxTransientRetries,
          retryBaseDelayMs: cfg.retryBaseDelayMs,
        });
        policyChannelSatisfied = placed.satisfied;
        liveChannelResult = placed.liveResult;
        trajectory.record({
          type: "policy_channel_step",
          channel: episode.channel,
          expectedTool: expectedToolFor(episode.channel),
          observedToolCalls: placed.observedToolCalls,
          writtenContent: placed.writtenContent,
          satisfied: placed.satisfied,
          usage: placed.usage,
          latencyMs: placed.latencyMs,
        });
        if (!placed.satisfied) {
          log(
            `  ${episode.runId}: policy channel ${episode.channel} unsatisfied` +
              (placed.transportError ? ` (${placed.transportError})` : " (model made no such call)"),
          );
        }
      }
    } catch (e) {
      log(`  ${episode.runId}: rule delivery failed: ${String(e)}`);
      prepared[index] = {
        ...base, built: placeholderBuilt(row), artifact: null, decisionMessages: [],
        failedReason: "downstream_failure", failureDetail: String(e).slice(0, 1000),
        prepareMs: Date.now() - startedAt,
      };
      return;
    }

    // ---- 2. assemble the history ----
    let built: Built;
    try {
      built = v11
        ? buildCondition({
            row,
            condition: episode.legacyCondition!,
            repetition: episode.repetition,
            cfg: cohortCfg,
            arm: referenceArm(cfg),
            ...(episode.channel ? { channel: episode.channel } : {}),
            liveChannelResult,
          })
        : buildConditionV12({
            row,
            spec: episode.spec!,
            repetition: episode.repetition,
            cfg,
            liveChannelResult,
            ...(c.attack !== "none" ? { attackTechnique: c.attack } : {}),
          });
    } catch (e) {
      // One construction fault costs ONE row, never the batch.
      log(`  ${episode.runId}: construction failed: ${String(e)}`);
      prepared[index] = {
        ...base, built: placeholderBuilt(row), artifact: null, decisionMessages: [],
        failedReason: "downstream_failure", failureDetail: String(e).slice(0, 1000),
        prepareMs: Date.now() - startedAt, policyChannelSatisfied,
        // [v1.1 rows] a construction failure opens no trajectory, as in the v1.1 sweeps.
        trajectory: v11 ? new TrajectoryWriter(join(resultsDir, "raw", episode.runId), false) : trajectory,
      };
      return;
    }

    // ---- 3. meta events ----
    if (v11) {
      trajectory.record({
        type: "run_meta",
        runId: episode.runId,
        condition: episode.legacyCondition!,
        policyChannel: episode.channel,
        haystackArm: arm?.id ?? null,
        taskId: episode.caseId,
        repetition: episode.repetition,
        model: c.agentModel,
        startedAt: new Date(startedAt).toISOString(),
        config: {
          keepRecentTokens: cfg.keepRecentTokens,
          reserveTokens: cfg.reserveTokens,
          compactionStrategy: episode.plannedV11!.compactionStrategy,
          haystackDelivery: arm ? arm.delivery : null,
          haystackChunkChars: arm ? arm.chunkChars : null,
          haystackCharsReachingSummarizer:
            arm && built.needle
              ? haystackCharsReachingSummarizer(arm, built.needle.corpusChars, HAYSTACK_HEADER_CHARS)
              : null,
          haystackInsertionTurn: cfg.haystackInsertionTurn,
          toolResultMaxChars: PI_TOOL_RESULT_MAX_CHARS,
          piRevision: cfg.piRevision,
          seed: cfg.seed,
          temperature: cfg.temperature,
        },
      });
      trajectory.recordInputMessages(built.messages, haystackRefFactory(built, episode));
    } else {
      trajectory.record({
        type: "v12_run_meta",
        runId: episode.runId,
        protocolVersion: "v1.2",
        configCohort: episode.configCohort,
        sourceTranscriptId: episode.sourceTranscriptId!,
        spec: episode.spec,
        taskId: episode.caseId,
        model: c.agentModel,
        repetition: episode.repetition,
        retainedTailTokens: settings.harnessBoundary.retainedTailTokens,
        summarizerMaxTokens: settings.summarizerMaxTokens,
        ...(c.cohort === "cccb-v1" ? { configuration: c } : {}),
      });
    }

    // ---- 4. compact ----
    let artifact: CompactionArtifact | null = null;
    let decisionMessages = built.messages;
    let fullContext: FullContextCheck | null = null;
    let failedReason: InvalidReason | null = null;
    let failureDetail: string | null = null;
    let needle: NeedleRecord | null = v11 && built.needle ? { ...built.needle, needleInSummary: null } : null;

    if (episode.manualCompactions === 0) {
      if (!v11) {
        // [v1.2 rows] the full-context control is verified at the request boundary.
        const request = canonicalToOpenAI(built.systemPrompt, built.messages, built.trigger);
        const serialized = JSON.stringify(request);
        fullContext = verifyFullContext(built.messages, serialized);
        const fit = checkWindowFit({
          estimatedRequestTokens: estimateRequestTokens(serialized),
          responseAllowanceTokens: settings.responseAllowanceTokens,
          contextWindowTokens: contextWindowFor(c.agentModel),
        });
        trajectory.record({ type: "full_context_check", ...fullContext, ...fit });
        if (!fit.fits) {
          failedReason = "full_context_exceeds_window";
          failureDetail = `${fit.estimatedRequestTokens} + ${fit.responseAllowanceTokens} > ${fit.contextWindowTokens} tokens`;
        } else if (!fullContext.fullContextVerified) {
          failedReason = "full_context_not_verified";
          failureDetail = `missing bodies: ${fullContext.missingEntryIds.slice(0, 5).join(", ")}`;
        }
      }
    } else {
      const strategyId = c.strategy as StrategyId;
      const budgetTokens = c.budget;
      // Legacy cohorts keep the v1.4 ladder check; cccb-v1 declares its own single rung.
      const ladder = c.cohort === "cccb-v1" && budgetTokens !== null ? [budgetTokens] : undefined;
      const binding: BudgetBinding | null =
        budgetTokens === null
          ? null
          : resolveBudget(
              budgetTokens,
              computeFloorTokens({
                messages: built.messages,
                taskInstructionEntryId: built.taskInstructionEntryId,
                retainedTailTokens: settings.harnessBoundary.retainedTailTokens,
              }),
              ladder,
            );
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      try {
        artifact = usesPiSessionPath(strategyId)
          ? await new PiNativeCompactor(resultsDir, row.policy).compact({
              trajectory,
              piRevision: cfg.piRevision,
              runId: episode.runId,
              messages: built.messages,
              policyEntryId: built.policyEntryId,
              systemPrompt: built.systemPrompt,
              model: c.compactorModel,
              baseUrl: cfg.openrouterBaseUrl,
              openrouterApiKey: apiKey,
              reasoningEffort: cfg.reasoningEffort,
              keepRecentTokens: cfg.keepRecentTokens,
              reserveTokens: cfg.reserveTokens,
              strategy: strategyId,
              ...piBudgetRequestFields(strategyId, binding, settings.summarizerMaxTokens),
              maxTransientRetries: cfg.maxTransientRetries,
              retryBaseDelayMs: cfg.retryBaseDelayMs,
            })
          : await driveHarnessCompaction(buildHarnessStrategy(strategyId, opts.deps), {
              runId: episode.runId,
              messages: built.messages,
              policyEntryId: built.policyEntryId,
              taskInstructionEntryId: built.taskInstructionEntryId,
              taskInstruction: built.taskInstruction,
              retainedTailTokens: settings.harnessBoundary.retainedTailTokens,
              selectionBudgetTokens: selectionBudgetFor(settings, strategyId),
              outputBudgetTokens: budgetTokens,
              ...(ladder ? { outputBudgetLadder: ladder } : {}),
              defense: c.defense === "none" ? null : c.defense,
              model: c.compactorModel,
              trajectory,
              // [v1.1 rows] recorded verbatim in the row; the v1.1 adapter built it by template.
              rawArtifactPath: v11
                ? `${resultsDir}/raw/${episode.runId}/harness.jsonl`
                : join(resultsDir, "raw", episode.runId, "harness.jsonl"),
            });
        // pi's summary is produced inside its SDK, so a budget's hard cut happens here. Both pi
        // artifact sites key the summary message `${runId}-summary`, so the text and the context it
        // becomes are cut together.
        if (binding && usesPiSessionPath(strategyId)) {
          const piCut = truncateToBudget(artifact.summary, binding.summaryAllowanceTokens);
          artifact.summary = piCut.text;
          for (const m of artifact.postCompactionMessages) {
            if (m.entryId === `${episode.runId}-summary`) m.content = piCut.text;
          }
          artifact.tokensAfter = estimateTokens(artifact.postCompactionMessages);
          artifact.budget = {
            budgetTokens: binding.budgetTokens,
            budgetFloorTokens: binding.floorTokens,
            summaryAllowanceTokens: binding.summaryAllowanceTokens,
            budgetEffectiveTokens: binding.effectiveTokens,
            budgetFeasible: binding.feasible,
            budgetOverrun: (artifact.tokensAfter ?? 0) > binding.budgetTokens,
            budgetTruncated: piCut.truncated,
            budgetCharsRemoved: piCut.charsRemoved,
          };
        }
        decisionMessages = artifact.postCompactionMessages;
        if (needle) {
          // [v1.1 rows] free deterministic retention probe: is the RULER needle in the summary?
          needle = { ...needle, needleInSummary: artifact.summary.includes(needle.needleValue) };
        }
      } catch (e) {
        failedReason =
          e instanceof CompactionFailure || e instanceof HarnessCompactionError
            ? (e.reason as InvalidReason)
            : "missing_native_compaction";
        failureDetail = String(e).slice(0, 1000);
        log(`  ${episode.runId}: compaction failed (${failedReason}): ${String(e)}`);
      }
    }

    // [v1.1 rows] rule visibility at decision time; null where there is no rule to be visible.
    const policyPresentAtDecision =
      v11 && hasPolicy(episode.legacyCondition!) ? policyPresentInContext(decisionMessages, row.policy) : null;

    // An unsatisfied channel means the condition was never constructed: not an observation.
    if (policyChannelSatisfied === false) failedReason = "policy_channel_unsatisfied";

    prepared[index] = {
      ...base,
      built, artifact, decisionMessages, fullContext, failedReason, failureDetail, needle,
      policyPresentAtDecision, policyChannelSatisfied,
      prepareMs: Date.now() - startedAt,
    };
  }

  log(`  preparing ${episodes.length} episodes (concurrency ${concurrency})`);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, episodes.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= episodes.length) return;
        await prepareOne(i);
      }
    }),
  );

  // ---- 5. decide ----
  // [v1.1 rows] a refused summarizer still goes to the agent on the uncompacted context; the row is
  // kept for inspection but forced invalid. [v1.2 rows] a failed preparation skips evaluation.
  const evaluable = prepared.filter(
    (p) => p && (p.failedReason === null || (p.episode.rowShape === "v1.1" && p.failedReason === "summarizer_refused")),
  );
  const evalRuns: EvalRun[] = evaluable.map((p) => ({
    runId: p.episode.runId,
    systemPrompt: p.built.systemPrompt,
    messages: p.decisionMessages,
    trigger: p.built.trigger,
    tools: p.built.tools,
    gradedTool: p.row.grader.tool,
    stubToolResult: buildToolStub(p.row),
    model: p.episode.configuration.agentModel,
    trajectory: p.trajectory,
  }));

  let evalResults = new Map<string, EvalResult>();
  let evaluationFailure: string | null = null;
  if (evalRuns.length > 0) {
    const t = resolveThroughput(agentModel, cfg, opts.concurrencyOverride);
    log(`  running ${evalRuns.length} decision trajectories (concurrency ${t.concurrency}, max ${cfg.maxToolSteps} steps)`);
    try {
      evalResults = await evaluateGovernance(evalRuns, {
        apiKey,
        baseUrl: cfg.openrouterBaseUrl,
        temperature: cfg.temperature,
        requestConcurrency: t.concurrency,
        requestDelayMs: t.delayMs,
        requestTimeoutMs: cfg.requestTimeoutMs,
        maxTransientRetries: cfg.maxTransientRetries,
        retryBaseDelayMs: cfg.retryBaseDelayMs,
        maxToolSteps: cfg.maxToolSteps,
      });
    } catch (e) {
      // A failure that takes down the whole evaluation marks every run in it as a protocol failure.
      evaluationFailure = e instanceof ProtocolError ? e.message : `evaluation failed: ${String(e)}`;
      log(`  evaluation failed: ${evaluationFailure}`);
    }
  }

  // ---- 6. grade and record ----
  const out: ResultRow[] = [];
  for (const p of prepared) {
    if (!p) continue;
    out.push(p.episode.rowShape === "v1.1" ? await recordV11(p, evalResults, evaluationFailure) : await recordV12(p, evalResults, evaluationFailure, settings.harnessBoundary.retainedTailTokens));
  }
  return out;
}

/** [v1.1 rows] record the v1.1-shape row. */
async function recordV11(
  p: Prepared,
  evalResults: Map<string, EvalResult>,
  evaluationFailure: string | null,
): Promise<NormalizedResult> {
  const evaluated = evalResults.get(p.episode.runId);
  const record: RunRecord = {
    run: p.episode.plannedV11!,
    compaction: p.artifact ? ({ ...p.artifact, backend: p.artifact.backend } as CompactionRecord) : null,
    outcome: null,
    sourceFidelity: p.row.source_fidelity,
    provenance: buildProvenance(p.cohortCfg, p.episode.configuration.agentModel, p.arm, p.needle?.corpusChars, HAYSTACK_HEADER_CHARS),
    policyPresentAtDecision: p.policyPresentAtDecision,
    needle: p.needle,
    protocolFailure: null,
    policyChannelSatisfied: p.policyChannelSatisfied,
    durationMs: p.prepareMs + (evaluated?.latencyMs ?? 0),
    prepareMs: p.prepareMs,
    decisionMs: evaluated?.latencyMs ?? null,
    trajectoryPath: p.trajectory.path,
  };

  const finish = async (result: NormalizedResult): Promise<NormalizedResult> => {
    p.trajectory.record({
      type: "outcome",
      grade: result.outcome?.grade ?? null,
      binaryLabel: result.outcome?.binaryLabel ?? null,
      toolCalls: result.outcome?.toolCalls ?? [],
      terminalText: result.outcome?.terminalText ?? "",
      toolSteps: result.outcome?.toolSteps ?? null,
      hitStepCap: result.outcome?.hitStepCap ?? null,
    });
    p.trajectory.record({ type: "run_end", durationMs: record.durationMs, valid: result.valid, invalidReason: result.invalidReason });
    await p.trajectory.flush();
    return result;
  };
  const forceInvalid = (r: NormalizedResult, reason: InvalidReason): NormalizedResult => ({ ...r, valid: false, invalidReason: reason });

  if (p.failedReason !== null && p.failedReason !== "summarizer_refused") {
    return finish(forceInvalid(buildNormalizedResult(record), p.failedReason));
  }
  if (evaluationFailure !== null || !evaluated) {
    record.protocolFailure = evaluationFailure ?? "no evaluation result for this run";
    return finish(buildNormalizedResult(record));
  }
  if (!evaluated.ok) {
    record.protocolFailure = evaluated.reason;
    return finish(buildNormalizedResult(record));
  }
  record.outcome = {
    toolCalls: evaluated.toolCalls,
    grade: gradeGovernance(evaluated.toolCalls, p.row.grader),
    terminalText: evaluated.terminalText,
    toolSteps: evaluated.toolSteps,
    hitStepCap: evaluated.hitStepCap,
  };
  const normalized = buildNormalizedResult(record);
  return finish(p.failedReason === "summarizer_refused" ? forceInvalid(normalized, p.failedReason) : normalized);
}

/** [v1.2 rows] normalise and record the v1.2-shape row. */
async function recordV12(
  p: Prepared,
  evalResults: Map<string, EvalResult>,
  evaluationFailure: string | null,
  retainedTailTokens: number,
): Promise<V12Result> {
  const c = p.episode.configuration;
  const spec = p.episode.spec!;
  const def = spec.compactionStrategy ? definitionFor(spec.compactionStrategy) : null;
  const evaluated = evalResults.get(p.episode.runId);
  const okEval = evaluated && evaluated.ok ? evaluated : null;
  const invalidDetail =
    p.failureDetail ??
    (evaluationFailure !== null
      ? evaluationFailure.slice(0, 1000)
      : !evaluated
        ? "no evaluation result for this run"
        : !evaluated.ok
          ? String(evaluated.reason).slice(0, 1000)
          : null);
  const grade = okEval ? gradeGovernance(okEval.toolCalls, p.row.grader) : null;
  // Schema-aware: ACON's constraint material lives under a numbered `5. GUARDRAILS` heading.
  const constraints = p.artifact ? extractSchemaSection(p.artifact.summary, def?.constraintsHeading ?? null) : null;

  // Legacy cohorts stamp the provenance their study stamped; cccb-v1 records what ran.
  const provenance =
    c.cohort === "cccb-v1"
      ? buildProvenance(p.cohortCfg, c.agentModel, p.arm, p.built.needle?.corpusChars, HAYSTACK_HEADER_CHARS, spec.compactionStrategy ? c.compactorModel : c.agentModel)
      : buildProvenance(p.cohortCfg, c.agentModel, null, undefined, 0);

  const result: V12Result = {
    runId: p.episode.runId,
    sourceTranscriptId: p.episode.sourceTranscriptId!,
    pairKey: p.episode.pairKey,
    protocolVersion: "v1.2",
    configCohort: p.episode.configCohort,
    taskId: p.episode.caseId,
    model: c.agentModel,
    repetition: p.episode.repetition,
    spec,
    strategyGroup: def?.group ?? null,
    isControl: def?.isControl ?? false,
    provenance,
    valid: p.failedReason === null && okEval !== null,
    invalidReason:
      p.failedReason ??
      (evaluationFailure !== null || !evaluated ? "evaluator_protocol_failure" : !evaluated.ok ? "evaluator_protocol_failure" : null),
    compaction: p.artifact
      ? {
          backend: p.artifact.backend,
          strategy: p.artifact.strategy,
          native: p.artifact.native,
          // Only `pi-native-cut` has budget-dependent nativeness: a budget reaches pi as
          // customInstructions, which is what makes the arm modified.
          nativeImplementation:
            spec.compactionStrategy === "pi-native-cut"
              ? piNativeImplementation("pi-native-cut", p.artifact.budget)
              : (def?.provenance.nativeImplementation ?? false),
          upstreamBoundaryReplaced: def?.provenance.upstreamBoundaryReplaced ?? false,
          summary: p.artifact.summary,
          firstKeptEntryId: p.artifact.firstKeptEntryId,
          policyLocation: p.artifact.policyLocation,
          // Null means "this diagnostic does not apply", never "the rule was not preserved".
          summaryPolicyPreserved: def?.constraintsHeading ? summaryPreservesPolicy(constraints, p.row.policy) : null,
          constraintsSectionHeading: def?.constraintsHeading ?? null,
          summaryConstraintsSection: constraints,
          tokensBefore: p.artifact.tokensBefore,
          tokensAfter: p.artifact.tokensAfter,
          retainedTailTokens,
          selection: p.artifact.selection,
          budget: p.artifact.budget,
          prevSummaryAvailable: false,
          runOutOfDesignedSetting: spec.compactionStrategy === "trace-optimized",
          domainMismatch: def?.provenance.domainMismatch ?? false,
        }
      : null,
    fullContext: p.fullContext,
    outcome: okEval
      ? {
          grade: grade!,
          binaryLabel: grade === "violation" ? "violation" : grade === "unparseable" ? null : "not_violation",
          toolCalls: okEval.toolCalls,
          terminalText: okEval.terminalText,
          toolSteps: okEval.toolSteps,
          hitStepCap: okEval.hitStepCap,
        }
      : null,
    prepareMs: p.prepareMs,
    decisionMs: okEval?.latencyMs ?? null,
    invalidDetail,
  };

  p.trajectory.record({
    type: "run_end",
    durationMs: p.prepareMs + (result.decisionMs ?? 0),
    valid: result.valid,
    invalidReason: result.invalidReason,
  });
  await p.trajectory.flush();
  return result;
}

/** Run episodes in batches, handing each batch's rows over as it completes (the durability story). */
export async function executeEpisodes(episodes: Episode[], opts: EngineOptions): Promise<ResultRow[]> {
  const log = opts.onProgress ?? (() => {});
  const groups = batches(episodes, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const all: ResultRow[] = [];
  for (const [i, group] of groups.entries()) {
    const rows = await executeBatch(group, opts);
    if (opts.onResults) await opts.onResults(rows);
    all.push(...rows);
    const valid = all.filter((r) => r.valid).length;
    log(`  batch ${i + 1}/${groups.length}: ${all.length}/${episodes.length} episodes done, ${valid} valid`);
  }
  return all;
}
