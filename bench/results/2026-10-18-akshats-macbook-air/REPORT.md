# Benchmark report 2026-10-18-akshats-macbook-air

Environment: Apple M4, 10 cores, Darwin 25.2.0, power battery; pinning: none: macOS has no CPU-affinity API (taskset is Linux only); commit 53fcba6410 (dirty).

Method: difference is real if the 95% CI excludes 1 and the effect exceeds max(2%, |A'2/A' - 1|); 3 fresh processes x (5 warm-up + 10 measured) per cell; 10,000-resample percentile bootstrap.

## Hypotheses

| ID | Hypothesis | Criterion | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| H1 | Region metadata faithfully represents cross-region references | I6 recomputation matches after every operation on seeded random programs: zero mismatches | **pass** | region_tests: region_tests: passed (1000 seeds x 8 configurations); gc_property_tests: gc_property_tests: 10000 seeds x 8 variants passed |
| H5 | Observation never changes collection | identical freed sets across variants A', B, C, D, E, E+D on every workload and seed | **pass** | differential_tests: differential_tests: 10000 seeds x 8 variants passed; harness digests of per-collection (freed, live) compared on 42 (group, workload, process) cells, mismatches: 0 |
| H2 | A region overview is cheaper than building it from a full snapshot | export at least 2x faster at N >= 10^5 with the 95% CI of the ratio excluding 2 | **fail** | N=1,000: 26.8x (CI 25.8-28.3); N=10,000: 6.6x (CI 6.4-6.7); N=100,000: 1.2x (CI 1.2-1.2); N=1,000,000: 1.4x (CI 1.3-1.4) |
| H3-mutator | Batching lowers telemetry overhead at trace level mutator | B=1,024 removes >= 50% of B=1's overhead with the CI excluding 0 (passes if so on >= 4 of 7 workloads) | **pass** | 7 of 7 workloads pass; W1: 91% removed; W2: 83% removed; W3: 88% removed; W4: 88% removed; W5: 86% removed; W6: 91% removed; W7: 83% removed |
| H3-full | Batching lowers telemetry overhead at trace level full | B=1,024 removes >= 50% of B=1's overhead with the CI excluding 0 (passes if so on >= 4 of 7 workloads) | **pass** | 7 of 7 workloads pass; W1: 90% removed; W2: 90% removed; W3: 89% removed; W4: 89% removed; W5: 86% removed; W6: 94% removed; W7: 85% removed |
| H4 | Region benefits are not cancelled by their costs | break-even k* <= 1 overview per collection on >= 4 of 7 workloads | **pass** | barrier 57.7 ns per setField (CI 55.7 to 59.6); region metadata 69.276 B per live object; Object struct 48 B (V1) -> 64 B (V2); k* <= 1 on 6 of 7 workloads: W1 0.044, W2 0.312, W3 0.053, W4 0.100, W5 24.405, W6 0.042, W7 0.000 |
| DORMANT | Dormant V2 hooks (everything off) cost under 3 % of collect time on W6 versus V1 (I.3 acceptance) | A' collect time within 3 % of A on W6 | **pass** | A'/A collect ratio on W6 0.956 (CI 0.946-0.975). The I.3 criterion covers collect time only; WHOLE-RUN A'/A is W1 1.15x, W2 1.07x, W3 1.11x, W4 1.07x, W5 1.43x, W6 1.06x, W7 1.11x (above 1 means V2 with everything off is slower than V1; the setField path also gained reference-integrity hardening and a region branch) |

## Collector: run time relative to A' (median ratio [95 % CI]; * = real by the rule above)

