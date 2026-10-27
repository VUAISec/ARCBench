"""S1 baseline (RQ1): where violations after compaction come from.

Hermes, four agent models, delivery channels c1-c4, no added content, no compaction budget constraint.
Compacted runs are ladder condition G2; the matched full-context baseline is G1 (same case, model and
channel). Reproduces Table rq1 and rq1-behavior and Appendix Tables rq1-full, rq1-rule-state-models and
rq1-behavior-models.

  python3 scripts/rq1/s1-baseline/analyze.py      # -> results/rq1/s1-baseline/analysis/
"""
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
from metrics import attribution as A  # noqa: E402


def main():
    root, out = A.cli(A.S1, __doc__)
    A.load_verdicts([A.S1], root)
    cs = A.s1_cases(root)
    groups = defaultdict(list)
    A.by_model(groups, "S1", cs, lambda c: None)
    for c in cs:
        groups[f"S1|channel:{c['channel']}"].append(c)
        groups[f"S1|model:{c['model']}|channel:{c['channel']}"].append(c)
    res = A.summarize_groups(groups)
    A.write_json(os.path.join(out, "numbers.json"), res)
    models = [("All", "S1")] + [(n, f"S1|model:{m}") for n, m in A.MODELS]
    by_mc = []
    for n, key in models:
        by_mc.append((f"**{n}**", res[key]))
        for ch in ("c1", "c2", "c3", "c4"):
            k = f"S1|channel:{ch}" if n == "All" else f"{key}|channel:{ch}"
            by_mc.append((f"&nbsp;&nbsp;{ch}", res[k]))
    rows_ = [(n, res[k]) for n, k in models]
    A.write_report(os.path.join(out, "tables.md"), "S1 baseline (RQ1)", [
        A.attribution_table("Violation attribution (Table rq1; Appendix Table rq1-full by model and delivery channel)", by_mc),
        A.rule_state_table("Runs by rule state and model (Appendix Table rq1-rule-state-models)", rows_),
        A.behaviour_table("Agent behavior labels (Table rq1-behavior; Appendix Table rq1-behavior-models)", rows_),
    ])
    print(f"wrote {out}/numbers.json and tables.md ({len(res)} groups)")


if __name__ == "__main__":
    main()
