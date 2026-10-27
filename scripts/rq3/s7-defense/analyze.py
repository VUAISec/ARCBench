"""S7 defense (RQ3): four compactor-side defenses, with no attack and under escape.

Hermes, GLM, c1/c3, k = 6. The rows without a defense are S6's (see results/rq3/s7-defense/README.md);
the baseline is S6's full-context runs with the same attack. Reproduces Appendix Tables rq3-s7-full and
rq3-behavior-full and the defense rows of Tables rq3-attribution, rq3-behavior and rq3-rule-state.

  python3 scripts/rq3/s7-defense/analyze.py       # -> results/rq3/s7-defense/analysis/
"""
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
from metrics import attribution as A  # noqa: E402


def main():
    root, out = A.cli(A.S7, __doc__)
    A.load_verdicts([A.S6, A.S7], root)
    groups = defaultdict(list)
    for c in A.attack_cases([A.S6, A.S7], root):
        groups[f"S7|{c['attack']}/{c['defense']}"].append(c)
    res = A.summarize_groups(groups, k=6)
    A.write_json(os.path.join(out, "numbers.json"), res)
    rows_ = [(f"{an} / {dn}", res[f"S7|{a}/{d}"]) for an, a in (("No attack", "none"), ("Escape", "escape"))
             for dn, d in A.DEFENSES]
    A.write_report(os.path.join(out, "tables.md"), "S7 defense (RQ3)", [
        A.attribution_table("Violation attribution by attack and defense (Table rq3-attribution; Appendix Table rq3-s7-full)", rows_),
        A.rule_state_table("Runs by rule state (Appendix Table rq3-rule-state)", rows_),
        A.behaviour_table("Agent behavior labels (Table rq3-behavior; Appendix Table rq3-behavior-full)", rows_,
                          groups=(("ret_only", "Retained, only after compaction"),)),
    ])
    print(f"wrote {out}/numbers.json and tables.md ({len(res)} groups)")


if __name__ == "__main__":
    main()
