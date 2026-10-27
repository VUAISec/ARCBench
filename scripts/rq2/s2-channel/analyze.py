"""S2 rule delivery channel (RQ2): S1's runs grouped by delivery channel.

S2 has no rows of its own: it reads results/rq1/s1-baseline/ (see results/rq2/s2-channel/README.md).
Reproduces the channel rows of Tables rq2-attribution, rq2-behavior and rq2-rule-state.

  python3 scripts/rq2/s2-channel/analyze.py       # -> results/rq2/s2-channel/analysis/
"""
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", ".."))
from metrics import attribution as A  # noqa: E402

S2 = "rq2/s2-channel"
CHANNELS = [("c1 direct instruction", "c1"), ("c2 persistence instruction", "c2"), ("c3 document-embedded", "c3"),
            ("c4 policy-tool fetching", "c4")]


def main():
    root, out = A.cli(S2, __doc__)
    A.load_verdicts([A.S1], root)
    groups = defaultdict(list)
    A.by_model(groups, "S2", A.s1_cases(root), lambda c: c["channel"])
    res = A.summarize_groups(groups)
    A.write_json(os.path.join(out, "numbers.json"), res)
    rows_ = [(n, res[f"S2|{c}"]) for n, c in CHANNELS]
    by_model = [(f"{n} / {mn}", res[f"S2|{c}|model:{m}"]) for n, c in CHANNELS for mn, m in A.MODELS]
    A.write_report(os.path.join(out, "tables.md"), "S2 rule delivery channel (RQ2)", [
        A.attribution_table("Violation attribution by delivery channel (Table rq2-attribution)", rows_),
        A.rule_state_table("Runs by rule state (Appendix Table rq2-rule-state)", rows_),
        A.behaviour_table("Agent behavior labels (Table rq2-behavior)", rows_),
        A.attribution_table("By delivery channel and agent model", by_model),
    ])
    print(f"wrote {out}/numbers.json and tables.md ({len(res)} groups)")


if __name__ == "__main__":
    main()
