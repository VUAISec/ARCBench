"""S6 attack (RQ3): six compactor-targeted injection attacks and no attack, no defense.

Hermes, GLM, c1/c3, k = 6. Every attack has a full-context baseline with the same attack. Only no
attack and escape have rule-state labels, so the other attacks get violation@6 and the mean violation
rate only. Reproduces Appendix Table rq3-s6-attacks and the no-attack and escape rows of Tables
rq3-attribution, rq3-behavior and rq3-rule-state.

  python3 scripts/rq3/s6-attack/analyze.py        # -> results/rq3/s6-attack/analysis/
"""
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
from metrics import attribution as A  # noqa: E402


def main():
    root, out = A.cli(A.S6, __doc__)
    A.load_verdicts([A.S6], root)
    groups = defaultdict(list)
    for c in A.attack_cases([A.S6], root):
        groups[f"S6|{c['attack']}"].append(c)
    res = A.summarize_groups(groups, k=6)
    full = [r for r in A.rows(A.S6, root) if r["spec"]["contextHandling"] == "full"]
    case = lambda r: (r["taskId"], A.attack_of(r))
    res["S6 violation@6, every attack"] = A.violation_at_k(
        A.S6, root, k=6, compacted_key=lambda r: (A.attack_of(r), case(r)) if r["spec"]["contextHandling"] == "compacted" else None,
        full_key=case, full_rows=full)
    A.write_json(os.path.join(out, "numbers.json"), res)
    vk = res["S6 violation@6, every attack"]
    lines = ["### violation@6 by attack (Appendix Table rq3-s6-attacks)", "",
             "| Attack | Cases | Full context | Compacted | Mean violation rate, compacted |", "|---|---:|---:|---:|---:|"]
    lines += [f"| {n} | {vk[a]['cases']} | {A.f1(vk[a]['full'])} | {A.f1(vk[a]['comp'])} | {A.f1(vk[a]['vr_comp'])} |"
              for n, a in A.ATTACKS]
    rows_ = [(n, res[f"S6|{a}"]) for n, a in (("No attack", "none"), ("Escape", "escape"))]
    A.write_report(os.path.join(out, "tables.md"), "S6 attack (RQ3)", [
        "\n".join(lines) + "\n",
        A.attribution_table("Violation attribution, labeled attacks (Table rq3-attribution)", rows_),
        A.rule_state_table("Runs by rule state (Appendix Table rq3-rule-state)", rows_),
        A.behaviour_table("Agent behavior labels (Table rq3-behavior)", rows_, groups=(("ret_only", "Retained, only after compaction"),)),
    ])
    print(f"wrote {out}/numbers.json and tables.md ({len(res)} groups)")


if __name__ == "__main__":
    main()
