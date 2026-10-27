/**
 * `arcbench preflight`: can this machine run the benchmark? No model calls.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, pythonExecutable, REPO_ROOT } from "../config/config.ts";
import { loadTaskRows } from "../rule-loss/dataset.ts";
import { CASES_PATH } from "./run-commands.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Required for `arcbench run`; the others gate optional features. */
  required: boolean;
}

function python(code: string): string | null {
  try {
    return execFileSync(pythonExecutable(), ["-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

export async function preflightCommand(): Promise<number> {
  const checks: Check[] = [];
  const cfg = loadConfig();

  checks.push({
    name: "OPENROUTER_API_KEY",
    ok: Boolean(process.env["OPENROUTER_API_KEY"]),
    detail: process.env["OPENROUTER_API_KEY"] ? "set" : "not set -- export your own key before `arcbench run` (smoke and evaluate work without it)",
    required: false,
  });

  try {
    const pi = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
    const ok = typeof pi["createAgentSession"] === "function" && typeof pi["SessionManager"] === "function";
    checks.push({ name: "pi importable", ok, detail: ok ? "@earendil-works/pi-coding-agent loads" : "loaded, but AgentSession/SessionManager are missing", required: true });
  } catch (e) {
    checks.push({ name: "pi importable", ok: false, detail: `cannot import pi: ${String(e).slice(0, 200)} -- run npm ci (scripts/setup.sh)`, required: true });
  }

  // pi is vendored: the seven tarballs in vendor/pi/ must match their recorded checksums, and the
  // installed package must be the one npm unpacked from them.
  const sums = join(REPO_ROOT, "vendor/pi/SHA256SUMS");
  let vendorOk = existsSync(sums);
  let vendorDetail = vendorOk ? "" : "vendor/pi/SHA256SUMS is missing";
  if (vendorOk) {
    const bad: string[] = [];
    for (const line of readFileSync(sums, "utf8").split("\n").filter(Boolean)) {
      const [want, file] = line.trim().split(/\s+/) as [string, string];
      const path = join(REPO_ROOT, "vendor/pi", file);
      const got = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing";
      if (got !== want) bad.push(file);
    }
    vendorOk = bad.length === 0;
    vendorDetail = vendorOk ? `7 tarballs match vendor/pi/SHA256SUMS (pi ${cfg.piRevision.slice(0, 12)})` : `checksum mismatch: ${bad.join(", ")}`;
  }
  checks.push({ name: "vendored pi", ok: vendorOk, detail: vendorDetail, required: true });

  const installed = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json");
  const lock = join(REPO_ROOT, "package-lock.json");
  const fromVendor =
    existsSync(installed) &&
    existsSync(lock) &&
    readFileSync(lock, "utf8").includes('"resolved": "file:vendor/pi/earendil-works-pi-coding-agent-0.84.3.tgz"');
  checks.push({
    name: "pi installed",
    ok: fromVendor,
    detail: fromVendor ? "node_modules has pi from vendor/pi/" : "run npm ci (scripts/setup.sh) to install pi from vendor/pi/",
    required: true,
  });

  try {
    const rows = loadTaskRows(CASES_PATH);
    checks.push({ name: "rule-loss cases", ok: rows.length === 17, detail: `${rows.length} cases in data/rule-loss/cases.jsonl`, required: true });
  } catch (e) {
    checks.push({ name: "rule-loss cases", ok: false, detail: String(e).slice(0, 200), required: true });
  }

  const released = existsSync(join(REPO_ROOT, "results/MANIFEST.sha256"));
  checks.push({
    name: "released study rows",
    ok: released,
    detail: released ? "results/ present (scripts/rqN/sM-*/analyze.py can regenerate the paper's numbers)" : "results/MANIFEST.sha256 absent -- the per-study analyses need results/",
    required: false,
  });

  // Python >= 3.12: its float sum() is compensated, and the released analyses were computed that
  // way, and 3.11 can differ in the last digits of a float sum.
  const libs = python(
    "import sys, numpy, pandas; v = sys.version_info; print(f'{v.major}.{v.minor}.{v.micro} numpy {numpy.__version__}, pandas {pandas.__version__}')",
  );
  const pyVersion = libs?.split(" ", 1)[0] ?? "";
  const [major = 0, minor = 0] = pyVersion.split(".").map(Number);
  const pyNewEnough = major > 3 || (major === 3 && minor >= 12);
  checks.push({
    name: "python3 + numpy",
    ok: libs !== null && pyNewEnough,
    detail:
      libs === null
        ? "python with numpy and pandas is needed by arcbench evaluate -- run scripts/setup.sh"
        : pyNewEnough
          ? `Python ${libs} via ${pythonExecutable()}`
          : `Python ${pyVersion} at ${pythonExecutable()} is too old: arcbench evaluate needs >= 3.12 -- re-run scripts/setup.sh with a newer python3, or set ARCBENCH_PYTHON`,
    required: false,
  });

  for (const c of checks) console.log(`${c.ok ? "ok  " : c.required ? "FAIL" : "warn"}  ${c.name.padEnd(20)} ${c.detail}`);
  const failed = checks.filter((c) => c.required && !c.ok).length;
  console.log(failed === 0 ? "ready" : `${failed} required check(s) failed`);
  return failed === 0 ? 0 : 1;
}
