#!/usr/bin/env bash
# One-time environment setup for the ARCBench (Agent Rule Compliance Benchmark).
#
#   scripts/setup.sh   Node packages (incl. the vendored pi) + Python venv for metrics
#
# Needs Node >= 22.19 (24.19.0 is what the benchmark was verified with; see .nvmrc) and Python >= 3.12
# (3.13 verified; 3.11's float sum() rounds differently in the last digits).
# Set PYTHON=/path/to/python3.13 if your default python3 is older.
# Everything is installed inside this directory: node_modules/ and .venv/.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

for arg in "$@"; do
  echo "unknown option: $arg" >&2; exit 2
done

echo "== Node"
command -v node >/dev/null || { echo "node not found: install Node >= 22.19 (e.g. nvm install)" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<19)) { console.error("Node "+process.versions.node+" is too old; need >= 22.19"); process.exit(1) }'
echo "node $(node -v), npm $(npm -v)"

echo "== npm ci (installs pi from vendor/pi/ and the locked dependencies)"
npm ci --no-audit --no-fund

echo "== Python venv (.venv) for metrics"
py="${PYTHON:-python3}"
command -v "$py" >/dev/null || { echo "$py not found: install Python >= 3.12" >&2; exit 1; }
"$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else "Python %d.%d is too old: need >= 3.12 (set PYTHON=...)" % sys.version_info[:2])'
[ -d .venv ] || "$py" -m venv .venv
.venv/bin/python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' ||
  { echo ".venv/ was created with Python < 3.12: remove it (rm -rf .venv) and re-run" >&2; exit 1; }
.venv/bin/python3 -m pip install --quiet --upgrade pip
.venv/bin/python3 -m pip install --quiet -r requirements.txt

echo "== preflight"
./arcbench preflight || true
cat <<'NEXT'

Setup done. Next:
  export OPENROUTER_API_KEY=sk-or-...   # only needed for live runs
  ./arcbench --help
NEXT
