#!/usr/bin/env bash
# Reproduces every raw result file (G.7). One command: bench/run_bench.sh [--quick]
#   --quick  : tiny iteration counts and scales, for checking the pipeline only (not publishable)
# Env: JAVA_HOME (JDK 21), RESULT_DIR (default bench/results/<date>-<host>), CXX (default c++).
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
quick=0
[[ "${1:-}" == "--quick" ]] && quick=1

cxx=${CXX:-c++}
flags="-std=c++17 -O2 -DNDEBUG -Wall -Wextra"
work=${GCD_BENCH_WORK:-$(mktemp -d)}
mkdir -p "$work"
host=$(hostname -s | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' '-')
result=${RESULT_DIR:-bench/results/$(date -u +%Y-%m-%d)-$host}
[[ $quick == 1 ]] && result="$work/quick-results"
mkdir -p "$result/raw"

echo "== building harness variants (same compiler and flags for A and the V2 variants)"
$cxx $flags -Iinclude -Itools/gcd_runner bench/heap_bench.cpp \
  src/memory/object.cpp src/memory/heap.cpp src/memory/mark.cpp src/memory/sweep.cpp \
  tools/gcd_runner/event_buffer.cpp tools/gcd_runner/tracing_heap.cpp tools/gcd_runner/snapshot_writer.cpp \
  -o "$work/heap_bench_v2"
# Variant A is built from the v1-baseline tag in a separate worktree.
baseline_tree="$work/baseline-tree"
trap 'git worktree remove --force "$baseline_tree" >/dev/null 2>&1 || true' EXIT
if [[ ! -d $baseline_tree ]]; then git worktree add --detach "$baseline_tree" v1-baseline >/dev/null; fi
$cxx $flags -DGCD_BENCH_BASELINE -I"$baseline_tree/include" bench/heap_bench.cpp \
  "$baseline_tree"/src/memory/{object,heap,mark,sweep}.cpp -o "$work/heap_bench_v1"

echo "== environment"
python3 bench/collect_env.py "$result/environment.json" "{\"quick\": $([[ $quick == 1 ]] && echo true || echo false)}"

echo "== correctness evidence (Release test binaries)"
mkdir -p "$result/raw/tests"
if [[ $quick == 0 ]]; then
  cmake -S . -B build-rel -DCMAKE_BUILD_TYPE=Release >/dev/null
  cmake --build build-rel -j >/dev/null
  GCD_PROPERTY_SEEDS=10000 ./build-rel/gc_property_tests > "$result/raw/tests/property.txt" 2>&1 || echo "FAILED" >> "$result/raw/tests/property.txt"
  GCD_DIFFERENTIAL_SEEDS=10000 ./build-rel/differential_tests > "$result/raw/tests/differential.txt" 2>&1 || echo "FAILED" >> "$result/raw/tests/differential.txt"
  GCD_REGION_SEEDS=1000 ./build-rel/region_tests > "$result/raw/tests/region.txt" 2>&1 || echo "FAILED" >> "$result/raw/tests/region.txt"
fi

echo "== collector workloads"
python3 bench/run_bench.py --work "$work" --out "$result/raw" $([[ $quick == 1 ]] && echo --quick)

echo "== JVM workloads"
python3 bench/jvm_bench.py --out "$result/raw/jvm" --runs $([[ $quick == 1 ]] && echo 2 || echo 10)

echo "== analysis"
python3 bench/analyze.py "$result"
echo "results: $result"