| Workload | A | A'2 (noise) | B regions | D regions+trace | E slot reuse | E+D |
| --- | --- | --- | --- | --- | --- | --- |
| W1 churn | 0.872 [0.858, 0.880]* | 0.994 [0.980, 1.000] | 1.038 [1.021, 1.045]* | 6.231 [6.100, 6.314]* | 0.406 [0.400, 0.409]* | 6.191 [6.092, 6.251]* |
| W2 linked list | 0.931 [0.912, 0.950]* | 1.004 [0.984, 1.023] | 1.096 [1.075, 1.109]* | 4.170 [4.075, 4.259]* | 0.905 [0.886, 0.934]* | 4.275 [4.185, 4.321]* |
| W3 binary tree | 0.900 [0.856, 0.926]* | 1.001 [0.988, 1.006] | 1.108 [1.084, 1.152]* | 9.534 [9.347, 9.653]* | 0.991 [0.976, 0.998] | 10.753 [10.524, 11.035]* |
| W4 cycles | 0.937 [0.926, 0.950]* | 0.981 [0.973, 0.996] | 1.048 [1.022, 1.065]* | 8.220 [8.067, 8.552]* | 1.031 [1.019, 1.050]* | 9.367 [9.238, 9.687]* |
| W5 random mutation | 0.699 [0.695, 0.717]* | 0.991 [0.976, 1.059] | 2.436 [2.383, 2.484]* | 14.783 [14.586, 15.514]* | 0.999 [0.987, 1.008] | 19.526 [18.871, 21.023]* |
| W6 accumulation | 0.945 [0.930, 0.958]* | 0.991 [0.973, 1.011] | 1.074 [1.051, 1.095]* | 3.857 [3.803, 3.893]* | 0.886 [0.871, 0.901]* | 3.921 [3.860, 3.956]* |
| W7 fan-in hub | 0.903 [0.813, 0.949]* | 0.947 [0.861, 1.010] | 0.973 [0.883, 1.036] | 11.179 [10.038, 11.796]* | 1.057 [0.952, 1.109] | 12.012 [10.862, 12.718]* |

