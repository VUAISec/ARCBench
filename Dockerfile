# Reproducible environment for ARCBench (Agent Rule Compliance Benchmark).
#
#   docker build -t arcbench .
#   docker run --rm -e OPENROUTER_API_KEY \
#     -v "$PWD/results:/benchmark/results:ro" -v "$PWD/runs:/benchmark/runs" arcbench preflight
#
# README.md (Setup, Option B) wraps that in the `arcbench-docker` / `arcbench-docker-sh` shorthands.
# The released rows (results/, read-only) and new runs (runs/) are mounted, never baked in
# (.dockerignore).
#
# pi is installed from vendor/pi/ like any local setup; nothing is fetched beyond the npm and PyPI
# packages pinned in package-lock.json and requirements.txt.
# Debian 13 (trixie): its python3 is 3.13; the benchmark needs >= 3.12 (see scripts/setup.sh).
FROM node:24.19.0-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /benchmark

# Node dependencies first, so source edits do not invalidate this layer.
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --no-audit --no-fund

COPY requirements.txt ./
RUN python3 -m venv .venv && .venv/bin/python3 -m pip install --no-cache-dir -r requirements.txt

COPY . .
ENV ARCBENCH_PYTHON=/benchmark/.venv/bin/python3

ENTRYPOINT ["./arcbench"]
CMD ["--help"]
