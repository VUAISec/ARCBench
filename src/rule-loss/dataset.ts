/**
 * Typed loader for data/rule-loss/cases.jsonl.
 *
 * The Python validator is the build-time gate; this is the runtime one. They check the same
 * invariants deliberately: the validator stops a bad dataset from being committed, this stops
 * a bad dataset from being *run* when someone edits the JSONL by hand and skips the script.
 */
import { readFileSync } from "node:fs";
import type { GovernanceGrader } from "./grader.ts";
import type { CaseProvenance, ChannelAffinity, SourceFidelity } from "../harness/schema.ts";

export interface DatasetToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface DatasetTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: DatasetToolCall[];
  tool_name?: string;
  tool_call_id?: string;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: string; properties: Record<string, { type: string; description: string }>; required: string[] };
  };
}

export interface TaskRow {
  id: string;
  source_release: string;
  source_fidelity: SourceFidelity;
  /** v1.3: where the case came from, kept separate from fidelity-to-a-release. */
  provenance: CaseProvenance;
  /** The one channel this rule would plausibly arrive through. */
  channel_affinity: ChannelAffinity;
  fixture_only: boolean;
  /** Persona and available tools. Contains no graded rule, so it is safe as an uncompactable system prompt. */
  system_prompt: string;
  /** The graded constraint. Delivered as the first user turn so compaction can reach it. */
  policy: string;
  benign_turns: DatasetTurn[];
  trigger: string;
  tools: ToolSchema[];
  grader: GovernanceGrader;
  attack_inject: string;
}

export class DatasetError extends Error {}

const VALID_FIDELITY = new Set<string>(["reconstructed-from-paper", "exact-release", "authored"]);
const VALID_PROVENANCE = new Set<string>(["GD", "CI", "DER", "NEW"]);
/** c2 is deliberately absent -- see `ChannelAffinity`. */
const VALID_AFFINITY = new Set<string>(["c1", "c3", "c4"]);

function assertToolCallSequence(row: TaskRow): void {
  let declared = new Map<string, string>();
  row.benign_turns.forEach((turn, i) => {
    if (turn.role === "assistant") {
      declared = new Map();
      for (const call of turn.tool_calls ?? []) {
        if (!call.id) throw new DatasetError(`${row.id}: turn ${i} tool_call has no id (P4)`);
        declared.set(call.id, call.name);
      }
    } else if (turn.role === "tool") {
      const id = turn.tool_call_id ?? "";
      if (!declared.has(id)) {
        throw new DatasetError(
          `${row.id}: turn ${i} tool result references tool_call_id ${JSON.stringify(id)}, which the ` +
            `preceding assistant turn never declared (P4)`,
        );
      }
      if (declared.get(id) !== turn.tool_name) {
        throw new DatasetError(
          `${row.id}: turn ${i} tool result name ${turn.tool_name} does not match declared call ${declared.get(id)}`,
        );
      }
    }
  });
}

export function toolNames(row: TaskRow): string[] {
  return row.tools.map((t) => t.function.name);
}

export function loadTaskRows(path: string): TaskRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new DatasetError(`blocked_missing_constraintrot_release: cannot read ${path}: ${String(e)}`);
  }

  const rows: TaskRow[] = [];
  raw
    .split("\n")
    .filter((l) => l.trim())
    .forEach((line, i) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        throw new DatasetError(`blocked_dataset_validation: line ${i + 1} is not valid JSON: ${String(e)}`);
      }
      const row = parsed as TaskRow & { attack_volume?: unknown };

      if (row.attack_volume !== undefined) {
        throw new DatasetError(
          `blocked_dataset_validation: task ${row.id} still carries the retired attack_volume corpus; ` +
            `regenerate with scripts/cases/gen_cases.py (P1)`,
        );
      }
      if (!VALID_FIDELITY.has(row.source_fidelity)) {
        throw new DatasetError(
          `blocked_dataset_validation: task ${row.id} source_fidelity ${JSON.stringify(row.source_fidelity)} is not recognised (P24)`,
        );
      }
      if (!VALID_PROVENANCE.has(row.provenance)) {
        throw new DatasetError(
          `blocked_dataset_validation: task ${row.id} provenance ${JSON.stringify(row.provenance)} is not ` +
            `one of ${[...VALID_PROVENANCE].join(", ")}; an unlabelled case cannot be reported alongside ` +
            `labelled ones`,
        );
      }
      if (row.channel_affinity === ("c2" as ChannelAffinity)) {
        throw new DatasetError(
          `blocked_dataset_validation: task ${row.id} declares channel_affinity c2, which is not a home ` +
            `channel: channelInstruction() delivers the policy in a user turn before asking the model to ` +
            `persist it, so c2 structurally contains c1 and is a transform over a case, not its origin`,
        );
      }
      if (!VALID_AFFINITY.has(row.channel_affinity)) {
        throw new DatasetError(
          `blocked_dataset_validation: task ${row.id} channel_affinity ${JSON.stringify(row.channel_affinity)} ` +
            `is not one of ${[...VALID_AFFINITY].join(", ")}`,
        );
      }
      // A required boolean must not default in the unsafe direction.
      if (typeof row.fixture_only !== "boolean") {
        throw new DatasetError(`blocked_dataset_validation: task ${row.id} fixture_only must be a boolean`);
      }
      for (const field of ["system_prompt", "policy", "trigger", "attack_inject"] as const) {
        if (typeof row[field] !== "string" || row[field].trim() === "") {
          throw new DatasetError(`blocked_dataset_validation: task ${row.id} field ${field} is empty`);
        }
      }
      if (!Array.isArray(row.benign_turns) || row.benign_turns.length === 0) {
        throw new DatasetError(`blocked_dataset_validation: task ${row.id} has no benign_turns`);
      }
      if (!toolNames(row).includes(row.grader.tool)) {
        throw new DatasetError(
          `blocked_dataset_validation: task ${row.id} grader.tool ${row.grader.tool} is not one of its tools (P22)`,
        );
      }
      assertToolCallSequence(row);
      rows.push(row);
    });

  if (rows.length === 0) throw new DatasetError("blocked_missing_constraintrot_release: dataset is empty");
  return rows;
}
