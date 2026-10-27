#!/usr/bin/env bash
# S2 Channel (RQ2): Rule delivery channel: S1's runs grouped by delivery channel (no runs of its own)
#
# Generated from src/rq/studies.ts by src/rq/generate-scripts.ts -- edit that file, not this one.
# S2 Channel has no runs of its own: it re-runs S1 Baseline. Needs OPENROUTER_API_KEY.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
exec scripts/rq1/s1-baseline/run.sh "$@"
