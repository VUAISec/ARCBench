"""S5 injection (RQ3): volume injection (V), compactor-targeted injection (I), and both.

Hermes, four agent models, c1-c4. The no-added-content row is S1's runs; S5 has no full-context runs
with added content, so its baseline is S1's full-context runs. Reproduces the S5 rows of Tables
rq3-attribution and rq3-behavior and Appendix Tables rq3-s5-models and rq3-rule-state.

  python3 scripts/rq3/s5-injection/analyze.py     # -> results/rq3/s5-injection/analysis/
"""
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
from metrics import attribution as A  # noqa: E402


def main():
    root, out = A.cli(A.S5, __doc__)
    A.load_verdicts([A.S1, A.S5], root)
    groups = defaultdict(list)
    A.by_model(groups, "S5", A.s5_cases(root), lambda c: c["added"])
    res = A.summarize_groups(groups)
    A.write_json(os.path.join(out, "numbers.json"), res)
    rows_ = [(n, res[f"S5|{a}"]) for n, a in A.ADDED]
    by_model = [(f"{mn} / {n}", res[f"S5|{a}|model:{m}"]) for mn, m in A.MODELS for n, a in A.ADDED]
    A.write_report(os.path.join(out, "tables.md"), "S5 injection (RQ3)", [
        A.attribution_table("Violation attribution by added content (Table rq3-attribution)", rows_),
        A.rule_state_table("Runs by rule state (Appendix Table rq3-rule-state)", rows_),
        A.behaviour_table("Agent behavior labels (Table rq3-behavior)", rows_, groups=(("ret_only", "Retained, only after compaction"),)),
        A.attribution_table("By agent model (Appendix Table rq3-s5-models)", by_model),
    ])
    print(f"wrote {out}/numbers.json and tables.md ({len(res)} groups)")


if __name__ == "__main__":
    main()
