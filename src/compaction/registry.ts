/**
 * The v1.2 strategy registry.
 *
 * One place that knows which arms exist, what group each belongs to, what provenance it carries,
 * and how to construct it. A sweep selects arms by id from config; nothing downstream needs a
 * switch statement over strategy names, so adding an arm cannot leave one of them stale.
 *
 * The registry deliberately does NOT know about the pi arms' construction: those run pi's real
 * `AgentSession` through the existing `PiNativeCompactor`, which predates this module and stays
 * where it is. What the registry records for them is which path they take, so a caller can tell
 * the two paths apart without hardcoding ids.
 */
import { chatOnceForChannel } from "../rule-loss/evaluator.ts";
import type { MvpConfig } from "../config/config.ts";
import type { CompactorBackend } from "../harness/schema.ts";
import type { HarnessStrategy } from "./harness-driver.ts";
import { PROMPT_PROVENANCE, type PromptProvenance } from "./prompts.ts";
import { FifoStrategy, LruMechanismStrategy } from "./strategies-mechanism.ts";
import {
  AconUt,
  AconUtco,
  BaselineStructuredSummary,
  LruPromptingStrategy,
  PromptingHermes,
  TraceOptimized,
  type SummarizerCall,
} from "./strategies-summary.ts";
import {
  producesReplacementText,
  strategyGroup,
  STRATEGY_IDS,
  usesPiSessionPath,
  type StrategyGroup,
  type StrategyId,
} from "./strategy-ids.ts";

export class RegistryError extends Error {}

/**
 * One summarizer/ranking call against OpenRouter.
 *
 * Lives here rather than in a CLI so the v1.1 and v1.2 paths build it the same way.
 * Two constructions would be two retry policies and two timeout budgets, and a difference there
 * would show up as a difference between paths that the experiment would read as method.
 */
