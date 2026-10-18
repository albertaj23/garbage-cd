# Architecture

V2 is a local, single-user web console. One Node/TypeScript **controller** starts three small
command-line tools as subprocesses; there is no Docker, database, queue or cloud service.

```
Browser (127.0.0.1)  ──HTTP/JSON──▶  Controller (Node 22, Fastify, loopback only)
                                       │  one run at a time, per-run temp directory
                      ┌────────────────┼──────────────────────────────┐
                      ▼                ▼                              ▼
              gcd-java-analyzer    java … gcd.launcher.Launcher     gcd_runner
              (JVM #1: parse,      (JVM #2: user class, MXBean      (C++: V1 Lexer/Parser/Interpreter
               AST, javac)          totals, GC log)                  over memory::Heap via TracingHeap)
```

## Two engines, never one heap

| | Engine J (standard JVM) | Engine C (custom runtime) |
| --- | --- | --- |
| Program | Java 21, one public class with `main` | toy language |
| Heap | HotSpot's own (Serial default, G1 selectable), `-Xms = -Xmx` | `memory::Heap`, non-moving mark-sweep |
| What is observable | GC count and pause totals (MXBeans), heap sizes and causes (unified GC log), allocated bytes; **no object counts, graph or roots** | exact object, edge and slot counts, per-collection mark/sweep timings, event trace, heap snapshots, region graph |
| Source of numbers | `measured` (MXBean, GC log) or `unavailable` | `measured` (counters, clocks), `estimated` (byte formulas), `reconstructed` (layouts) |

The dashboard shows both but never fabricates a shared metric: results are per-engine, wrapped in a
`Metric{value, unit, provenance, source}` envelope, and `web/shared/src/compare.ts` enforces the
comparison rules (see [contracts.md](contracts.md)).

## Components

**Controller** (`web/server/src`). `server.ts` routes and request validation; `java-adapter.ts` and
`custom-adapter.ts` build the child command lines and assemble results; `process.ts` spawns with an
argument array, detached into its own process group, applies timeouts, output caps and cancellation;
`contract-validator.ts` validates every payload with Ajv against `contracts/schemas`; `trace-store.ts`
pages NDJSON traces by whole batches; `gc-log.ts` parses JDK 21 unified GC logs (golden-file tested).

**Java tools** (`java/`). The analyzer uses only the JDK Compiler Tree API: it parses, finds the
public type and `main`, compiles with `-proc:none -Xlint:all`, and emits diagnostics plus an AST
(breadth-first capped at 5,000 nodes, exact spans, `synthetic` for nodes with no source position such
as the implicit constructor). The launcher calls `main` reflectively, catches `Throwable` and writes
MXBean totals from a shutdown hook, so `System.exit` still produces metrics.

**Custom runtime** (`include/memory`, `src/memory`, `tools/gcd_runner`).

- `memory::Heap` implements `gc::IHeap` (unchanged V1 interface). Handles are slot indices, or with
  slot reuse `generation << 32 | slot`.
- `GcObserver` + read-only `HeapView` expose collection begin, mark visit, mark complete, sweep free
  and end. The mark loop is a template on whether the **mark spanning forest** (first-discovery edges,
  rooted at GC roots) is recorded; unobserved collections do no parent bookkeeping, and the forest is
  stored in a side table so ordinary objects stay 64 bytes.
- `RegionTable` (header-only): a region is a block of R slots (`slot / R`). A write barrier in
  `setField`, plus allocate and sweep hooks, keeps live/allocated/freed counters and exact
  cross-region edge counts. Regions are observational only: they never influence marking or freeing.
- `Heap::verifyInvariants()` checks I1–I8 (roots resolve, reachability against an independent BFS in
  tests, mark bits clear, field targets resolve, accounting, region counters, mark forest, free list);
  Debug builds run it after every collection.
- `gcd_runner` steps a program one statement at a time through `TracingHeap`, maps every front-end or
  runtime failure to a structured error (no aborts), and writes the result, an optional bounded trace
  (`EventBuffer`: batches of 1–8,192 events, 1,000,000-event / 64 MiB cap, structural events kept on
  overflow, drops counted, trailer written) and `mark_complete` snapshots (≤ 2,000 objects, breadth-first
  slice that always keeps roots).

**Dashboard** (`web/client/src`). One `useReducer` store, run polling every 250 ms, error boundaries per
panel. Panels: toolbar, editor (CodeMirror 6), AST, statistics, output, heap graph (Cytoscape, lazy
chunk), regions, timeline (plain SVG), compare, benchmarks. The client computes nothing about GC beyond
layout and display formatting.

## Run lifecycle

1. `POST /api/runs` validates the request against `run-request.schema.json` and the 64 KiB source
   limit, takes the single-run slot (`409 BUSY` otherwise) and returns `202 {runId}`.
2. A fresh directory `<tmp>/gcd-runs-<port>/<runId>` (mode 0700) holds the source and all outputs.
3. Engine J: analyzer JVM → compile → launcher JVM with `-Xlog:gc*`. Engine C: `gcd_runner`.
   Every child gets a scrubbed environment and its PID is recorded so a restarted controller can kill
   orphaned process groups.
4. The result is assembled, validated against `run-result.schema.json`, stored (20 most recent runs)
   and the slot is released in the same step the terminal status becomes visible.
5. The client polls `GET /api/runs/:id`, then fetches traces, snapshots and region graphs on demand.

## API

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | tool versions, JDK found and supported (21), runner found, platform limit support |
| `GET /api/samples` | bundled programs per engine |
| `POST /api/analyze` | parse-only analysis (Java AST and syntax diagnostics, or toy AST) |
| `POST /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel` | run lifecycle |
| `GET /api/runs/:id/trace?afterSeq=&maxEvents=` | paginated trace (≤ 50,000 events), whole batches |
| `GET /api/runs/:id/snapshots/:index` | heap snapshot |
| `GET /api/runs/:id/regions?gc=<n>\|end` | region graph after a collection or at program end |
| `GET /api/benchmarks`, `GET /api/benchmarks/:id` | committed benchmark summaries |

Trace, snapshot and region routes return a 404 explaining that HotSpot does not expose that data when
the run was a JVM run.

## Frozen and changed files

Unchanged from V1 (so variant A is reproducible): `include/gc_interface.hpp`, `include/interpreter/`,
`src/interpreter/`, `include/runtime/`, `src/runtime/`, `src/main.cpp`, `tests/interpreter_tests.cpp`,
the root `CMakeLists.txt` except its 4-line `GCD_V2` hook. Changed with a stated reason: `include/memory`, `src/memory` (diagnostics,
observer, regions, slot reuse, hardening), `tests/gc_tests.cpp` (comments only).
