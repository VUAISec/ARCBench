/**
 * Channel modes: which channel(s) each case's rule is delivered through (`--rule_channel`).
 *
 * A case's scenario is read off its `channel_affinity`, because affinity is DEFINED as the
 * authority's own column of the 2x2 (c1 = personal, c3/c4 = organizational):
 *
 *                   stated       materialized
 *   personal          c1             c2
 *   organizational    c4             c3
 *
 * | mode             | personal case | organizational case | used by                         |
 * |------------------|---------------|---------------------|---------------------------------|
 * | `home`           | c1            | c3                  | S3, S4, S6, S7                   |
 * | `home-paired`    | c1, c2        | c4, c3              | S1, S2, S5                       |
 * | `swapped-paired` | c4, c3        | c1, c2              | each scenario on the other's two |
 * | `all`            | c1, c2, c3, c4| c1, c2, c3, c4      | every case on every channel      |
 * | `c1` … `c4`      | that channel  | that channel        | every case on one channel        |
 *
 * `home` puts the four organizational cases whose affinity is c4 (`channel`, `deploy`, `spend`,
 * `incidentfile`) at c3 as well, so the whole organizational side sits in one comparable cell.
 *
 * The paired orders ([c1, c2] and [c4, c3]) are the v1.1 ladder's column orders, so a reproduced
 * plan lists episodes in the order the recorded manifest does.
 */
import type { PolicyChannel } from "../harness/schema.ts";

export const CHANNEL_MODES = [
  "home",
  "home-paired",
  "swapped-paired",
  "all",
  "c1",
  "c2",
  "c3",
  "c4",
] as const;
export type ChannelMode = (typeof CHANNEL_MODES)[number];

export type Scenario = "personal" | "organizational";

export const PERSONAL_COLUMN: readonly PolicyChannel[] = ["c1", "c2"];
export const ORGANIZATIONAL_COLUMN: readonly PolicyChannel[] = ["c4", "c3"];

export function isChannelMode(value: string): value is ChannelMode {
  return (CHANNEL_MODES as readonly string[]).includes(value);
}

/** The case's scenario, from its affinity. An affinity naming no column throws. */
export function scenarioOf(row: { id: string; channel_affinity: string }): Scenario {
  switch (row.channel_affinity) {
    case "c1":
      return "personal";
    case "c3":
    case "c4":
      return "organizational";
    default:
      throw new Error(
        `task ${row.id} has channel_affinity ${JSON.stringify(row.channel_affinity)}, which names ` +
          `no authority column; c1 is personal, c3/c4 are organizational`,
      );
  }
}

/** The single channel `home` assigns: c1 for personal cases, c3 for organizational ones. */
export function channelForAuthoritySingle(row: { id: string; channel_affinity: string }): PolicyChannel {
  return scenarioOf(row) === "personal" ? "c1" : "c3";
}

/** The channels a case runs at under `mode`, in planning order. */
export function channelsForMode(
  mode: ChannelMode,
  row: { id: string; channel_affinity: string },
): PolicyChannel[] {
  const personal = scenarioOf(row) === "personal";
  switch (mode) {
    case "home":
      return [channelForAuthoritySingle(row)];
    case "home-paired":
      return [...(personal ? PERSONAL_COLUMN : ORGANIZATIONAL_COLUMN)];
    case "swapped-paired":
      return [...(personal ? ORGANIZATIONAL_COLUMN : PERSONAL_COLUMN)];
    case "all":
      return ["c1", "c2", "c3", "c4"];
    default:
      return [mode];
  }
}

/** True when a mode can give one case more than one channel. */
export function isMultiChannelMode(mode: ChannelMode): boolean {
  return mode === "home-paired" || mode === "swapped-paired" || mode === "all";
}
