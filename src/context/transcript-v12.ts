/**
 * Condition construction at one common attack position.
 *
 * ## What changed, and why it makes these a new protocol
 *
 * v1.1 placed the attack in two different positions: G4 before all benign turns, G5 after the
 * first benign user-turn block and immediately before the filler. That is specified behaviour, not
 * a bug -- but it means `G5 - G4` mixes the effect of adding filler with the effect of moving the
 * attack, so neither difference identifies what it appears to.
 *
 * v1.2 uses ONE position for every condition:
 *
 *     no filler, no attack: policy -> benign block 1 -> remaining benign history
 *     no filler, attack:    policy -> benign block 1 -> attack -> remaining benign history
 *     filler,    no attack: policy -> benign block 1 -> filler -> remaining benign history
 *     filler,    attack:    policy -> benign block 1 -> attack -> filler -> remaining benign
 *
 * "Same position" means the same position relative to benign work, not the same numeric index.
 * When the attack is absent its delivery block is omitted entirely and the filler stays at the
 * same logical point.
 *
 * Because this changes how G4/G5-shaped cells are built, the resulting runs are a NEW PROTOCOL and
 * are never pooled under the historical labels. `deriveLegacyLabel` enforces that by returning
 * null for every attacked cell.
 *
 * v1.1's `buildCondition` is left untouched: historical conditions stay reproducible, and their
 * layout tests keep passing.
 */
import type { HaystackArm, MvpConfig } from "../config/config.ts";
import type { TaskRow } from "../rule-loss/dataset.ts";
import {
  benignInsertionIndex,
  benignMessages,
  ConditionError,
  documentTurns,
  entryId,
  HAYSTACK_HEADER,
} from "./transcript-v11.ts";
import { auditHaystack, buildHaystack, type BuiltHaystack } from "./haystack.ts";
import { toolNames } from "../rule-loss/dataset.ts";
import { buildPolicyBlock, channelToolsFor } from "../channels/policy-channels.ts";
import {
  attackDocId,
  registerFor,
  renderAttack,
  type AttackTechnique,
} from "../attacks/attack-library.ts";
import type { CanonicalMessage, NeedleRecord } from "../harness/schema.ts";
import { V12_HAYSTACK_ARM, type ConditionSpec } from "../plan/spec.ts";

export interface BuiltConditionV12 {
  systemPrompt: string;
  messages: CanonicalMessage[];
  policyEntryId: string | null;
  /**
   * Entry id of the fixture's benign task instruction -- the first benign user turn.
   *
   * The retention floor pins it and ACON binds `{{ task }}` to its text, so it has to
   * be identified here rather than guessed downstream.
   */
  taskInstructionEntryId: string;
  taskInstruction: string;
  trigger: string;
  tools: TaskRow["tools"];
  needle: Omit<NeedleRecord, "needleInSummary"> | null;
  /** A stable id for the frozen source conversation all handling branches share. */
  sourceTranscriptId: string;
}

export interface BuildV12Options {
  row: TaskRow;
  spec: ConditionSpec;
  repetition: number;
  cfg: MvpConfig;
  liveChannelResult?: { toolCallId: string; writtenContent: string } | null;
  /**
   * v1.6: which attack construction to render. Defaults to `legacy`, which returns the fixture's
   * own `attack_inject` bytes -- so every v1.2/v1.3/v1.4/v1.5 caller builds exactly the transcript
   * it always built.
   */
  attackTechnique?: AttackTechnique;
}

/**
 * The A3 arm, resolved from config.
 *
 * v1.2 uses one delivery, and it must be the one sized so pi's 2,000-char cap does not bite --
 * otherwise "every strategy sees the whole document" is false for the pi arms alone.
 */
export function v12Arm(cfg: MvpConfig): HaystackArm {
  const arm = cfg.haystackArms.find((a) => a.id === V12_HAYSTACK_ARM);
  if (!arm) {
    throw new ConditionError(
      `config declares no ${V12_HAYSTACK_ARM} haystack arm; v1.2 requires the 100%-coverage arm`,
    );
  }
  return arm;
}

