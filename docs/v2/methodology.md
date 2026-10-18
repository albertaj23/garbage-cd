# Methodology

## What is compared

Only the custom collector is isolated experimentally. HotSpot is run for reference behaviour and is
never used for a speed comparison: the program (JIT-compiled bytecode versus tree-walking or direct
`IHeap` calls), object model, roots, algorithm, trigger and diagnostics all differ (see the table in
the report). Blackburn, Cheng and McKinley's point that collector cost cannot be separated from mutator
effects without controlled experiments is the reason.

## Collector variants

| ID | Build | Observer | Regions | Batching | Slot reuse |
| --- | --- | --- | --- | --- | --- |
| A | git tag `v1-baseline`, built in a separate worktree with the same compiler and flags | – | – | – | – |
| A′ | V2 code, everything off | off | off | – | off |
| A′2 | identical to A′, a second binary run; measures the noise floor | off | off | – | off |
| B | V2 | off | R = 64 | – | off |
| C | V2 | mutator or full | off | B ∈ {1, 64, 1,024, 8,192} | off |
| D | V2 | mutator | R = 64 | B = 1,024 | off |
| E | V2 | off | off | – | on |
| E+D | V2 | mutator | R = 64 | B = 1,024 | on |

Nothing in B, C, D or E may change what is freed (I9 / H5). That is checked, not assumed:
`differential_tests` compares the freed `allocSeq` set of every collection across 8 variants,
`gc_property_tests` checks every variant against an independent BFS oracle, and the benchmark harness
folds each collection's (freed, live) pair into a digest and compares digests across variants.

## Workloads

The toy language has no loops, so `bench/heap_bench.cpp` drives `gc::IHeap` directly from a seeded
generator, which is exactly the interface the interpreter uses.

| ID | Workload | Stresses |
| --- | --- | --- |
| W1 | churn: 10⁶ allocations, 1 % kept in a rooted ring, collect every 10,000 | allocation, sweep |
| W2 | linked list of 10⁵, collect alive then dropped; 20 rounds | deep mark |
| W3 | binary tree depth 16, replace subtrees, collect; 20 rounds | breadth, partial death |
| W4 | 10⁴ cycles of length 2–5, unroot half, collect, unroot rest | cycle reclamation |
| W5 | 10⁴ rooted objects, 10⁶ random `setField` | write barrier, cross-region edges |
| W6 | six rounds of 10⁶ garbage allocations and a collect, one live object | slot-scan growth |
| W7 | hub referenced by 10⁵ objects, unrooted ten percent at a time | shared references |

The JVM programs J1–J5 mirror W1, W2, W3, W4 and W7, with `System.gc()` as the collection point, one
fresh JVM per run (10 runs), `-Xms = -Xmx = 64m`, Serial and G1.

## Measurement protocol

- Release build (`-O2 -DNDEBUG`), same compiler and flags for every variant.
- Each (workload, variant) cell: 3 fresh processes × (5 warm-up + 10 measured iterations) = 30 samples.
  The same seed is used for every variant within a process index; variant order is shuffled per
  (process, workload) from a fixed seed so thermal and background drift are spread across variants.
- Statistics: median and 95 % percentile bootstrap CI (10,000 resamples, fixed seed) of each
  variant-to-A′ ratio. A difference is called **real** only if the CI excludes 1 **and** the effect
  exceeds the larger of 2 % and the measured A′-vs-A′2 difference for that workload and metric.
- Reported metrics: total time, collect time (mark, sweep), counters (`marked`, `freed`,
  `fieldsScanned`, `slotsScanned`), region metadata bytes, trace events and bytes, buffer bytes,
  peak RSS per process.
- Environment (`environment.json`): CPU, cores, RAM, OS, compiler and JDK versions, git commit and
  dirty flag, power source, pinning (macOS has no affinity API; recorded as such).
- Everything is reproduced by `bench/run_bench.sh`; raw files, tables, figures and `REPORT.md` are
  committed under `bench/results/<date>-<host>/`.

## Hypotheses and verdict rules

| ID | Hypothesis | Pass criterion |
| --- | --- | --- |
| H1 | Region metadata faithfully represents cross-region references | I6 recomputation matches after every operation on seeded programs; zero mismatches |
| H2 | A region overview is cheaper than building it from a full snapshot | export ≥ 2× faster at N ≥ 10⁵, 95 % CI of the ratio excluding 2 |
| H3 | Batching lowers telemetry overhead | B = 1,024 removes ≥ 50 % of B = 1's overhead with the CI excluding 0, on ≥ 4 of 7 workloads (mutator and full levels reported separately) |
| H4 | Benefits are not cancelled by costs | break-even number of overviews per collection k\* ≤ 1 on ≥ 4 of 7 workloads |
| H5 | Observation never changes collection | identical freed sets everywhere |
| H6 | Region summaries can safely skip tracing | specified only; not attempted |

Every hypothesis gets a results row whether it passes or fails. The H3 grid runs at 0.25 scale because
a trace is capped at 10⁶ events and the slowest full-level cells take seconds per iteration; its A′
reference runs at the same scale. H2 uses a random graph with out-degree ≤ 2 and no locality (the
unfavourable case for regions). k\* uses the measured region overhead per collection and the H2 saving
interpolated log-log at the workload's live-object count.

## Builder-driven end-to-end testing (the lab)

`web/shared/src/builder.ts` turns a declarative spec (object count, cycle/chain mix, length ranges,
extra-link range and locality window, kept-root share, unroot rounds) into toy source **and** an
independently computed prediction: a plain reachability walk over the same edges gives, for every
`gc()`, how many objects must be freed and how many must remain, plus the number of reference fields
held by live objects. `web/shared/src/lab.ts` defines ten preset scenarios, a seeded fuzzer over the
whole spec space, four heap variants (plain, regions of 16, slot reuse, regions of 64 + slot reuse) and
the checks: run status, allocations, per-collection freed / live-before / live-after, totals, the
program-end snapshot (object count and reference fields) and, with regions, the verified flag, live,
allocated and edge totals of the region graph. Because the prediction does not come from the
collector, a mismatch is a real disagreement. The matrix runs in `web/server/test/lab.test.ts` (ten
presets and 25 fuzzed scenarios × 4 variants, against the real runner), in the dashboard's Test lab
tab, and from the command line (`web/scripts/lab.mjs`). Generator invariants (ranges, locality, share,
round counts, determinism, conservation, and an independent model replay of the emitted statements)
are unit tested.

## Correctness evidence used by the hypotheses

Release test binaries are run with the benchmark: 10,000 property seeds × 8 variants, 10,000
differential seeds × 8 variants and 1,000 region seeds × 8 configurations. Debug and ASan/UBSan
builds run the same suites with a smaller default seed count.

## Reproducing

```sh
scripts/setup.sh                 # toolchain, builds
bench/run_bench.sh               # about an hour on an Apple M4; prints the result directory
bench/run_bench.sh --quick       # pipeline check only; output is not committed or listed by the API
```
