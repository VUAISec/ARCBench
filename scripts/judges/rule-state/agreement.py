"""Rule state judge, validation: the panel's labels against a human check of 40 judged summaries.

results/judges/rule-state/manual-check/verification.csv holds 40 compacted summaries drawn uniformly
(seed 20261013) from the judged summaries, each with the panel's median and final labels and the
human label. Reports agreement and Cohen's kappa of the human labels against the panel's final label
(median plus keyword check) and its median. See the folder's README for the labeling protocol.

  python3 scripts/judges/rule-state/agreement.py [--results results]
"""
import argparse
import csv
import os
from collections import Counter

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
LABELS = ["retained", "partially retained", "absent"]


def kappa(pairs):
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum(ca[l] * cb[l] for l in set(ca) | set(cb)) / (n * n)
    return po, (po - pe) / (1 - pe)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--results", default=os.path.join(REPO, "results"))
    a = ap.parse_args()
    with open(os.path.join(a.results, "judges", "rule-state", "manual-check", "verification.csv"), encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    print(f"{len(rows)} summaries; human labels: {dict(Counter(r['human_label'] for r in rows))}")
    for col in ("panel_final", "panel_median"):
        pairs = [(r["human_label"], r[col]) for r in rows]
        po, k = kappa(pairs)
        dis = [(r["item_id"], h, p) for r, (h, p) in zip(rows, pairs) if h != p]
        print(f"human vs {col:12s}: {sum(h == p for h, p in pairs)}/{len(pairs)} agree ({po:.3f}), Cohen's kappa {k:.3f}; "
              f"disagreements (item, human, panel): {dis}")


if __name__ == "__main__":
    main()
