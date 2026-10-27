"""S3 compaction strategy (RQ2), and the same study under added content (RQ3 appendix).

Ten compaction strategies in two families, four agent models, c1/c3. Without added content the
Hermes cells are S1's runs (c1/c3), and with volume injection or both injections they are S5's, as
the strategy study did not re-run them; see metrics/attribution.py:s3_cases for the baselines.
Reproduces the strategy rows of Tables rq2-attribution, rq2-behavior and rq2-rule-state, Appendix
Tables rq2-strategies-full, rq2-strategies-models and rq2-behavior-full, and, under added content,
Appendix Tables rq3-strategies and the strategy rows of rq3-rule-state.

  python3 scripts/rq2/s3-strategy/analyze.py      # -> results/rq2/s3-strategy/analysis/
"""
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
from metrics import attribution as A  # noqa: E402

STRATEGIES = [("*Generative*", "family:generative")] + [(n, s) for n, s in A.GENERATIVE] + \
             [("*Selective*", "family:selective")] + [(n, s) for n, s in A.SELECTIVE_NAMES]


def main():
    root, out = A.cli(A.S3, __doc__)
    A.load_verdicts([A.S1, A.S3, A.S5], root)
    cs = A.s3_cases(root)
    groups = defaultdict(list)
    none = [c for c in cs if c["added"] == "none"]
    A.by_model(groups, "S3", none, lambda c: c["strategy"])
    A.by_model(groups, "S3", none, lambda c: "family:" + c["family"])
    for c in cs:  # every added-content condition (RQ3 appendix)
        for g in (c["strategy"], "family:" + c["family"]):
            groups[f"SX|{g}|{c['added']}"].append(c)
    res = A.summarize_groups(groups)
    A.write_json(os.path.join(out, "numbers.json"), res)
    rows_ = [(n, res[f"S3|{s}"]) for n, s in STRATEGIES]
    by_model = [(f"{n} / {mn}", res[f"S3|{s}|model:{m}"]) for n, s in STRATEGIES for mn, m in A.MODELS]
    added = [(f"{n} / {an}", res[f"SX|{s}|{a}"]) for n, s in STRATEGIES for an, a in A.ADDED]
    A.write_report(os.path.join(out, "tables.md"), "S3 compaction strategy (RQ2; RQ3 appendix)", [
        A.attribution_table("Violation attribution by strategy, no added content (Table rq2-attribution; "
                            "Appendix Table rq2-strategies-full)", rows_),
        A.rule_state_table("Runs by rule state (Appendix Table rq2-rule-state)", rows_),
        A.behaviour_table("Agent behavior labels (Table rq2-behavior; Appendix Table rq2-behavior-full)", rows_,
                          groups=(("ret_only", "Retained, only after compaction"),)),
        A.attribution_table("By strategy and agent model (Appendix Table rq2-strategies-models)", by_model),
        A.attribution_table("Under added content (Appendix Table rq3-strategies)", added),
        A.rule_state_table("Runs by rule state under added content (Appendix Table rq3-rule-state)", added),
    ])
    print(f"wrote {out}/numbers.json and tables.md ({len(res)} groups)")


if __name__ == "__main__":
    main()
