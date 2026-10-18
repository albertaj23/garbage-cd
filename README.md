# garbage-cd

A toy language with its own mark-sweep garbage collector, and a local web console that runs the same
kind of program on that collector and Java on a stock JDK 21, side by side but never pretending they
share a heap.

```
a = new Object();
b = new Object();
a.ref = b;
a = null;
b = null;
gc();
```

The toy language has integers, `null`, `new Object()`, assignment, field references (`a.ref = b`) and
`gc()`. No functions, loops, classes or types. The collector is a non-moving, non-generational
mark-sweep over a handle-indexed heap, with no external libraries.

## What V2 adds

- **Dashboard** (React, CodeMirror, Cytoscape): editor, Java AST with exact source spans, per-engine
  statistics where every number carries a provenance badge (measured, estimated, reconstructed,
  unavailable), heap graph per collection with "Why alive?", event timeline, region graph, a Compare tab
  that refuses unfair comparisons, and committed benchmark results.
- **Controller** (Node 22, Fastify): loopback-only API, one run at a time, subprocess supervision with
  timeouts, output caps, process-group kill and (on Linux) `prlimit`.
- **Custom-runtime tooling** (`tools/gcd_runner`): runs a toy program statement by statement and emits
  schema-validated JSON, bounded NDJSON event traces and heap snapshots.
- **Collector refinements**, each switchable and verified not to change what is freed: mark spanning
  forest, address regions with barrier-maintained cross-region counts, batched trace buffer, and slot
  reuse with generation-checked handles.
- **An evaluation**: differential and property tests over 8 variants, and a benchmark harness with
  bootstrap confidence intervals. See [docs/v2/report.md](docs/v2/report.md) for results, including the
  negative ones.

## Quick start

Requires CMake 3.15+, a C++17 compiler, **JDK 21**, **Node 22** and npm (Python 3 only for `bench/`).
Linux and WSL2 are the supported platforms; macOS works on a best-effort basis (no `prlimit`).

```sh
scripts/setup.sh --check   # tells you what is missing
scripts/setup.sh           # builds the runner, the Java tools and the web workspaces
scripts/start.sh           # http://127.0.0.1:4177/
```

`setup.sh` and `start.sh` find JDK 21 and Node 22 even when other versions are the system default.

> **Security.** The dashboard is a local, single-user tool. Submitted Java can read your files, open
> network connections and start processes until its timeout; limits contain accidents, not hostile
> code. Run it in a VM or WSL instance when using other people's programs.
> See [docs/v2/security.md](docs/v2/security.md).

## Writing programs: by hand, by builder, or from the command line

All three produce ordinary toy code, so they can be mixed freely.

- **By hand.** Type into the editor as before.
- **Object builder** (custom engine, toolbar of the editor column). Set the number of objects with a
  counter, the cycle/chain mix with a slider, chain and cycle length ranges, extra links per object (a
  range, optionally within a locality window), how many groups stay rooted and over how many
  unroot-and-`gc()` rounds the rest die. The panel shows object, group, reference and byte counts
  against the 64 KiB limit and **predicts** how many objects each `gc()` will free. *Generate into
  editor* writes the program; *Live sync* keeps it up to date until you edit the code by hand (then the
  builder stops overwriting it and tells you). After a run, the panel states whether the real
  collector matched the prediction.
- **Command line.** `node web/scripts/gen-toy.mjs --objects 200 --cycle-share 60 --chain-length 3-8
  --extra-links 0-2 --locality 10 --keep-roots 30 --rounds 3 --seed 7 > p.gc` prints exactly the program
  the builder would (`--expected` prints the prediction as JSON); run it with `build/gcd_runner --source
  p.gc --result r.json`. The builder shows the equivalent flags for whatever you have set.

**Test lab** (bottom tab, or `npm run lab` in `web/` against a running controller): generates preset and
seeded random scenarios, runs each under four heap variants (plain, regions, slot reuse, both) and
checks allocations, objects freed and live after every collection, the program-end snapshot and the
region counters against the builder's prediction. The same matrix runs in the test suite.

## Development

```sh
# C++ (Debug runs every invariant check after each collection)
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build -j && ctest --test-dir build
cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug -DGCD_SANITIZE=ON   # AddressSanitizer + UBSan
GCD_PROPERTY_SEEDS=10000 ./build/gc_property_tests                     # long seeded runs

# Java tools and the web workspaces (use JDK 21 and Node 22)
java/build.sh
cd web && npm ci && npm run build && npm run lint && npm test && npm run smoke
npm run dev                  # controller with live reload (port 4177)
npm run dev:client           # Vite dev server on http://127.0.0.1:5173, proxied to the controller
```

Benchmarks: `bench/run_bench.sh` (about an hour; `--quick` checks the pipeline in seconds). Results are
committed under `bench/results/`.

## Repository layout

| Path | Contents |
| --- | --- |
| `include/`, `src/` | V1 interpreter and runtime, and the memory subsystem (`memory::Heap`, diagnostics, observer, `RegionTable`) |
| `tools/gcd_runner/` | Custom-runtime runner: tracing heap, event buffer, snapshot and region writers, toy AST |
| `tests/` | V1 smoke tests and `tests/v2/` (correctness matrix, property, differential, region, handle-reuse, runner) |
| `java/` | JDK-only analyzer (AST, diagnostics, compile) and launcher (MXBean metrics) |
| `web/` | npm workspaces: `shared` (types, comparison rules), `server` (controller), `client` (dashboard) |
| `contracts/` | JSON Schemas (Draft 2020-12) and examples for every payload |
| `bench/` | Benchmark harness, JVM workloads, analysis script, committed results |
| `scripts/` | `setup.sh`, `start.sh` |
| `docs/v2/` | Architecture, contracts, methodology, security, report, progress log |

## Architecture in one paragraph

The interpreter never includes `memory/heap.hpp`. It only sees `gc::IHeap` and the opaque
`gc::ObjectHandle` from `include/gc_interface.hpp`, which V2 does not change. `memory::Heap`
implements `gc::IHeap`; V2's runner wraps it in a decorator that records events, and a read-only
`HeapView` plus an observer interface feed snapshots. See [docs/v2/architecture.md](docs/v2/architecture.md).

## History and credits

V1 was written as a two-person course project: the interpreter, lexer/parser, runtime environment and
integration by Prateek; the managed heap, object representation, mark and sweep phases and GC
statistics by Akshat. V1 files (`include/interpreter/`, `src/interpreter/`, `include/runtime/`,
`src/runtime/`, `src/main.cpp`, `include/gc_interface.hpp`) are deliberately unchanged in V2 so the V1
behaviour stays reproducible as benchmark variant A (git tag `v1-baseline`). V2 is maintained by the
repository owner. Some comments inside the V1 interpreter headers still say "skeleton only"; they are
stale and were left alone to keep those files byte-identical.
