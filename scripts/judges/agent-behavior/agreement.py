"""Agent behavior judge, validation: the panel's labels against human labels on a held-out test set.

The test set is 24 violating runs labeled by hand (results/judges/agent-behavior/test-set/;
role "holdout" in adjudication.csv), with the four definitions and seeing only the case, the rule,
the request, the agent's reasoning and the tool call. The labels were finalized after reviewing
disagreements with the model labels ("adjudicated"); the blind first-pass labels are scored too.
Reports raw agreement and Cohen's kappa over the four labels and for approval versus the rest, for
the consensus and for each judge, reading every study's agent-behavior/labels.csv.

  python3 scripts/judges/agent-behavior/agreement.py [--results results] [--out results/judges/agent-behavior/agreement.json]
"""
import argparse
import csv
import glob
import json
import os
from collections import Counter

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
LABELS = ["approval", "scope", "unregistered", "acknowledged"]
JUDGES = {"consensus (Luna + Sol + Sonnet 5.5)": "consensus", "GPT-6-Luna-Pro": "gpt_6_luna_pro",
          "GPT-6.1-Sol": "gpt_6_1_sol", "Claude Sonnet 5.5": "claude_sonnet_5_5"}
EXCLUDED_EXAMPLES = {"L004", "L008", "L024", "L040"}  # supplementary items, never shown as examples


def kappa(pairs):
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum(ca[l] * cb[l] for l in set(ca) | set(cb)) / (n * n)
    return round(po, 3), round((po - pe) / (1 - pe), 3)


def binary(pairs):
    f = lambda x: "approval" if x == "approval" else "other"
    return [(f(a), f(b)) for a, b in pairs]


def score(gold, pred, ids):
    pairs = [(gold[r], pred[r]) for r in ids if pred.get(r) in LABELS]
    raw4, k4 = kappa(pairs)
    rawb, kb = kappa(binary(pairs))
    return {"n_items": len(ids), "n_scored": len(pairs), "n_unresolved_or_missing": len(ids) - len(pairs),
            "raw_4way": raw4, "kappa_4way": k4, "raw_binary": rawb, "kappa_binary": kb,
            "confusion_gold_rows": {g: {p: sum(1 for a, b in pairs if a == g and b == p) for p in LABELS} for g in LABELS}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--results", default=os.path.join(REPO, "results"))
    ap.add_argument("--out")
    a = ap.parse_args()
    labels = {}
    for p in glob.glob(os.path.join(a.results, "rq*", "*", "agent-behavior", "labels.csv")):
        with open(p, encoding="utf-8") as f:
            labels.update({r["runId"]: r for r in csv.DictReader(f)})
    with open(os.path.join(a.results, "judges", "agent-behavior", "test-set", "adjudication.csv"), encoding="utf-8") as f:
        adj = {r["runId"]: r for r in csv.DictReader(f)}
    gold_adj = {r: v["adjudicated_label"] for r, v in adj.items()}
    gold_blind = {r: v["original_blind_label"] for r, v in adj.items()}
    primary = [r for r, v in adj.items() if v["role"] == "holdout"]
    supp = primary + [r for r, v in adj.items() if v["item_id"] in EXCLUDED_EXAMPLES]
    preds = {n: {r: row[col] for r, row in labels.items()} for n, col in JUDGES.items()}
    rep = {"note": "Adjudicated labels were revised after seeing model labels; kappas against them are optimistic. "
                   "Blind-label kappas are given for disclosure.",
           "primary_24_heldout": {n: {"vs_adjudicated": score(gold_adj, p, primary), "vs_blind": score(gold_blind, p, primary)}
                                  for n, p in preds.items()},
           "supplementary_28": {n: {"vs_adjudicated": score(gold_adj, p, supp), "vs_blind": score(gold_blind, p, supp)}
                                for n, p in preds.items()},
           "consensus_counts": dict(Counter(r["consensus"] for r in labels.values()))}
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(rep, f, indent=2)
    for n in JUDGES:
        s, b = rep["primary_24_heldout"][n]["vs_adjudicated"], rep["primary_24_heldout"][n]["vs_blind"]
        print(f"{n:36s} adjudicated kappa {s['kappa_4way']:.2f} (approval vs rest {s['kappa_binary']:.2f}, n={s['n_scored']})"
              f" | blind {b['kappa_4way']:.2f} ({b['kappa_binary']:.2f})")
    print("consensus counts:", rep["consensus_counts"])


if __name__ == "__main__":
    main()
