/**
 * The v1.2 strategy identifiers and their grouping.
 *
 * Kept in its own module so `src/plan/spec.ts` and the adapter registry can both name a strategy
 * without importing each other.
 *
 * The GROUP is not decoration. It records what a comparison within it holds fixed:
 *
 *   A  complete pi workflows      pi's own cut, prompt, serializer and 2,000-char tool-result cap
 *   B  one shared boundary        identical prefix and tail; ONLY the prompt and schema differ
 *   C  mechanism controls         same boundary as B, so what is REMOVED is matched; nothing
 *                                 replaces it
 *
 * A comparison across groups is a workflow comparison, in which boundary, path and prompt may all
 * differ at once. That distinction is the reason the group travels with every row rather than
 * living in a table someone has to remember to consult.
 */

export const STRATEGY_IDS = [
  // Group A — complete pi workflows.
  "pi-native-cut",
  "pi-native-policy-preserving",
  // Group B — one shared boundary, prompt swapped.
  "baseline-structured-summary",
  "prompting-h",
  "acon-ut",
  "acon-utco",
  "trace-optimized",
  // Group C — mechanism controls.
  "fifo",
  "lru-mechanism",
  "lru-prompting",
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

export type StrategyGroup = "A" | "B" | "C";

const GROUP_OF: Record<StrategyId, StrategyGroup> = {
  "pi-native-cut": "A",
  "pi-native-policy-preserving": "A",
  "baseline-structured-summary": "B",
  "prompting-h": "B",
  "acon-ut": "B",
  "acon-utco": "B",
  "trace-optimized": "B",
  fifo: "C",
  "lru-mechanism": "C",
  "lru-prompting": "C",
};

export function strategyGroup(id: StrategyId): StrategyGroup {
  return GROUP_OF[id];
}

export function isStrategyId(value: string): value is StrategyId {
  return (STRATEGY_IDS as readonly string[]).includes(value);
}

/**
 * Group B's control arm.
 *
 * It carries pi/OpenClaw's default prompt on the shared boundary so the other Group B arms have a
 * matched comparator. Registered as a CONTROL rather than as a method: without this distinction it
 * would eventually be quoted as a proposed technique, which it is not -- it is the thing the
 * proposed techniques are measured against.
 */
export const GROUP_B_CONTROL: StrategyId = "baseline-structured-summary";

/**
 * Arms that run on pi's real `AgentSession`. Everything else runs the harness path.
 *
 * This is the only place the split is declared. pi's serializer caps every tool result at 2,000
 * chars before summarizing; that cap is pi's, not the method's, so running ACON or Hermes through
 * pi would measure pi's truncation rather than their prompts.
 */
const PI_SESSION_ARMS = new Set<StrategyId>(["pi-native-cut", "pi-native-policy-preserving"]);

export function usesPiSessionPath(id: StrategyId): boolean {
  return PI_SESSION_ARMS.has(id);
}

/**
 * Whether the arm emits generated or extracted text in place of the removed history.
 *
 * `false` for `fifo`, `lru-mechanism` and `lru-prompting`, which delete without replacing. This is
 * load-bearing: `empty_native_summary` is a hard failure on the pi path, and applying it to a
 * mechanism arm would invalidate every row at the moment it succeeded.
 */
const NO_REPLACEMENT_TEXT = new Set<StrategyId>(["fifo", "lru-mechanism", "lru-prompting"]);

export function producesReplacementText(id: StrategyId): boolean {
  return !NO_REPLACEMENT_TEXT.has(id);
}
