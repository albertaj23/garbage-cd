#!/usr/bin/env bash
# Checks the toolchain, builds everything and tells you how to start the dashboard.
#   scripts/setup.sh           check, then build (C++ runner, Java tools, web workspaces)
#   scripts/setup.sh --check   only check the toolchain
# Needs: CMake >= 3.15, a C++17 compiler, JDK 21, Node 22 (npm). Python 3 is only needed for bench/.
set -uo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
# shellcheck source=scripts/detect.sh
. scripts/detect.sh

check_only=0
[ "${1:-}" = "--check" ] && check_only=1
failed=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  MISSING %s\n' "$1"; failed=1; }

echo "Checking the toolchain"
if gcd_cmake_ok; then ok "CMake $(cmake --version | head -n 1 | sed 's/cmake version //')"; else bad "CMake >= 3.15 (macOS: brew install cmake; Ubuntu: sudo apt install cmake)"; fi
if gcd_cxx_ok; then ok "C++17 compiler (${CXX:-c++})"; else bad "a C++17 compiler (Xcode command line tools, or: sudo apt install g++)"; fi
jdk=$(gcd_find_jdk21) && ok "JDK 21 at $jdk" || bad "JDK 21 with javac (e.g. Temurin 21; set JAVA_HOME if installed elsewhere)"
node=$(gcd_find_node22) && ok "Node 22 at $node" || bad "Node 22 (macOS: brew install node@22; Ubuntu: use nodesource or nvm)"
if [ -n "${node:-}" ]; then
  npm_bin="$(dirname "$node")/npm"
  [ -x "$npm_bin" ] && ok "npm $("$(dirname "$node")/node" "$npm_bin" --version 2>/dev/null || true)" || bad "npm next to Node 22"
fi
command -v python3 >/dev/null 2>&1 && ok "python3 (only needed for bench/)" || echo "  note  python3 not found: bench/run_bench.sh will not run"
case "$(uname -s)" in
  Linux) ok "Linux: process limits (prlimit) are applied" ; command -v prlimit >/dev/null 2>&1 || bad "util-linux prlimit (sudo apt install util-linux)";;
  Darwin) echo "  note  macOS: supported on a best-effort basis; prlimit is unavailable, so timeouts, heap caps and output caps are the only limits";;
  *) echo "  note  unsupported platform $(uname -s); use WSL2 on Windows";;
esac
if [ "$failed" -ne 0 ]; then echo; echo "Setup cannot continue until the items marked MISSING are installed."; exit 1; fi
[ "$check_only" -eq 1 ] && { echo; echo "Toolchain OK."; exit 0; }

export JAVA_HOME="$jdk"
export PATH="$jdk/bin:$(dirname "$node"):$PATH"

echo; echo "Building the custom runtime (Release)"
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/dev/null || exit 1
cmake --build build -j >/dev/null || { echo "C++ build failed"; exit 1; }
[ -x build/gcd_runner ] || { echo "build/gcd_runner was not produced"; exit 1; }
ok "build/gcd_runner"

echo; echo "Building the Java tools"
chmod +x java/build.sh
java/build.sh >/dev/null || { echo "Java tools build failed"; exit 1; }
ok "build/java/gcd-java-tools.jar"

echo; echo "Installing and building the web workspaces"
( cd web && npm ci >/dev/null 2>&1 && npm run build >/dev/null 2>&1 ) || { echo "web install/build failed: run 'cd web && npm ci && npm run build' to see why"; exit 1; }
ok "web/server/dist and web/client/dist"

cat <<EOF

Done. Start the dashboard with:

  scripts/start.sh

then open http://127.0.0.1:4177/ . It listens on the loopback interface only and is meant for one
user running their own code: submitted programs are not sandboxed (see docs/v2/security.md).
EOF
