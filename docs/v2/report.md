# Instrumenting a mark-sweep collector: regions, a spanning forest, batched tracing and slot reuse

*Project report. Numbers come from `bench/results/2026-10-18-akshats-macbook-air/` and the test logs
committed with it. References marked ◇ were given from memory and must have their DOIs confirmed before
submission; those marked ✓ were checked against publisher pages when the plan was written.*

## Abstract

We extended a course-project mark-sweep collector for a tiny language with: a mark spanning forest
(first-discovery edges, giving "why is this object alive?"), address regions with write-barrier-maintained
cross-region reference counts, a bounded batched event trace, and slot reuse with generation-checked
handles. None of them is allowed to change what is freed; we verify that with a differential suite
over eight variants and 10,000 seeds. We built a local dashboard that runs the toy language on this
collector and Java on a stock JDK 21 side by side, with explicit provenance on every number, and
evaluated five hypotheses. Four passed. The fifth, that a region overview is at least twice as cheap
as aggregating a full snapshot at 10⁵ objects, **failed** on our workload (1.2× at 10⁵, 1.4× at
10⁶). The techniques are all known; the contribution is an instrumentable, verified integration on a
small collector with a controlled measurement of its costs, placed next to a production JVM.

## 1. Background and goals

The V1 project is about 1,150 lines of C++17: a lexer, parser and interpreter for a straight-line
language (`new Object()`, assignment, field references, `gc()`), and a precise mark-sweep collector
over a handle-indexed heap. An audit of V1 found it correct on every probe, with two notable gaps:
heap slots were never reused, so a collection costs time proportional to every allocation ever made,
and all front-end and runtime errors aborted the process. The V2 goals were (a) a console that makes
collector behaviour visible and (b) a measured answer to whether a region-level refinement is worth
having, without breaking the correctness of the collector.

## 2. System design

One Node controller runs three subprocess tools: a JDK-only Java analyzer (AST and compile), a Java
launcher that reports MXBean totals, and a C++ runner that executes toy programs statement by statement
over the real collector and emits structured JSON, bounded traces and heap snapshots. The two engines
are never merged: results are per-engine, every number is a `Metric` with provenance, and the Compare
tab refuses deltas across engines or units (see [architecture.md](architecture.md) and
[contracts.md](contracts.md)). The shared interface `gc_interface.hpp` and the V1 interpreter are
unchanged, which keeps V1 reproducible as benchmark variant A.

## 3. The collector refinement

**What did not survive the first idea.** A "forest of regions" is impossible: two objects in
different regions that reference each other form a cycle in any region graph, and the V1 probes already
include that case. The one real forest is the mark phase's first-discovery edges, rooted at the GC
roots. Region summaries also cannot speed up marking, because marking visits only reachable objects;
skipping live regions would need remembered sets and leaves cross-region garbage cycles uncollected
(the problem the Train algorithm addresses ✓ Hudson and Moss 1992). So partial collection was specified
as future work (H6) and V2 measures observation only. Likewise "regions for safety" does not hold:
what makes handles safe is checking a generation, which is a separate mechanism.

**What was built.**

1. *Mark spanning forest.* `markImpl<bool RecordParents>` records each marked object's discoverer
   (parent, field, or root name). The recording version runs only when an observer asks for it, and the
   forest lives in a side table so the common object stays 64 bytes. The dashboard turns it into a
   retention path.
2. *Address regions.* `region(h) = slot(h) / R` with R a power of two. A write barrier in `setField`
   plus allocate and sweep hooks keep per-region live, allocated, survivor and freed counts and an
   exact map of cross-region edge counts. `verifyRegions()` recomputes everything and is invariant I6.
   Reference-integrity hardening makes a `setField` with a stale target store null.
3. *Batched instrumentation.* A bounded append buffer flushed as NDJSON batches (1–8,192 events), a
   10⁶-event / 64 MiB cap, structural events kept on overflow, drops counted by kind, and a trailer
   whose absence tells the controller that the runner died.
4. *Slot reuse.* A LIFO free list and `generation << 32 | slot` encoded in the existing `size_t`
   handle; stale handles never resolve (I8) and a slot whose generation reaches 2³¹ is retired rather
   than wrapped. The interface is unchanged.