Same table for collect time only (the collector's own cost):

| Workload | A | A'2 (noise) | B | D | E | E+D |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | 0.873 [0.855, 0.883]* | 0.994 [0.975, 1.006] | 1.045 [1.024, 1.058]* | 2.464 [2.417, 2.512]* | 0.262 [0.257, 0.266]* | 1.450 [1.423, 1.469]* |
| W2 | 0.981 [0.954, 1.011] | 0.996 [0.970, 1.029] | 1.083 [1.053, 1.110]* | 2.707 [2.627, 2.789]* | 0.776 [0.756, 0.831]* | 2.325 [2.261, 2.391]* |
| W3 | 0.922 [0.887, 0.963]* | 1.011 [0.972, 1.034] | 1.167 [1.101, 1.207]* | 6.202 [5.950, 6.285]* | 1.008 [0.968, 1.026] | 6.232 [5.987, 6.557]* |
| W4 | 0.937 [0.915, 0.952]* | 0.946 [0.933, 0.990] | 1.044 [1.014, 1.059] | 4.007 [3.825, 4.246]* | 1.036 [1.019, 1.050] | 3.983 [3.911, 4.295]* |
| W5 | 0.880 [0.859, 0.945]* | 1.010 [0.959, 1.065] | 1.020 [0.943, 1.039] | 4.786 [4.667, 4.943]* | 1.028 [0.994, 1.049] | 5.016 [4.858, 5.322]* |
| W6 | 1.046 [1.025, 1.057]* | 1.007 [0.987, 1.027] | 1.124 [1.107, 1.145]* | 2.964 [2.941, 2.995]* | 0.979 [0.963, 0.995]* | 2.907 [2.884, 2.942]* |
| W7 | 0.869 [0.819, 0.930]* | 0.903 [0.860, 0.998] | 0.955 [0.909, 1.048] | 9.970 [9.442, 10.713]* | 1.078 [1.011, 1.159] | 10.184 [9.363, 11.200]* |

## H2 region overview vs full snapshot

| Objects | Snapshot ms | Export ms | Ratio [CI] | Snapshot bytes | Export bytes |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 0.040 | 0.0015 | 26.8 [25.8, 28.3] | 218,226 | 4,032 |
| 10,000 | 0.558 | 0.0846 | 6.6 [6.4, 6.7] | 2,174,043 | 193,632 |
| 100,000 | 7.717 | 6.3152 | 1.2 [1.2, 1.2] | 21,747,987 | 3,297,720 |
| 1,000,000 | 170.031 | 123.1700 | 1.4 [1.3, 1.4] | 217,483,665 | 36,447,216 |

## HotSpot (JDK Serial and G1, -Xms=-Xmx=64m): behaviour only, never a speed comparison

Separate runtimes, separate programs. Differences reflect language, runtime, object model and collector together. Metrics with different bases are shown side by side without deltas.

| Program | Collector | GC count | Pause total ms | Heap after last GC | Allocated (main thread) | Wall ms |
| --- | --- | --- | --- | --- | --- | --- |
| J1 | g1 | 101 | 96.42 | 1,048,576 B | 23,845,192 B | 146 |
| J1 | serial | 101 | 67.09 | 1,048,576 B | 23,845,192 B | 117 |
| J2 | g1 | 40 | 68.84 | 1,048,576 B | 31,704,184 B | 115 |
| J2 | serial | 40 | 50.70 | 1,048,576 B | 31,704,184 B | 98 |
| J3 | g1 | 20 | 36.52 | 1,048,576 B | 2,257,760 B | 80 |
| J3 | serial | 20 | 27.35 | 1,048,576 B | 2,257,760 B | 73 |
| J4 | g1 | 3 | 5.10 | 1,048,576 B | 307,088 B | 47 |
| J4 | serial | 3 | 3.77 | 1,048,576 B | 307,088 B | 46 |
| J5 | g1 | 11 | 23.02 | 1,048,576 B | 1,704,672 B | 67 |
| J5 | serial | 11 | 15.76 | 2,097,152 B | 1,704,672 B | 59 |

| Mirror | Custom collections | Custom freed / allocated | Custom live objects after last GC |
| --- | --- | --- | --- |
| J1 = W1 | 101 | 0.999 | 1000 |
| J2 = W2 | 40 | 1.000 | 0 |
| J3 = W3 | 20 | 0.798 | 21523 |
| J4 = W4 | 3 | 1.000 | 0 |
| J5 = W7 | 11 | 1.000 | 0 |

## Threats to validity

- Single machine, battery power, no CPU pinning (macOS has no affinity API); run-to-run drift is controlled only by interleaving variants and by the A'-vs-A' noise floor. Results are not claimed for Linux/GCC.
- Variant A is built from the `v1-baseline` sources with the same compiler and flags, but a different code layout; small A-vs-A' differences can reflect layout and alignment rather than the V2 hooks.
- The batching grid (H3) ran at scale 0.25 of each workload because the product caps a trace at 1,000,000 events or 64 MiB and full-level B=1 runs take seconds; its A' reference ran at the same scale. Overheads at full scale would be capped by the same limits.
- Traces are written to a local disk file; a slower sink would raise the B=1 cost.
- H2's graph is random with out-degree <= 2 and no locality, so nearly every reference crosses regions and the overview is almost as large as the graph. Programs with locality would give the region overview a larger advantage; this workload is the unfavourable case, and the result is reported as measured.
- Statistics use 3 processes x 10 measured iterations (30 samples) per cell; the process-level variance is therefore estimated from three values.
- HotSpot comparisons are behavioural only. The unified GC log prints heap sizes rounded to whole MiB, so 'heap after last GC' is quantised to MiB and J1-J4 all read 1 MiB.
- The toy language has no loops, so W1-W7 drive `gc::IHeap` directly, exactly as the interpreter does but without interpretation cost.

Figures: `figures/ratios_main.svg`, `figures/w6_collect_per_round.svg`, `figures/h3_batching.svg`. Tables: `tables/*.csv`. Raw files: `raw/`.