export function makeSummarizerCall(cfg: MvpConfig, apiKey: string): SummarizerCall {
  return async ({ systemPrompt, userContent, model, maxTokens }) => {
    const res = await chatOnceForChannel({
      systemPrompt,
      userContent,
      tools: [],
      model,
      apiKey,
      baseUrl: cfg.openrouterBaseUrl,
      temperature: cfg.temperature,
      requestTimeoutMs: cfg.requestTimeoutMs,
      maxTransientRetries: cfg.maxTransientRetries,
      retryBaseDelayMs: cfg.retryBaseDelayMs,
      // Spread, not `maxTokens: maxTokens`: an unbudgeted call must send no `max_tokens` key, so
      // its request body stays identical to every v1.1/v1.2/v1.3 sweep's.
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
    if (!res.ok) return { ok: false, reason: res.reason };
    return { ok: true, text: res.text, usage: res.usage, finishReason: res.finishReason };
  };
}

export interface StrategyDeps {
  /** Makes one summarizer or ranking call. Injected so tests never touch a network. */
  summarizerCall: SummarizerCall;
}

export interface StrategyDefinition {
  id: StrategyId;
  group: StrategyGroup;
  kind: "mechanism" | "structured-summary";
  path: "pi-session" | "harness";
  backend: CompactorBackend;
  provenance: PromptProvenance;
  /** True for Group B's control, which is a reference and not a proposed method. */
  isControl: boolean;
  /** False for arms that delete without replacing; see `PolicyLocation` "dropped". */
  producesReplacementText: boolean;
  /**
   * Which heading in this arm's schema carries constraint material, or null when its schema has
   * none. Null means "this diagnostic does not apply", NEVER "the rule was not preserved".
   *
   * ACON is why this exists: its schema has GUARDRAILS and REASONING, not
   * `## Constraints & Preferences`. The v1.1 parser would return null for every ACON row, which a
   * reader would take as a missing measurement rather than as a different schema.
   */
  constraintsHeading: string | null;
  /** Null for the pi arms, which are constructed by the pi-session path instead. */
  build: ((deps: StrategyDeps) => HarnessStrategy) | null;
}

const CONSTRAINTS_HEADING: Record<StrategyId, string | null> = {
  "pi-native-cut": "Constraints & Preferences",
  "pi-native-policy-preserving": "Constraints & Preferences",
  "baseline-structured-summary": "Constraints & Preferences",
  "prompting-h": "Constraints & Preferences",
  // ACON's schema carries constraint material under GUARDRAILS, inside <HISTORY_SUMMARY>.
  "acon-ut": "GUARDRAILS",
  "acon-utco": "GUARDRAILS",
  "trace-optimized": "Constraints & Preferences",
  // Mechanism arms emit no schema at all.
  fifo: null,
  "lru-mechanism": null,
  "lru-prompting": null,
};

const KIND: Record<StrategyId, StrategyDefinition["kind"]> = {
  "pi-native-cut": "structured-summary",
  "pi-native-policy-preserving": "structured-summary",
  "baseline-structured-summary": "structured-summary",
  "prompting-h": "structured-summary",
  "acon-ut": "structured-summary",
  "acon-utco": "structured-summary",
  "trace-optimized": "structured-summary",
  fifo: "mechanism",
  "lru-mechanism": "mechanism",
  "lru-prompting": "mechanism",
};

const BUILDERS: Record<StrategyId, ((deps: StrategyDeps) => HarnessStrategy) | null> = {
  "pi-native-cut": null,
  "pi-native-policy-preserving": null,
  "baseline-structured-summary": (d) => new BaselineStructuredSummary(d.summarizerCall),
  "prompting-h": (d) => new PromptingHermes(d.summarizerCall),
  "acon-ut": (d) => new AconUt(d.summarizerCall),
  "acon-utco": (d) => new AconUtco(d.summarizerCall),
  "trace-optimized": (d) => new TraceOptimized(d.summarizerCall),
  fifo: () => new FifoStrategy(),
  "lru-mechanism": () => new LruMechanismStrategy(),
  "lru-prompting": (d) => new LruPromptingStrategy(d.summarizerCall),
};

export const REGISTRY: Record<StrategyId, StrategyDefinition> = Object.fromEntries(
  STRATEGY_IDS.map((id) => [
    id,
    {
      id,
      group: strategyGroup(id),
      kind: KIND[id],
      path: usesPiSessionPath(id) ? "pi-session" : "harness",
      backend: usesPiSessionPath(id) ? "pi-native" : "harness",
      provenance: PROMPT_PROVENANCE[id]!,
      isControl: id === "baseline-structured-summary",
      producesReplacementText: producesReplacementText(id),
      constraintsHeading: CONSTRAINTS_HEADING[id],
      build: BUILDERS[id],
    } satisfies StrategyDefinition,
  ]),
) as Record<StrategyId, StrategyDefinition>;

export function definitionFor(id: StrategyId): StrategyDefinition {
  const def = REGISTRY[id];
  if (!def) throw new RegistryError(`unknown strategy ${id}`);
  return def;
}

/** Build a harness-backend arm. Throws for a pi arm, which the pi-session path builds instead. */
export function buildHarnessStrategy(id: StrategyId, deps: StrategyDeps): HarnessStrategy {
  const def = definitionFor(id);
  if (!def.build) {
    throw new RegistryError(
      `${id} runs on the pi session path and is not built by this registry`,
    );
  }
  return def.build(deps);
}

/**
 * Validate a configured selection before a sweep starts.
 *
 * Fails loudly at configuration time rather than partway through a paid run: an unknown id would
 * otherwise surface after the first few hundred rows.
 */
export function validateSelection(ids: string[], deps: Partial<StrategyDeps>): StrategyId[] {
  const out: StrategyId[] = [];
  for (const id of ids) {
    const def = REGISTRY[id as StrategyId];
    if (!def) {
      throw new RegistryError(
        `unknown strategy "${id}". Known: ${STRATEGY_IDS.join(", ")}`,
      );
    }
    out.push(def.id);
  }
  if (out.length === 0) throw new RegistryError("no strategies selected");
  return out;
}
