"""Agent behavior judge, step 1: build the judge inputs of a study from its recorded trajectories.

Population (one row per violating run with the rule in context):
  * compacted runs whose rule state is retained (rule state judge, <model>/judgments*.jsonl) and
    that violate the rule, and
  * full-context runs with the rule present that violate it, the comparison group. In S6 only the
    full-context runs of attacks that have rule-state labels are included.

An absent or partially retained rule already explains a violation; a retained one does not, so only
then does the agent's own reasoning have to.

The agent's reasoning is read from the run's trajectory, step by step, up to and including the first
decision step that calls the graded tool: the message `reasoning`, readable `reasoning_details`
entries (text or summary; encrypted entries are skipped), and the message `content`. A run without
readable text is kept with hasReasoning=false and labeled unobservable, with no judge call.

  python3 scripts/judges/agent-behavior/extract-reasoning.py --study runs/rq1/s1-baseline [--raw DIR]

--raw is the directory holding <modelDir>/raw/<runId>/trajectory.jsonl; it defaults to the study
directory, which is where `./arcbench run` writes them. The released results/ hold no trajectories,
but they do hold this step's output, <study>/agent-behavior/inputs.jsonl, which is self-contained.

Standard library only.
"""
import argparse
import glob
import json
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
MAX_CHARS = 8000  # keep the tail: the text nearest the action
LADDER_COMPACTED = {"G2", "G3", "G4", "G5"}


def jsonl(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def cases():
    return {c["id"]: c for c in jsonl(os.path.join(REPO, "data", "rule-loss", "cases.jsonl"))}


def is_violation(row):
    return (row.get("outcome") or {}).get("binaryLabel") == "violation"


def step_text(step):
    """Readable reasoning and message text of one decision step."""
    parts = []
    msg = (((step.get("rawResponse") or {}).get("choices") or [{}])[0] or {}).get("message") or {}
    reasoning = msg.get("reasoning")
    if isinstance(reasoning, str) and reasoning.strip():
        parts.append(reasoning.strip())
    else:
        for d in msg.get("reasoning_details") or []:
            if d.get("type") in ("reasoning.text", "reasoning.summary"):
                t = d.get("text") or d.get("summary") or ""
                if t.strip():
                    parts.append(t.strip())
    content = step.get("assistantText") or msg.get("content") or ""
    if isinstance(content, str) and content.strip():
        parts.append(content.strip())
    return "\n".join(parts)


def read_trajectory(path, graded_tool):
    """Concatenate step text up to the first step calling the graded tool."""
    texts, calls = [], []
    for e in jsonl(path):
        if e.get("type") != "decision_step":
            continue
        t = step_text(e)
        if t:
            texts.append(f"[step {e.get('step')}] {t}")
        hit = [c for c in e.get("toolCalls") or [] if c.get("name") == graded_tool]
        if hit:
            calls = hit
            break
    text = "\n\n".join(texts)
    truncated = len(text) > MAX_CHARS
    return (text[-MAX_CHARS:] if truncated else text), truncated, calls


def normalise(row):
    """v1.1 ladder rows (S1, S5) onto the fields make_row reads; v1.2 rows unchanged."""
    if "condition" not in row:
        return row, row["spec"]["contextHandling"], {}
    cond = row["condition"]
    norm = {
        "runId": row["runId"], "model": row["provenance"]["agentModel"], "taskId": row["taskOrSampleId"],
        "outcome": row["outcome"], "valid": row.get("valid"),
        "spec": {"compactionStrategy": (row.get("compaction") or {}).get("strategy"), "policyPresent": True,
                 "attackPresent": cond in ("G4", "G5"), "fillerPresent": cond in ("G3", "G5")},
    }
    context = "full" if cond == "G1" else ("compacted" if cond in LADDER_COMPACTED else None)
    return norm, context, {"condition": cond, "deliveryChannel": row["policyChannel"]}


def make_row(study, row, context, rule_state, case, traj_path, extra):
    graded_tool = case["grader"]["tool"]
    missing = traj_path is None or not os.path.exists(traj_path)
    if missing:  # recorded, never silently dropped
        text, truncated, calls = "", False, []
    else:
        text, truncated, calls = read_trajectory(traj_path, graded_tool)
    if not calls:  # fall back to the graded calls recorded on the row
        calls = [c for c in (row["outcome"].get("toolCalls") or []) if c.get("name") == graded_tool]
    spec = row["spec"]
    return {
        "runId": row["runId"],
        "study": study,
        "context": context,
        "ruleState": rule_state,
        "model": row["model"],
        "taskId": row["taskId"],
        "taskScenario": "personal" if case["channel_affinity"] in ("c1", "c2") else "organizational",
        "strategy": spec.get("compactionStrategy"),
        "attack": spec.get("attackTechnique") or ("injection" if spec.get("attackPresent") else "none"),
        "filler": spec.get("fillerPresent"),
        "defense": spec.get("defense"),
        "rule": case["policy"],
        "request": case["trigger"],
        "toolCalls": [{"name": c.get("name"), "args": c.get("args")} for c in calls],
        "reasoning": text,
        "reasoningTruncated": truncated,
        "hasReasoning": bool(text.strip()),
        "trajectoryMissing": missing,
        **extra,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--study", required=True, help="study directory with <model>/results.jsonl and judgments")
    ap.add_argument("--raw", help="directory with <modelDir>/raw/<runId>/trajectory.jsonl (default: --study)")
    a = ap.parse_args()
    study = os.path.abspath(a.study)
    raw = os.path.abspath(a.raw or a.study)
    name = os.path.basename(study.rstrip("/"))
    cs = cases()
    tiers = {}
    for p in glob.glob(os.path.join(study, "*", "judgments*.jsonl")):
        tiers.update({j["runId"]: j["tier"] for j in jsonl(p)})
    if not tiers:
        sys.exit(f"no rule-state labels under {study}: run scripts/judges/rule-state/judge.ts --study {a.study} first")
    rows, labeled_attacks = [], set()
    for p in sorted(glob.glob(os.path.join(study, "*", "results.jsonl"))):
        model_dir = os.path.basename(os.path.dirname(p))
        for r in jsonl(p):
            norm, context, extra = normalise(r)
            if r.get("runId") in tiers:
                labeled_attacks.add(norm["spec"].get("attackTechnique") or "none")
            if not (r.get("valid") and is_violation(r) and norm["spec"].get("policyPresent", True)) or context is None:
                continue
            if context == "compacted" and tiers.get(r["runId"]) != "retained":
                continue
            traj = os.path.join(raw, model_dir, "raw", r["runId"], "trajectory.jsonl")
            rows.append((norm, context, extra, traj))
    out = []
    for norm, context, extra, traj in rows:
        if context == "full" and "attackTechnique" in norm["spec"] and (norm["spec"]["attackTechnique"] or "none") not in labeled_attacks:
            continue
        out.append(make_row(name, norm, context, "retained" if context == "compacted" else None, cs[norm["taskId"]], traj, extra))
    d = os.path.join(study, "agent-behavior")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "inputs.jsonl"), "w", encoding="utf-8") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {len(out)} rows to {d}/inputs.jsonl "
          f"({sum(r['hasReasoning'] for r in out)} with readable reasoning, {sum(r['trajectoryMissing'] for r in out)} without a trajectory)")


if __name__ == "__main__":
    main()
