#!/usr/bin/env bash
# Pack the seven pi packages the benchmark needs into vendor/pi/ and refresh SHA256SUMS.
#
#   scripts/vendor-pi.sh <path-to-pi-checkout>
#
# The checkout must be at the pinned commit (config/benchmark.json "piRevision") with
# vendor/pi/patches/*.patch applied, and already built:
#
#   git clone https://github.com/earendil-works/pi.git && cd pi
#   git checkout 97fa14e39cfce78c273a36b2d9e8509cd5bc6b72
#   git apply <benchmark>/vendor/pi/patches/*.patch
#   npm ci && npm run build          # pi's build also fetches live model catalogs
#
# Packing copies each package out of the checkout first and runs npm pack with --ignore-scripts,
# so the checkout itself is never modified. Afterwards: npm install, then npm run test:golden-full.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pi="${1:?usage: scripts/vendor-pi.sh <path-to-pi-checkout>}"
want="$(python3 -c "import json;print(json.load(open('$here/config/benchmark.json'))['piRevision'])")"
have="$(git -C "$pi" rev-parse HEAD)"
if [ "$have" != "$want" ]; then
  echo "pi checkout is at $have, expected $want (config/benchmark.json piRevision)" >&2
  exit 1
fi
for p in coding-agent ai agent client protocol tui telemetry; do
  [ -d "$pi/packages/$p/dist" ] || { echo "packages/$p has no dist/ -- build pi first (npm ci && npm run build)" >&2; exit 1; }
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/pack" "$work/out"
for p in tui telemetry ai agent protocol client coding-agent; do
  rsync -a --exclude node_modules "$pi/packages/$p/" "$work/pack/$p/"
  (cd "$work/pack/$p" && npm pack --ignore-scripts --pack-destination "$work/out" >/dev/null)
done
cp "$work"/out/*.tgz "$here/vendor/pi/"
(cd "$here/vendor/pi" && shasum -a 256 *.tgz > SHA256SUMS && cat SHA256SUMS)
echo "vendored into vendor/pi/. Next: npm install && npm run test:golden-full"
