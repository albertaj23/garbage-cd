#!/usr/bin/env bash
# Starts the controller (and the built dashboard) on http://127.0.0.1:4177 with the right toolchains.
set -uo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
# shellcheck source=scripts/detect.sh
. scripts/detect.sh
jdk=$(gcd_find_jdk21) || { echo "JDK 21 not found; run scripts/setup.sh --check"; exit 1; }
node=$(gcd_find_node22) || { echo "Node 22 not found; run scripts/setup.sh --check"; exit 1; }
[ -f web/server/dist/index.js ] || { echo "Not built yet; run scripts/setup.sh"; exit 1; }
export JAVA_HOME="$jdk" PATH="$jdk/bin:$(dirname "$node"):$PATH"
export GCD_GIT_COMMIT=${GCD_GIT_COMMIT:-$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}
exec node web/server/dist/index.js