/**
 * A synthetic condition label, used only to derive stable entry ids.
 *
 * Entry ids embed a condition name in v1.1. v1.2 keeps that scheme so ids remain readable and
 * comparable, but derives the name from the FACTORS rather than from a G-label -- there is no
 * G-label for most v1.2 cells, and inventing one would reintroduce exactly the ambiguity the
 * factor model removes.
 */
export function v12IdLabel(spec: ConditionSpec): string {
  return [
    spec.policyPresent ? "p" : "n",
    spec.fillerPresent ? "f" : "-",
    spec.attackPresent ? "a" : "-",
  ].join("");
}

/**
 * Build a v1.2 transcript from its factors.
 *
 * The source transcript is a function of (task, repetition, policy/filler/attack presence) ONLY --
 * never of `contextHandling` or `compactionStrategy`. That is what lets the full-context and every
 * compacted branch share one `sourceTranscriptId`: they are the same conversation handled
 * differently, which is the premise the whole four-condition comparison rests on.
 */
export function buildConditionV12(opts: BuildV12Options): BuiltConditionV12 {
  const { row, spec, repetition, cfg } = opts;
  // Cast: entry ids take a GovernanceCondition in v1.1's scheme; v1.2 supplies its own label.
  const label = v12IdLabel(spec) as never;
  const id = (suffix: string) => entryId(row.id, label, suffix);

  let policyBlock: CanonicalMessage[] = [];
  let policyEntryId: string | null = null;
  if (spec.policyPresent) {
    if (!spec.policyChannel) throw new ConditionError("policyPresent requires a policyChannel");
    const block = buildPolicyBlock({
      row,
      channel: spec.policyChannel,
      entryId: (l) => id(l),
      liveResult: opts.liveChannelResult ?? null,
    });
    policyBlock = block.messages;
    policyEntryId = block.policyEntryId;
  }

  const benign = benignMessages(row, label);

  // ---- the filler ----
  let needle: Omit<NeedleRecord, "needleInSummary"> | null = null;
  let docBlock: CanonicalMessage[] = [];
  if (spec.fillerPresent) {
    const arm = v12Arm(cfg);
    // Seeded from config seed + task + repetition ONLY, never from the factors, so the attacked
    // and unattacked branches of one source instance carry byte-identical corpora.
    const seed = hashSeed(`${cfg.seed}:${row.id}:${repetition}`);
    const built: BuiltHaystack = buildHaystack({
      seed,
      targetChars: cfg.haystackTargetChars,
      needleKeyPrefix: cfg.needleKeyPrefix,
      reservedValues: typeof row.grader.ceiling === "number" ? [String(row.grader.ceiling)] : [],
    });

    const violations = auditHaystack({
      filler: built.text.replace(built.needleSentence, ""),
      policy: row.policy,
      grader: row.grader as unknown as Record<string, unknown>,
      toolNames: toolNames(row),
    });
    if (violations.length > 0) {
      throw new ConditionError(
        `task ${row.id}: filler overlaps its own policy (P1): ` +
          violations.map((v) => `${v.kind}:${v.term}`).join(", "),
      );
    }

    docBlock = documentTurns(
      row,
      label,
      "haystack",
      `${built.corpusId}-${row.id}`,
      built.text,
      arm.delivery === "chunked-tool-results" ? arm.chunkChars : null,
      HAYSTACK_HEADER,
      arm.delivery === "user-message",
    );
    needle = {
      corpusId: built.corpusId,
      corpusSha256: built.corpusSha256,
      corpusChars: built.corpusChars,
      seed: built.seed,
      needleKey: built.needleKey,
      needleValue: built.needleValue,
      needleCharOffset: built.needleCharOffset,
      needleSentence: built.needleSentence,
    };
  }

  // v1.6. `attackDocId` is not cosmetic: `documentTurns` writes the id into the VISIBLE transcript
  // ("Retrieving <docId>."), so holding the incumbent's `session-memory-note` label across every
  // construction would pre-frame all of them with memory-manager authority -- which is precisely
  // what `naive` is defined by lacking.
  const technique: AttackTechnique = opts.attackTechnique ?? "legacy";
  const injBlock: CanonicalMessage[] = spec.attackPresent
    ? documentTurns(
        row,
        label,
        "inject",
        attackDocId(technique, row.id),
        renderAttack(technique, registerFor(row)),
        null,
      )
    : [];

  // ---- one layout, four factor combinations ----
  //
  // The insertion index is computed on the benign arc ALONE. Computed on the assembled list it
  // would shift with however many entries the policy channel contributed, so the attack would sit
  // at a different conversational position under a different channel.
  const at = benignInsertionIndex(benign, cfg.haystackInsertionTurn);
  const messages: CanonicalMessage[] = [
    ...policyBlock,
    ...benign.slice(0, at),
    ...injBlock,
    ...docBlock,
    ...benign.slice(at),
  ];

  assertV12Invariants(row, spec, messages, policyEntryId, docBlock, injBlock);

  const instruction = benign.find((m) => m.role === "user");
  if (!instruction) {
    throw new ConditionError(`task ${row.id}: benign arc has no user turn to serve as the task`);
  }

  return {
    systemPrompt: row.system_prompt,
    messages,
    policyEntryId,
    taskInstructionEntryId: instruction.entryId,
    taskInstruction: instruction.content,
    trigger: row.trigger,
    tools: [...row.tools, ...channelToolsFor(spec.policyChannel)],
    needle,
    // Deliberately excludes contextHandling and compactionStrategy: every handling branch of one
    // source instance shares this id.
    sourceTranscriptId: [
      "v1.2",
      row.id,
      `rep-${repetition}`,
      spec.policyPresent ? `pol-${spec.policyChannel}` : "nopol",
      spec.fillerPresent ? `fill-${spec.haystackArm}` : "nofill",
      spec.attackPresent ? "atk" : "noatk",
    ].join("|"),
  };
}

