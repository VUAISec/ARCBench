#!/usr/bin/env python3
"""Validate data/rule-loss/cases.jsonl schema and provenance.

Exits with code 0 and prints "ready" when the file passes all checks.
Exits with code 1 and prints an explicit blocked state when it fails.

Usage:
    python3 scripts/validate_cases.py data/rule-loss/cases.jsonl
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

# The v1.3 case set. `language` is gone: it failed a case-selection criterion — a non-English
# email has no adversarial upside — and was cut rather than retained as a control. The `language`
# CHECK survives in src/rule-loss/grader.ts; no shipped row uses it.
EXPECTED_IDS = {
    # Organizational — Governance Decay, arXiv:2606.22528v2
    "email", "channel", "deploy", "spend", "proddb", "secret", "pii", "seccontrol",
    # Organizational — authored
    "incidentfile",
    # Personal — COMPINT, arXiv:2608.11242, adapted to effect-grounded form
    "pname", "pphone", "pconfdir", "pdraft", "papprove",
    # Personal — authored, and one derived from `spend`
    "pgitforce", "ppublish", "pspend",
}

REQUIRED_FIELDS = {
    "id", "source_release", "source_fidelity", "provenance", "channel_affinity",
    "fixture_only", "system_prompt", "policy", "benign_turns", "trigger", "tools",
    "grader", "attack_inject",
}

# G3 volume is now a harness-generated RULER haystack audited against the policy.
# A row still carrying the old policy-paraphrase corpus must not be usable.
FORBIDDEN_FIELDS = {"attack_volume"}

VALID_FIDELITY = {"reconstructed-from-paper", "exact-release", "authored"}

# Kept separate from fidelity on purpose: fidelity answers "how faithful is this to a published
# release", provenance answers "where did this case come from". An authored case has no release
# to be faithful to, so one field carrying both would make a value mean two things.
VALID_PROVENANCE = {"GD", "CI", "DER", "NEW"}

# c2 is absent by construction. channelInstruction() hands the model the policy in a user turn
# and THEN asks it to persist the text, so c2 structurally contains c1 — it is a transform over
# a personal case, never a case's home channel.
VALID_AFFINITY = {"c1", "c3", "c4"}

GRADER_REQUIRED = {"tool", "check"}

# Every check type declares the config fields it cannot run without, so a missing
# value becomes a validation failure here instead of a silent grader default.
GRADER_REQUIRED_BY_CHECK = {
    "domain": ["allowed_domain"],
    "language": ["allowed_languages"],
    "forbidden_tool": ["required_tool"],
    "region": ["allowed_regions"],
    "amount_ceiling": ["ceiling"],
    "statement_pattern": ["forbidden_statements"],
    "path_pattern": ["forbidden_patterns"],
    "field_present": ["forbidden_fields"],
    # v1.3
    "forbidden_content": ["fields", "forbidden_patterns"],
    "required_precondition": ["required_preceding_tool"],
}

VALID_CHECKS = set(GRADER_REQUIRED_BY_CHECK)

# A tool schema reaches the model on every call and compaction cannot touch it, so a
# graded rule stated there contaminates every condition including the G0 floor.
POLICY_LEAK_PATTERNS = [
    r"must never",
    r"never (?:be )?includ",
    r"up to \$\d",
    r"requires? (?:manager )?approval",
    r"only (?:send|deploy|be sent) to",
    r"prohibited",
]


def fail(msg: str) -> None:
    # Every failure and blocked state goes to stderr, so one stream catches them all.
    print(msg, file=sys.stderr)
    sys.exit(1)


# The graded rule must exist in exactly one place: the c1 policy turn. It has been caught leaking
# into the G3 filler and into tool schemas; this catches the third channel, the benign transcript. A
# leak here is worse than a tool-schema leak: it sits inside `messages`, so it both destroys the G0
# floor (which has no policy turn, yet still carries the rule) and hands G2-G4 a second copy that
# can survive compaction independently of the policy.
#
# Precision matters — a deployment scenario necessarily says "region" and a procurement scenario
# necessarily says "order". A sentence is only a leak when it pairs a *graded literal* (the
# specific threshold, region, domain or field the grader keys on) with a *deontic marker*, i.e.
# when it asserts the obligation rather than merely describing the domain.
DEONTIC = (
    r"\b(?:must|shall|require[sd]?|requiring|only|never|not permitted|unauthori[sz]ed|"
    r"authori[sz]ed|approval|sign-off|threshold|policy|prohibited|forbidden|sole|restricted|"
    r"mandatory|bypass|compliance)\b"
)


def graded_literals(row):
    g = row["grader"]
    out = []
    for key in ("allowed_domain", "required_tool", "required_preceding_tool"):
        if g.get(key):
            out.append(str(g[key]))
    for key in ("allowed_regions", "forbidden_fields"):
        for v in g.get(key) or []:
            out.append(str(v))
    if isinstance(g.get("ceiling"), (int, float)):
        out.append(str(g["ceiling"]))
    for rule in g.get("forbidden_statements") or []:
        out += re.findall(r"[A-Za-z_][A-Za-z0-9_.]{4,}", rule["match"])
    for pattern in g.get("forbidden_patterns") or []:
        out += re.findall(r"[A-Za-z_][A-Za-z0-9_.]{4,}", pattern)
    if g.get("scope"):
        out += re.findall(r"[A-Za-z][A-Za-z0-9-]{3,}", g["scope"]["inScopePattern"])
    return sorted({x.lower() for x in out if len(x) >= 3})


def check_benign_context_leak(row):
    sid = row["id"]
    lits = graded_literals(row)
    for i, turn in enumerate(row["benign_turns"]):
        for sentence in re.split(r"(?<=[.!?\n])\s+", turn.get("content") or ""):
            low = sentence.lower()
            found = [l for l in lits if re.search(rf"(?<![a-z0-9]){re.escape(l)}(?![a-z0-9])", low)]
            if found and re.search(DEONTIC, low, re.I):
                fail(
                    f"blocked_dataset_validation: task {sid!r} benign turn {i} restates the graded "
                    f"rule (literal(s) {found} with a deontic marker) \u2014 the G0 floor would still "
                    f"carry the policy: {sentence.strip()[:160]!r}"
                )


def check_tool_call_sequence(sid, turns):
    """Every tool result must reference a call declared in the preceding assistant turn.

    Catching this at dataset-build time beats discovering it as an HTTP 400 mid-run.
    """
    declared = {}
    for i, turn in enumerate(turns):
        role = turn.get("role")
        if role == "assistant":
            declared = {}
            for call in turn.get("tool_calls") or []:
                cid = call.get("id")
                if not cid:
                    fail(f"blocked_dataset_validation: task {sid!r} turn {i} tool_call has no id")
                if not call.get("name"):
                    fail(f"blocked_dataset_validation: task {sid!r} turn {i} tool_call has no name")
                if cid in declared:
                    fail(f"blocked_dataset_validation: task {sid!r} duplicate tool_call id {cid!r}")
                declared[cid] = call["name"]
        elif role == "tool":
            cid = turn.get("tool_call_id")
            if cid not in declared:
                fail(
                    f"blocked_dataset_validation: task {sid!r} turn {i} tool result references "
                    f"tool_call_id {cid!r}, which the preceding assistant turn never declared"
                )
            if declared[cid] != turn.get("tool_name"):
                fail(
                    f"blocked_dataset_validation: task {sid!r} turn {i} tool result name "
                    f"{turn.get('tool_name')!r} does not match declared call {declared[cid]!r}"
                )
        elif role != "user":
            fail(f"blocked_dataset_validation: task {sid!r} turn {i} has unknown role {role!r}")


def check_tool_schemas(sid, tools, grader):
    """The graded tool must exist, and no schema may restate a graded rule."""
    names = set()
    for tool in tools:
        f = tool.get("function")
        if not isinstance(f, dict) or not f.get("name"):
            fail(f"blocked_dataset_validation: task {sid!r} has a tool with no function.name")
        names.add(f["name"])

        texts = [(f"{f['name']} description", f.get("description", ""))]
        for pname, pval in (f.get("parameters", {}).get("properties") or {}).items():
            texts.append((f"{f['name']}.{pname} description", pval.get("description", "")))
        for label, text in texts:
            for pattern in POLICY_LEAK_PATTERNS:
                if re.search(pattern, text or "", re.IGNORECASE):
                    fail(
                        f"blocked_dataset_validation: task {sid!r} policy leak in tool schema — "
                        f"{label}: {text!r} matches {pattern!r}"
                    )

    scope = grader.get("scope")
    if scope is not None:
        graded = next((t["function"] for t in tools if t.get("function", {}).get("name") == grader.get("tool")), None)
        props = (graded or {}).get("parameters", {}).get("properties", {})
        if scope.get("field") not in props:
            fail(
                f"blocked_dataset_validation: task {sid!r} grader.scope.field {scope.get('field')!r} "
                f"is not a parameter of {grader.get('tool')!r}"
            )

    if grader.get("tool") not in names:
        fail(
            f"blocked_dataset_validation: task {sid!r} grader.tool {grader.get('tool')!r} "
            f"is not one of the row's tools {sorted(names)}"
        )
    for key in ("required_tool", "required_preceding_tool"):
        named = grader.get(key)
        if named is not None and named not in names:
            fail(
                f"blocked_dataset_validation: task {sid!r} grader.{key} "
                f"{named!r} is not one of the row's tools {sorted(names)}"
            )

    # `forbidden_content` names the argument fields the policy covers. A field the graded
    # tool does not declare means the check reads nothing and silently grades every call
    # `unparseable` — the same class of error as a grader.scope.field that is not a parameter.
    if grader.get("check") == "forbidden_content":
        graded = next(
            (t["function"] for t in tools if t.get("function", {}).get("name") == grader.get("tool")),
            None,
        )
        props = (graded or {}).get("parameters", {}).get("properties", {})
        unknown = [f for f in grader.get("fields") or [] if f not in props]
        if unknown:
            fail(
                f"blocked_dataset_validation: task {sid!r} grader.fields {unknown} are not "
                f"parameters of {grader.get('tool')!r} {sorted(props)}"
            )


def check_grader_config(sid, grader):
    """Required config present, and every regex actually compiles."""
    check = grader.get("check")
    for field in GRADER_REQUIRED_BY_CHECK[check]:
        val = grader.get(field)
        if val is None or val == "" or val == [] or val == {}:
            fail(
                f"blocked_dataset_validation: task {sid!r} grader.check {check!r} "
                f"requires non-empty {field!r}"
            )
    patterns = list(grader.get("forbidden_patterns") or [])
    patterns += list(grader.get("exempt_patterns") or [])
    for rule in grader.get("forbidden_statements") or []:
        if not isinstance(rule, dict) or not rule.get("match"):
            fail(f"blocked_dataset_validation: task {sid!r} forbidden_statements entry needs a 'match': {rule!r}")
        patterns.append(rule["match"])
        if rule.get("unless"):
            patterns.append(rule["unless"])
    scope = grader.get("scope")
    if scope is not None:
        if not isinstance(scope, dict) or not scope.get("field") or not scope.get("inScopePattern"):
            fail(f"blocked_dataset_validation: task {sid!r} grader.scope needs 'field' and 'inScopePattern'")
        patterns.append(scope["inScopePattern"])
    for pattern in patterns:
        try:
            re.compile(pattern)
        except re.error as e:
            fail(f"blocked_dataset_validation: task {sid!r} pattern {pattern!r} does not compile: {e}")


def validate(path: str) -> None:
    p = Path(path)
    if not p.exists():
        fail("blocked_missing_constraintrot_release")

    try:
        rows = []
        with open(p, encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as e:
                    fail(f"blocked_dataset_validation: line {i} is not valid JSON: {e}")
    except OSError as e:
        fail(f"blocked_missing_constraintrot_release: {e}")

    if not rows:
        fail("blocked_missing_constraintrot_release")

    seen_ids: set[str] = set()
    for row in rows:
        sid = row.get("id", "<missing>")

        # Required fields
        missing = REQUIRED_FIELDS - set(row.keys())
        if missing:
            fail(f"blocked_dataset_validation: task {sid!r} missing fields: {missing}")

        # No empty values
        for field in REQUIRED_FIELDS:
            val = row.get(field)
            if val is None or val == "" or val == [] or val == {}:
                fail(f"blocked_dataset_validation: task {sid!r} field {field!r} is empty")

        # fixture_only must be false for real data
        if row.get("fixture_only") is not False:
            fail(f"blocked_dataset_validation: task {sid!r} fixture_only must be false")

        forbidden = FORBIDDEN_FIELDS & set(row.keys())
        if forbidden:
            fail(
                f"blocked_dataset_validation: task {sid!r} carries retired field(s) {sorted(forbidden)}; "
                f"regenerate with scripts/cases/gen_cases.py (P1)"
            )

        # source_release must be present
        if not row.get("source_release"):
            fail(f"blocked_dataset_validation: task {sid!r} source_release is empty")

        if row.get("provenance") not in VALID_PROVENANCE:
            fail(
                f"blocked_dataset_validation: task {sid!r} provenance {row.get('provenance')!r} "
                f"not in {sorted(VALID_PROVENANCE)}"
            )

        if row.get("channel_affinity") == "c2":
            fail(
                f"blocked_dataset_validation: task {sid!r} declares channel_affinity 'c2', which is "
                f"not a home channel: channelInstruction() delivers the policy in a user turn before "
                f"asking the model to persist it, so c2 structurally contains c1"
            )
        if row.get("channel_affinity") not in VALID_AFFINITY:
            fail(
                f"blocked_dataset_validation: task {sid!r} channel_affinity "
                f"{row.get('channel_affinity')!r} not in {sorted(VALID_AFFINITY)}"
            )

        # Fidelity must be machine-readable and one of the known values.
        if row.get("source_fidelity") not in VALID_FIDELITY:
            fail(
                f"blocked_dataset_validation: task {sid!r} source_fidelity "
                f"{row.get('source_fidelity')!r} not in {sorted(VALID_FIDELITY)}"
            )

        # Grader shape
        grader = row.get("grader", {})
        if not isinstance(grader, dict):
            fail(f"blocked_dataset_validation: task {sid!r} grader must be a dict")
        grader_missing = GRADER_REQUIRED - set(grader.keys())
        if grader_missing:
            fail(f"blocked_dataset_validation: task {sid!r} grader missing fields: {grader_missing}")
        if grader.get("check") not in VALID_CHECKS:
            fail(f"blocked_dataset_validation: task {sid!r} grader.check {grader.get('check')!r} not recognized")
        check_grader_config(sid, grader)

        # Tools must be a non-empty list
        tools = row.get("tools", [])
        if not isinstance(tools, list) or len(tools) == 0:
            fail(f"blocked_dataset_validation: task {sid!r} tools must be a non-empty list")

        check_tool_schemas(sid, tools, grader)

        # Benign turns must be a non-empty list
        bt = row.get("benign_turns", [])
        if not isinstance(bt, list) or len(bt) == 0:
            fail(f"blocked_dataset_validation: task {sid!r} benign_turns must be a non-empty list")
        check_tool_call_sequence(sid, bt)
        check_benign_context_leak(row)

        # Duplicate IDs
        if sid in seen_ids:
            fail(f"blocked_dataset_validation: duplicate task id {sid!r}")
        seen_ids.add(sid)

    # ID set check
    missing_ids = EXPECTED_IDS - seen_ids
    extra_ids = seen_ids - EXPECTED_IDS

    if missing_ids:
        fail(f"blocked_missing_constraintrot_release: missing task ids: {sorted(missing_ids)}")

    if extra_ids:
        fail(f"blocked_dataset_validation: unexpected task ids: {sorted(extra_ids)}")

    print("ready")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"usage: {sys.argv[0]} <path-to-constraintrot.jsonl>", file=sys.stderr)
        sys.exit(2)
    validate(sys.argv[1])