**Correctness.** Invariants I1–I9 (roots resolve; reachability matches an independent BFS; mark bits
clear; field targets resolve; accounting; region counters; forest edges are real; free list; freed sets
identical across variants) are checked by `Heap::verifyInvariants()` after every collection in Debug
builds and by the test suites. Evidence at the time of writing: 10,000 property seeds × 8 variants,
10,000 differential seeds × 8 variants, 1,000 region seeds × 8 configurations in Release, with smaller
runs under AddressSanitizer and UBSan. The sanitizer build found a stack-use-after-scope in test
code twice; the collector itself produced no failures.

## 4. Evaluation method

See [methodology.md](methodology.md). In short: seven workloads driving `gc::IHeap` directly, 15 harness
variants, 3 fresh processes × 5 warm-up + 10 measured iterations per cell, variants interleaved,
95 % bootstrap CIs of ratios to A′, and a "real" label only when the CI excludes 1 and the effect
exceeds the measured A′-vs-A′ noise floor (following Georges et al. ✓ on statistically rigorous
evaluation).

## 5. Results

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| H1 region counters match recomputation | pass | 0 mismatches in 1,000 × 8 region programs and 10,000 × 8 property programs |
| H5 observation never changes collection | pass | 0 mismatches across 10,000 × 8 differential programs and in 42 workload/process digest cells |
| H3 batching lowers tracing overhead | pass (both levels) | B = 1,024 removes 83–94 % of B = 1's overhead on 7 of 7 workloads |
| H4 benefits not cancelled by costs | pass by its criterion | barrier ≈ 58 ns per `setField` (CI 56–60); 69 B of region metadata per live object; k\* ≤ 1 on 6 of 7 workloads |
| H2 overview cheaper than snapshot | **fail** | 26.8× at 10³, 6.6× at 10⁴, **1.2× at 10⁵ and 1.4× at 10⁶** (criterion: ≥ 2× at ≥ 10⁵) |

**Batching.** Per-event flushing is expensive. Tracing at the mutator level with B = 1 makes the run
54–89× slower than trace-off (ratio to A′); at B = 1,024 it is 7.7–12× and B = 8,192 is within a few
percent of that. At the full level (mark visits and frees as well) B = 1 costs 85–250× and B = 1,024
costs 9.5–29×. Batching removes 83–94 % of the B = 1 overhead (H3), but most of what remains at large
B is event construction and string building, not I/O. The 1,000,000-event cap bounds the absolute
cost in the product.

**Regions.** With regions on and the observer off, whole-run time is within noise of A′ on W7 and
costs 4–11 % on W1–W4 and W6; on W5, which is 10⁶ `setField` calls and nothing else, it is 2.4× because
every write pays the barrier. The break-even analysis shows why that is still acceptable for the use
that motivated it: producing an overview even once per collection saves more than the barrier costs on
six of seven workloads, but not on W5 (k\* = 24).

**Why H2 failed.** The region export is O(regions + region edges). Our H2 graph is random with
out-degree ≤ 2, so almost every reference crosses regions and the number of region edges approaches the
number of references; the overview is nearly as large as the graph (3.3 MB against 21.7 MB at 10⁵). The
claimed advantage holds only when regions are far fewer than references, as in programs with locality.
We report the measured result for the unfavourable case and did not tune the workload.

**Slot reuse (variant E).** E made W1 run in 0.41× the time of A′ (collect time 0.26×) and kept collect
time flat across the six rounds of W6 (11.7–12.3 ms), whereas A′ and A grow from about 10–11 ms to
13.5–13.7 ms: the scan cost tracks allocations ever made, not live objects, exactly the defect found in
the audit. On this machine the growth is smaller than the audit's Linux/GCC measurements; the shape
agrees.

**Cost of the V2 hooks when everything is off.** The plan's acceptance check (A′ collect time within
3 % of V1 on W6) passes (0.956). Whole-run time is a different matter: A′ is 1.06–1.15× V1 on most
workloads and **1.43× on W5**. The cause is not the observer (a pilot run showed the mark forest was
being stored on every object, tripling `sizeof(Object)` from 48 to 152 bytes; moving it to a side table
brought it to 64 bytes) but, on W5, the extra `resolve` of the target that reference-integrity
hardening adds to every `setField`, plus the larger object. This is a real cost of V2's safety
checks on the mutator path and should be weighed before using A′ as a "free" baseline.