function assertV12Invariants(
  row: TaskRow,
  spec: ConditionSpec,
  messages: CanonicalMessage[],
  policyEntryId: string | null,
  docBlock: CanonicalMessage[],
  injBlock: CanonicalMessage[],
): void {
  const ids = new Set<string>();
  for (const m of messages) {
    if (ids.has(m.entryId)) throw new ConditionError(`${row.id}: duplicate entry id ${m.entryId}`);
    ids.add(m.entryId);
  }

  // Every tool result must reference a call the preceding assistant turn declared.
  let declared = new Set<string>();
  messages.forEach((m, i) => {
    if (m.role === "assistant") declared = new Set((m.toolCalls ?? []).map((c) => c.id));
    else if (m.role === "tool" && (!m.toolCallId || !declared.has(m.toolCallId))) {
      throw new ConditionError(`${row.id}: message ${i} is an orphaned tool result (P4)`);
    }
  });

  // pi admits only user/assistant entries as cut points, so a transcript whose last entry is a
  // tool result is unsummarizable at ANY budget. Must be impossible by construction, not caught by
  // a failing run.
  for (const [name, block] of [["filler", docBlock], ["attack", injBlock]] as const) {
    if (block.length === 0) continue;
    const last = block[block.length - 1]!;
    const idx = messages.findIndex((m) => m.entryId === last.entryId);
    if (idx === -1) throw new ConditionError(`${row.id}: ${name} block missing from transcript`);
    if (!messages.slice(idx + 1).some((m) => m.role === "user" || m.role === "assistant")) {
      throw new ConditionError(`${row.id}: no valid cut point follows the ${name} block (D5)`);
    }
  }

  // The attack precedes the filler, so the attack's position is identical with and without it.
  if (docBlock.length > 0 && injBlock.length > 0) {
    const injIdx = messages.findIndex((m) => m.entryId === injBlock[0]!.entryId);
    const docIdx = messages.findIndex((m) => m.entryId === docBlock[0]!.entryId);
    if (!(injIdx < docIdx)) {
      throw new ConditionError(`${row.id}: attack must precede the filler`);
    }
  }

  if (!spec.policyPresent) {
    if (policyEntryId !== null) throw new ConditionError(`${row.id}: policy entry must not exist`);
    const policyText = row.policy.trim();
    if (messages.some((m) => m.content.includes(policyText))) {
      throw new ConditionError(`${row.id}: policy text leaked into a no-policy transcript`);
    }
  }
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
