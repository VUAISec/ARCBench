/**
 * Deterministic tool results for the bounded decision loop.
 *
 * The calibration showed the single decision turn was not enough: the model answered the
 * trigger with "Before I send this, let me quickly verify Marcus Holt in our directory" and a
 * `search_contacts` call, so the graded action was never reachable and G0 recorded a false
 * `not_violation`. Every task ships two or three non-graded lookup tools, so this is a
 * matrix-wide hazard, not an `email` quirk.
 *
 * The loop therefore answers non-graded tool calls and lets the model continue. Two properties
 * matter for validity:
 *
 *   1. **Deterministic.** A result is a pure function of (task, tool name, arguments), so the
 *      same call gets the same answer in G0 and in G4. A stub that varied by condition would be
 *      an uncontrolled variable on the compaction axis.
 *   2. **Non-informative about the policy.** A stub never states or implies the graded rule,
 *      or the tool-schema policy leak would come back through a different door — this time in a
 *      channel that compaction also cannot reach.
 *
 * Where the task's own transcript already answers a call, that answer is replayed rather than
 * invented. Otherwise the shape of the tool name selects a neutral empty/not-found result.
 */
import type { TaskRow } from "../rule-loss/dataset.ts";

function canonicalArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return JSON.stringify(keys.map((k) => [k, args[k]]));
}

/** Neutral result shapes, chosen by verb so a stub never invents domain facts. */
function neutralResult(name: string): string {
  if (/^(search|list|find|query)_/.test(name)) {
    return JSON.stringify([]);
  }
  if (/^(read|get|lookup|describe|fetch)_/.test(name)) {
    return JSON.stringify({ status: "not_found", detail: "No record matches the supplied identifier." });
  }
  if (/^(check|explain|review|analyze|analyse)_/.test(name)) {
    return JSON.stringify({ status: "ok", detail: "No issues reported." });
  }
  if (/^(save|create|write|file|submit|run|deploy|send)_/.test(name)) {
    return JSON.stringify({ status: "ok", id: `${name}-stub-001` });
  }
  return JSON.stringify({ status: "ok" });
}

export type ToolStub = (name: string, args: Record<string, unknown>) => string;

export function buildToolStub(row: TaskRow): ToolStub {
  // Replay index built from the task's own benign transcript.
  const byCall = new Map<string, string>();
  const byTool = new Map<string, string>();

  let pending: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  for (const turn of row.benign_turns) {
    if (turn.role === "assistant") {
      pending = (turn.tool_calls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args }));
      continue;
    }
    if (turn.role !== "tool") continue;
    const call = pending.find((c) => c.id === turn.tool_call_id);
    if (!call) continue;
    byCall.set(`${call.name}|${canonicalArgs(call.args)}`, turn.content);
    // First result seen for a tool, used only when the arguments do not match exactly.
    if (!byTool.has(call.name)) byTool.set(call.name, turn.content);
  }

  return (name, args) => {
    const exact = byCall.get(`${name}|${canonicalArgs(args)}`);
    if (exact !== undefined) return exact;

    // A lookup the transcript never performed. Returning the transcript's answer to a
    // *different* query would fabricate a fact — e.g. telling the model that an external
    // recipient is in the internal directory — so a neutral empty result is returned instead.
    return neutralResult(name);
  };
}

/** Exposed for tests: the replay index the stub is built from. */
export function replayableCalls(row: TaskRow): string[] {
  const out: string[] = [];
  let pending: Array<{ id: string; name: string }> = [];
  for (const turn of row.benign_turns) {
    if (turn.role === "assistant") {
      pending = (turn.tool_calls ?? []).map((c) => ({ id: c.id, name: c.name }));
    } else if (turn.role === "tool") {
      const call = pending.find((c) => c.id === turn.tool_call_id);
      if (call) out.push(call.name);
    }
  }
  return out;
}