## 6. Cross-runtime observations (behaviour only)

HotSpot (Serial and G1, 64 MiB heap) was run on mirror programs J1–J5. These runs say nothing about
speed. What they show is shape: the churn program (J1) triggers 101 explicit collections in both
runtimes, the cycle program (J4) three, and on the custom side J4 ends with no live objects while J1
ends with the 1,000 objects held in its ring. HotSpot reports pauses, heap sizes and bytes allocated;
it exposes no object counts, no roots and no object graph, so those cells are `unavailable` in the
dashboard rather than zero. Heap-after-GC values are quantised to MiB by the unified log format. The table of factors that prevent isolating the
collector (program, object model, roots, algorithm, trigger, diagnostics) follows Blackburn, Cheng and
McKinley ◇ and is the reason no cross-runtime ratio is ever produced.

## 7. Threats to validity

- One machine, on battery power, no CPU pinning (macOS), results not claimed for Linux or GCC.
- A and A′ are different builds of different sources; small differences can come from code layout.
- The batching grid ran at a quarter of each workload's size, with a local-disk sink.
- H2's graph has no locality; real programs may favour regions more.
- Thirty samples per cell from three processes estimate process-level variance from three values.
- The toy language has no loops, so workloads call `gc::IHeap` directly and skip interpretation cost.
- The unified GC log's MiB rounding limits the JVM heap measurements.
- The `prlimit` path was not exercised on Linux, and the dashboard is not a security boundary
  ([security.md](security.md)).

## 8. Prior art and positioning

Address regions are G1's heap regions ✓ (Detlefs et al. 2004) and Immix's blocks ✓ (Blackburn and
McKinley 2008); cross-region counts maintained by a write barrier are remembered sets from generational
collection ◇ (Ungar 1984); partitioning by connectivity to enable partial collection is Hirzel, Diwan
and Hertz ✓ (2003); the cross-partition cycle problem is the Train algorithm's ✓ (Hudson and Moss 1992);
buffered tracing is how JFR and LTTng keep overhead low ◇ (Desnoyers and Dagenais 2006). "Region" here
means a heap partition, not a lifetime region in the sense of Tofte and Talpin ◇, and a "generation" in
the handle encoding is a reuse counter, not an object age. None of this is novel. The defensible
contribution is the verified, switchable integration on a small collector and the measurement of its
costs, including the one that failed.

## 9. Limitations and future work

Using region summaries to skip tracing (H6) is specified and not attempted; it needs remembered-set
invariants and a story for cross-region cycles. Other deferred items: multi-file Java, live streaming,
a hardened sandbox, line and column positions in the toy language, running the Linux `prlimit` path
in CI, and a locality-controlled H2 variant. A cheaper reference-integrity check on `setField` is the
obvious optimisation suggested by the W5 result.

## References

✓ Detlefs, Flood, Heller, Printezis. Garbage-First Garbage Collection. ISMM 2004, 37–48.
✓ Blackburn, McKinley. Immix: a mark-region garbage collector with space efficiency, fast collection,
and mutator performance. PLDI 2008, 22–32.
✓ Hudson, Moss. Incremental collection of mature objects. IWMM 1992, LNCS 637, 388–403.
✓ Hirzel, Diwan, Hertz. Connectivity-based garbage collection. OOPSLA 2003, 359–373.
✓ Georges, Buytaert, Eeckhout. Statistically rigorous Java performance evaluation. OOPSLA 2007, 57–76.
◇ Ungar. Generation scavenging. ACM SDE 1984.
◇ Tofte, Talpin. Region-based memory management. Information and Computation 132(2), 1997.
◇ Blackburn, Cheng, McKinley. Myths and realities: the performance impact of garbage collection.
SIGMETRICS 2004.
◇ Desnoyers, Dagenais. The LTTng tracer. Ottawa Linux Symposium 2006.
◇ Jones, Hosking, Moss. The Garbage Collection Handbook, 2nd ed. CRC Press, 2023.
✓ JEP 486: Permanently Disable the Security Manager (JDK 24).
