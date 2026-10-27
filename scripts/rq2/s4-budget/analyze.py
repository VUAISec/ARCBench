"""S4 compaction budget constraint (RQ2).

Hermes under five compaction budgets (200-2,500 tokens), DeepSeek and GLM, c1/c3, volume injection in
every run. The matched full-context baseline is S3's full-context runs with volume injection (same
case and model). Reproduces the budget rows of Tables rq2-attribution, rq2-behavior and rq2-rule-state
and Appendix Table rq2-budget-models.

The study also ran the other six generative strategies under the same budgets. They have no
rule-state labels (the judge was run on Hermes and Pi), so for them this script gives violation@3 only.

  python3 scripts/rq2/s4-budget/analyze.py        # -> results/rq2/s4-budget/analysis/
"""
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
from metrics import attribution as A  # noqa: E402


def main():
    root, out = A.cli(A.S4, __doc__)
    A.load_verdicts([A.S3, A.S4], root)
    groups = defaultdict(list)
    A.by_model(groups, "S4", A.s4_cases(root), lambda c: c["budget"])
    res = A.summarize_groups(groups)
    full_v = [r for r in A.rows(A.S3, root) if r["spec"]["contextHandling"] == "full"]
    res["S4 violation@3, every strategy"] = A.violation_at_k(
        A.S4, root, k=3,
        compacted_key=lambda r: ((r["spec"]["compactionStrategy"], r["compaction"]["budget"]["budgetTokens"]), A.v12_full_key(r)),
        full_key=A.v12_full_key, full_rows=full_v)
    A.write_json(os.path.join(out, "numbers.json"), res)
    rows_ = [(f"{b:,}", res[f"S4|{b}"]) for b in A.BUDGETS]
    by_model = [(f"{b:,} / {mn}", res[f"S4|{b}|model:{m}"]) for mn, m in A.MODELS for b in A.BUDGETS
                if f"S4|{b}|model:{m}" in res]
    vk = res["S4 violation@3, every strategy"]
    lines = ["### violation@3 for every generative strategy (no rule-state labels)", "",
             "| Strategy | Budget | Cases | Full context | Compacted | Mean violation rate |", "|---|---:|---:|---:|---:|---:|"]
    for n, s in A.GENERATIVE:
        for b in A.BUDGETS:
            v = vk.get(str((s, b)))
            if v:
                lines.append(f"| {n} | {b:,} | {v['cases']} | {A.f1(v['full'])} | {A.f1(v['comp'])} | {A.f1(v['vr_comp'])} |")
    A.write_report(os.path.join(out, "tables.md"), "S4 compaction budget constraint (RQ2)", [
        A.attribution_table("Violation attribution by compaction budget, Hermes (Table rq2-attribution)", rows_),
        A.rule_state_table("Runs by rule state (Appendix Table rq2-rule-state)", rows_),
        A.behaviour_table("Agent behavior labels (Table rq2-behavior)", rows_, groups=(("ret_only", "Retained, only after compaction"),)),
        A.attribution_table("By budget and agent model (Appendix Table rq2-budget-models)", by_model),
        "\n".join(lines) + "\n",
    ])
    print(f"wrote {out}/numbers.json and tables.md ({len(res)} groups)")


if __name__ == "__main__":
    main()
