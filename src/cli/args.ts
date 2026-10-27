/**
 * Command-line parsing: `--flag value` pairs and bare boolean switches.
 *
 * One value per flag. A factor flag given twice, or given a comma list, is refused: grids are
 * built by issuing several commands (scripts/rqN/sM-<name>/run.sh), never inside one.
 */
import type { RuleViolation } from "../plan/configuration.ts";

export interface FlagSpec {
  /** Takes no value; presence means true. */
  boolean?: boolean;
  /** May be given more than once (evaluate's --results and --contrast). */
  repeatable?: boolean;
  /** A comma inside the value is allowed (free text, paths). Factor flags leave this off. */
  allowComma?: boolean;
}

export interface ParsedArgs {
  command: string | null;
  values: Map<string, string[]>;
  violations: RuleViolation[];
}

export function parseArgs(argv: string[], specs: Record<string, FlagSpec>): ParsedArgs {
  const values = new Map<string, string[]>();
  const violations: RuleViolation[] = [];
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) {
      if (command === null) command = tok;
      else {
        violations.push({
          id: "UNKNOWN-ARGUMENT",
          reason: `unexpected argument ${JSON.stringify(tok)}; flags take the form --name value.`,
          fix: "run ./arcbench --help for the command's flags",
        });
      }
      continue;
    }
    const [rawName, inline] = tok.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const name = rawName.replace(/-/g, "_");
    const spec = specs[name];
    if (!spec) {
      violations.push({
        id: "UNKNOWN-FLAG",
        reason: `--${rawName} is not a flag of this command.`,
        fix: `known flags: ${Object.keys(specs).map((k) => `--${k}`).join(", ")}`,
      });
      if (inline === undefined && argv[i + 1] && !argv[i + 1]!.startsWith("--")) i++;
      continue;
    }
    let value: string;
    if (spec.boolean) {
      value = inline ?? "true";
    } else if (inline !== undefined) {
      value = inline;
    } else {
      const nextTok = argv[i + 1];
      if (nextTok === undefined || nextTok.startsWith("--")) {
        violations.push({ id: "MISSING-VALUE", reason: `--${name} needs a value.`, fix: `give --${name} <value>` });
        continue;
      }
      value = nextTok;
      i++;
    }
    const prev = values.get(name) ?? [];
    if (prev.length > 0 && !spec.repeatable) {
      violations.push({
        id: "ONE-VALUE-PER-FLAG",
        reason: `--${name} was given twice (${prev[0]}, ${value}); a command runs one configuration.`,
        fix: "issue one command per value (see scripts/rqN/sM-<name>/run.sh for grids)",
      });
      continue;
    }
    if (!spec.allowComma && !spec.boolean && value.includes(",")) {
      violations.push({
        id: "ONE-VALUE-PER-FLAG",
        reason: `--${name} ${value} is a list; each flag takes one value and a command runs one configuration.`,
        fix: "issue one command per value (see scripts/rqN/sM-<name>/run.sh for grids)",
      });
      continue;
    }
    values.set(name, [...prev, value]);
  }
  return { command, values, violations };
}

export function one(args: ParsedArgs, name: string): string | undefined {
  return args.values.get(name)?.[0];
}

export function flag(args: ParsedArgs, name: string): boolean {
  const v = one(args, name);
  return v !== undefined && v !== "false";
}

export function all(args: ParsedArgs, name: string): string[] {
  return args.values.get(name) ?? [];
}
