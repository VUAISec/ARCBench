"""Violation attribution (metrics/attribution.py) and the per-study analyses built on it."""
import json
import os
import subprocess
import sys

import pytest

from metrics import attribution as A

REPO = A.REPO
STUDIES = ["rq1/s1-baseline", "rq2/s2-channel", "rq2/s3-strategy", "rq2/s4-budget", "rq3/s5-injection", "rq3/s6-attack", "rq3/s7-defense"]
HAVE_RESULTS = os.path.exists(os.path.join(REPO, "results", "MANIFEST.sha256"))


def runs(*states):
    return [(int(v), s, f"r{i}") for i, (v, s) in enumerate(states)]


@pytest.mark.parametrize("compacted,full,label", [
    (runs((1, "retained"), (0, "retained")), [(True, "f")], "both"),
    (runs((1, "retained"), (1, "absent")), [(False, "f")], "absent"),
    (runs((1, "partial"), (1, "retained")), [(False, "f")], "partial"),
    (runs((1, "retained"), (0, "absent")), [(False, "f")], "retained"),
    (runs((0, "retained")), [(True, "f")], "full_only"),
    (runs((0, "absent")), [(False, "f")], "none"),
])
def test_classify(compacted, full, label):
    assert A.classify(compacted, full) == label


def test_summarize_drops_incomplete_cases_and_splits_violation_at_k():
    A._VERDICTS.clear()
    cs = [{"runs": runs((1, "retained"), (0, "retained"), (0, "retained")), "full": [(False, "a")]},
          {"runs": runs((1, "absent"), (1, "absent"), (0, "partial")), "full": [(True, "b")]},
          {"runs": runs((1, "absent")), "full": [(False, "c")]}]  # one run only: dropped
    s = A.summarize(cs, k=3)
    assert s["dropped"] == 1 and s["case"]["cases"] == 2
    assert s["case"]["counts"] == {"both": 1, "absent": 0, "partial": 0, "retained": 1, "full_only": 0}
    assert s["case"]["comp"] == 100.0 and s["case"]["full"] == 50.0
    assert s["run"]["share_retained"] == 50.0


@pytest.mark.skipif(not HAVE_RESULTS, reason="results/MANIFEST.sha256 is absent")
@pytest.mark.parametrize("study", STUDIES)
def test_analysis_reproduces_the_released_numbers(study, tmp_path):
    script = os.path.join(REPO, "scripts", study, "analyze.py")
    subprocess.run([sys.executable, script, "--out", str(tmp_path)], check=True, capture_output=True, cwd=REPO)
    with open(tmp_path / "numbers.json", encoding="utf-8") as f, \
            open(os.path.join(REPO, "results", study, "analysis", "numbers.json"), encoding="utf-8") as g:
        assert json.load(f) == json.load(g)


@pytest.mark.skipif(not HAVE_RESULTS, reason="results/MANIFEST.sha256 is absent")
def test_headline_numbers():
    with open(os.path.join(REPO, "results", "rq1", "s1-baseline", "analysis", "numbers.json"), encoding="utf-8") as f:
        s1 = json.load(f)["S1"]
    # Paper, RQ1: violation@3 9.6% -> 37.8%; 70.1% / 26.9% / 3.0% of compacted runs retain / partially retain / lose the rule.
    assert (A.f1(s1["case"]["full"]), A.f1(s1["case"]["comp"]), A.f1(s1["case"]["own"])) == ("9.6", "37.8", "8.9")
    assert (A.f1(s1["run"]["share_retained"]), A.f1(s1["run"]["share_partial"]), A.f1(s1["run"]["share_absent"])) == ("70.1", "26.9", "3.0")
