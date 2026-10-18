# V2 implementation progress

## T1 — baseline, correctness suite, diagnostics, minimal runner

### Verification (no source edits)

- HEAD is `7f46d69f5fd269eeb65dc2686dcd4a0bc970604c`, matching Document B.1.
- The tracked file count is 25, not the 24 stated in Document B.1; the tracked paths are the V1 paths listed by `git ls-files`. The supplied `PLAN.md` is untracked.
- The plan was supplied at repository-root `PLAN.md`; `docs/v2/PLAN.md` does not exist. Per user direction, root `PLAN.md` is treated as canonical. This path discrepancy is recorded rather than moving or copying the plan.
- The baseline Debug build with `-Wall -Wextra -Wpedantic` passed, and both existing CTest tests passed.
- The ASan+UBSan Debug build, both CTest tests, and the sample program passed.
- Document B.7 functional probes matched: sample (2 allocations, 1 collection, 2 freed, 0 live); self-cycle/chain probe (1 freed, 2 live); unreachable two-object cycle (2 freed); runtime, parser, lexer, and integer-overflow errors each abort with exit 134; empty input exits 0; default path from `build/` exits 1.
- Collection timings on this macOS/AppleClang host were 19.03 ms, 28.64 ms, and 47.54 ms after 1M, 3M, and 6M allocations. These differ from the Linux/GCC audit measurements (3.1 ms, 9.8 ms, 20.1 ms); they are environment-specific and still increase with total slot count.
- Local tag `v1-baseline` points to `7f46d69f5fd269eeb65dc2686dcd4a0bc970604c`. Work is on local branch `v2`.
- Toolchain: CMake 4.4.4 and Node 22.23.3 installed with Homebrew; Temurin JDK 21.0.12.1 installed under `~/.jdk/temurin-21`.

### Plan deviations

- Repository plan location and tracked-file count differ from the text in J.0/Document B.1 as described above. The user approved treating root `PLAN.md` as canonical and continuing.
- Baseline timings are not numerically comparable to the audit host; no behavior difference was observed.

### T1 status

- Step A — complete; commit `69773b1`. Added the V2 CMake hook, conditional V2 test/runner target registration, always-on CHECK macros, and the expected-failure canary. The canary's `abort()` was translated by its CTest wrapper to a conventional nonzero exit because CTest does not invert a signal termination with `WILL_FAIL`. Debug and Release CTest passed; Release `gc_tests` flags place `-UNDEBUG` after `-DNDEBUG`.
- Step B — complete; commit `87b52ac`. Added G.1 rows 1–11 and the independent BFS property oracle. Debug CTest passed (5/5), and `GCD_PROPERTY_SEEDS=10000 ./build/gc_property_tests` passed. The collector sources were not modified.
- Step C — complete; commit `2c1d7a3`. Added `GcDiagnostics` and per-collection records, mark/sweep/total timing and exact scan counters, plus 5-object and 1M-garbage diagnostic tests. Debug CTest passed (6/6), including the 1M-slot checks. No reachability or `GCStats` semantics changed.
- Step D — complete; commit `0bbcfb7` plus a runner-test follow-up. Added the bounded `gcd_runner`, statement stepping with one persistent interpreter, source hashing, ULID run IDs, atomic result writes, structured errors/spans, toy AST JSON, custom-engine metrics, and runner acceptance tests. The tests cover the sample (including baseline counter cross-check), the B.7 chain/cycle/error/empty probes, source/stdout limits, a runtime span, AST truncation, and an inline-compiled JSON writer test for control characters, valid UTF-8, and malformed-byte escaping. Runner and Debug CTest passed.
- Step E — complete; commit `0cc1f2d`. Added Draft 2020-12 schemas for run results, custom-engine results, static analysis, and structured errors, plus one example of each generated from `gcd_runner`. All four examples passed `npx ajv-cli@5 validate --spec=draft2020`.
- Step D added an internal `fieldNodesFreed`/`currentFieldNodes` diagnostics counter so the D.7 estimated-byte metrics can include the documented per-field node estimate. This does not change tracing or reclamation behavior and is not exposed as an extra result field.
- Step B files: `cmake/gcd_v2.cmake`, `tests/v2/gc_correctness_tests.cpp`, `tests/v2/gc_property_tests.cpp`; staged change stat before this log update was 463 insertions across 3 files.
- Step C files: `include/memory/diagnostics.hpp`, `src/memory/diagnostics.cpp`, `include/memory/heap.hpp`, `src/memory/heap.cpp`, `src/memory/mark.cpp`, `src/memory/sweep.cpp`, `tests/v2/diagnostics_tests.cpp`; staged stat before this log update was 148 insertions and 6 deletions across 7 files.
- Commands: baseline Debug build/test passed; baseline ASan+UBSan build/test/sample passed; B.7 baseline probes passed functionally; Step A Debug and Release CTest passed; Step B Debug CTest and 10,000-seed property test passed; Step C Debug CTest passed; final Debug, Release, and ASan+UBSan builds and CTest each passed (7/7); `GCD_PROPERTY_SEEDS=10000 ./build/gc_property_tests` passed; runner sample reported 2 allocations, 1 collection, 2 freed, and 0 live; all four schema examples validated with Ajv.
- Acceptance: passed. The canary is inverted correctly in Release; all B.7 error probes return exit 2 with valid structured result JSON and expected codes; runner sample matches the V1 output counters; all schema examples validate. Frozen files are unchanged, and the root `CMakeLists.txt` contains only the approved hook.
- Open issues: the default Homebrew `node` (Node 25) aborts because its `simdjson.29` dylib is missing; the required Node 22 executable at `/opt/homebrew/opt/node@22/bin/node` works and is selected for runner tests. This is an environment issue, not a repository dependency.

### T1 completion report

- Verification vs Document B: baseline commit and V1 behavior matched; the only repository differences were the approved root `PLAN.md` location and 25-vs-24 tracked files. Baseline timing values varied by host but retained linear growth.
- Committed diff against `v1-baseline`: 32 files changed, 3,391 insertions, 6 deletions. Files: `CMakeLists.txt`; `cmake/gcd_v2.cmake`; `contracts/examples/{custom-engine-result,run-result,static-analysis,structured-error}.json`; `contracts/schemas/{custom-engine-result,run-result,static-analysis,structured-error}.schema.json`; `docs/v2/PROGRESS.md`; `include/memory/{diagnostics,heap}.hpp`; `src/memory/{diagnostics,heap,mark,sweep}.cpp`; `tests/v2/{canary_test.cpp,check.hpp,diagnostics_tests.cpp,gc_correctness_tests.cpp,gc_property_tests.cpp,runner_tests.sh}`; `tools/gcd_runner/{errors.hpp,json_writer.hpp,main.cpp,spans.cpp,spans.hpp,toy_ast_json.cpp,toy_ast_json.hpp,tracing_heap.cpp,tracing_heap.hpp}`.
- Commands: Debug/Release/ASan+UBSan configure, build, and CTest passed (7/7 each); 10,000 property seeds passed; runner sample counters were 2/1/2/0; all four Ajv validations passed.
- Deviations: added internal field-node diagnostics solely to implement the D.7 estimated-byte formula. It is not added to the JSON contract and does not affect collector decisions. Canary abort handling uses a wrapper because CTest `WILL_FAIL` does not invert signal exits.
- Open issues: only the Node 25 Homebrew dylib issue noted above; no code or acceptance blockers.
- Proposed T2 risks: preserve the observer-off baseline mark path with compile-time specialization; validate each mark-forest edge against a real root/field edge; verify observer/region instrumentation does not alter freed-object sets; test event sequence/batch overflow boundaries.

## T2 brief — observer, snapshots, events, invariants

### Source sections

I.3 items 3–7; D.8–D.9; E.4; E.7; G.1 rows 14, 16, and 17. This brief follows those sections without changing their design.

### May create or modify

- M-owned `include/memory/**` and `src/memory/**`, including `observer.hpp`, read-only `HeapView`, object allocation/statement metadata, mark-forest metadata, observer hooks, and `Heap::verifyInvariants()`.
- `cmake/gcd_v2.cmake`, `tools/gcd_runner/**`, `tests/v2/**`, `contracts/schemas/**`, `contracts/examples/**`, and this progress log.

### Must not modify

- `include/gc_interface.hpp`; anything under `include/interpreter/`, `src/interpreter/`, `include/runtime/`, or `src/runtime/`; `src/main.cpp`; `tests/gc_tests.cpp`; `tests/interpreter_tests.cpp`; root `CMakeLists.txt`; or any V1 behavior.

### Ordered steps

1. Add observer interface and read-only heap view; add `allocSeq`, `allocStatement`, and `discoveredBy` storage; add the memory-owned current-statement setter and call it from the runner before each statement.
2. Template marking on whether parent recording is enabled; keep the no-observer mark path free of parent-recording work; implement collection begin/visit/mark-complete/sweep-free/end callbacks.
3. Implement I1–I5 and I7 invariant verification and call it in tests and Debug builds after collection.
4. Implement bounded breadth-first heap snapshots, including roots and at most 2,000 objects, and serialize the D.8 contract.
5. Implement D.9 event records, `EventBuffer`, `FileSink`, and `MemorySink`; support trace levels, batch sizes 1–8,192, flush boundaries, output caps, structural-event retention, drop accounting, and the end trailer.
6. Add the heap-snapshot and trace-batch Draft 2020-12 schemas and runner-generated examples; extend tests for the spanning forest, event boundaries/overflow, and event replay against a model heap.
7. Run freed-set differential and seeded property checks; run Debug, Release, and ASan/UBSan gates; update the log and commit locally.

### Commands

- `cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build -j && ctest --test-dir build --output-on-failure`
- `cmake -S . -B build-rel -DCMAKE_BUILD_TYPE=Release && cmake --build build-rel -j && ctest --test-dir build-rel --output-on-failure`
- `cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug -DGCD_SANITIZE=ON && cmake --build build-asan -j && ctest --test-dir build-asan --output-on-failure`
- `GCD_PROPERTY_SEEDS=10000 ./build/gc_property_tests`
- Validate generated snapshot and trace examples against their schemas with Node 22 and Ajv.

### Acceptance

- Observer callbacks and snapshots are correct; the spanning forest is rooted in actual heap edges; `verifyInvariants()` checks I1–I5 and I7.
- Snapshot truncation preserves roots and a breadth-first slice and is set above 2,000 objects.
- Event sequences are contiguous across batches; batch boundaries work for B = 1, 3, and 1,024; overflow retains structural events and accounts for drops; normal and caught-error paths flush a trailer.
- Replaying mutator events reproduces each collection's freed set; enabling observation does not change freed-object sets.
- All C++ Debug, Release, and ASan/UBSan gates pass; no frozen file or shared interface changes.

### Stop conditions

- Stop if a change would touch a must-not-modify file, alter reclamation behavior, require changing a frozen L.1 decision, or if a collector test fails on unchanged collector behavior.
- Stop after three consecutive failures of the same gate; do not weaken or skip tests.

## T2 completion — observer, snapshots, events, invariants

- Steps 1–3: added `GcObserver`, immutable heap views, allocation/statement/discovery metadata, observer-selectable parent recording, mark/sweep callbacks, and `Heap::verifyInvariants()` for I1–I5 and I7. Diagnostics tests validate real spanning-forest edges and prove observed/unobserved collection frees the same handles.
- Step 4: added D.8 snapshot serialization and atomic file publication. Snapshots retain all roots, prioritize a breadth-first slice, cap objects at 2,000, record mark-complete discovery metadata, and write program-end snapshots with `marked: null`.
- Steps 5–6: added D.9 NDJSON batching, interned names, `FileSink`/`MemorySink`, trace-level and batch-size CLI options, 1,000,000-event/64-MiB bounds, structural-event retention, drop accounting, and trailers. Added the snapshot/trace schemas and examples generated by `gcd_runner`.
- Step 7 acceptance: Debug, Release, and ASan/UBSan builds and full CTest each passed (9/9); `GCD_PROPERTY_SEEDS=10000 ./build/gc_property_tests` passed; both new examples validated with Node 22/Ajv. Runner acceptance replays full mutator traces against a model heap and matches each GC's freed set; batch sizes 1, 3, and 1,024, overflow, trace levels, caught-error trailers, snapshot truncation, and discovery paths are covered.
- The first ASan run exposed a stack-use-after-scope in the new test helper (iteration over a view returned from a temporary). The helper now owns the `HeapView`; the targeted sanitizer test and complete sanitizer gate then passed.
- Plan deviation: `Heap::setRoot` normalizes invalid or stale handles to `invalid()` so I1 can be verified. Existing marking already ignored unresolvable roots; the observed-vs-unobserved freed-handle test and 10,000-seed oracle show no change to reclaimed sets.
- Frozen V1 interpreter/runtime sources, `gc_interface.hpp`, `src/main.cpp`, and `tests/gc_tests.cpp` remain unchanged. No outstanding T2 blockers.
- T2 files: `cmake/gcd_v2.cmake`; `contracts/{schemas,examples}/{heap-snapshot,trace-batch}*`; `include/memory/{observer,heap,object}.hpp`; `src/memory/{heap,mark,sweep}.cpp`; `tests/v2/{diagnostics_tests,event_buffer_tests,snapshot_tests,runner_tests.sh}`; `tools/gcd_runner/{event_buffer,snapshot_writer}.{hpp,cpp}` and `main.cpp`, `tracing_heap.{hpp,cpp}`; this log.
- Commit series: `841be50` observer/invariants; `1949ce1` snapshots; `34e29df` trace buffering and runner wiring; `f7b0993` contracts/replay gates. The final completion-log commit follows.

## T3 brief — controller and JVM execution backend

### Source sections

I.4; C.3; D.3–D.6; D.10; H.1–H.6; G.3. This brief keeps the specified two-engine process model, wire contracts, and security boundaries unchanged.

### May create or modify

- `java/**`: JDK-only Java 21 analyzer and launcher; `java/build.sh`.
- `web/package.json`, `web/shared/**`, `web/server/**`: Node 22 workspaces, shared types/contracts, Fastify controller, adapters, subprocess supervision, schemas, and tests.
- `contracts/schemas/**`: add/extend the request and JVM-result contracts; do not change existing V1/C++ result semantics.
- `contracts/examples/**`, test fixtures, and this progress log as required by the T3 acceptance suite.

### Must not modify

- Existing C++ implementation and tests, including all T1/T2 files.
- V1 interpreter/runtime, `include/gc_interface.hpp`, root `src/main.cpp`, and `tests/gc_tests.cpp`.
- The architecture, API meanings, error mapping, process model, security policy, or metrics provenance fixed in Documents C, D, and H.
- No Docker, database, queue, authentication, WebSockets, cloud service, or Java agent.

### Ordered steps

1. Build the Java 21 analyzer using only JDK APIs: parse source, locate public type and `main`, compile with `-proc:none -Xlint:all` into the isolated classes directory, and emit analysis/compile diagnostics and timing.
2. Add the Java launcher and shutdown hook: invoke the selected main class, catch `Throwable`, report exception class/message/top 20 frames, and write the specified MXBean totals even when user code exits or throws.
3. Add `java/build.sh` using `javac` and `jar`; build the analyzer/launcher tools artifact without third-party Java dependencies.
4. Create the Node 22/npm workspaces and shared request/result types and schemas; configure strict TypeScript, Fastify, Ajv Draft 2020-12, Vitest, and the specified engine defaults/limits.
5. Implement the controller: loopback-only server, Host/Origin/content-type checks, single-run semaphore, in-memory LRU and per-run directory, startup/exit cleanup, argument-array process spawning, process-group timeout/cancellation, environment scrubbing, platform-aware `prlimit`, and bounded stdout/stderr.
6. Implement JVM and custom-runner adapters, GC-log parsing for JDK 21 Serial/G1, metrics/provenance/result assembly, schema validation, and D.10 health/samples/analyze/runs/cancel routes. Trace, snapshot, and region routes remain explicit 404 stubs in this phase.
7. Add five Java and four toy samples plus G.3 unit/integration tests and JDK 21 Serial/G1 golden logs; exercise all expected outcomes and confirm no run process is left behind.
8. Run the complete Java, Node, schema, and curl-level gates; record platform limitations and commit each completed T3 step and the task locally.

### Commands

- `./java/build.sh`
- `npm --prefix web install`
- `npm --prefix web test`
- `npm --prefix web run build`
- `npm --prefix web run lint`
- Start the controller on loopback and run the G.3 HTTP acceptance suite; validate every emitted payload with Ajv Draft 2020-12.
- Verify JDK 21 and Node 22 versions before the suite; check for orphaned analyzer/launcher/runner processes afterward.

### Acceptance

- A valid Java churn program returns captured stdout, parsed GC-log events, MXBean totals, and provenance-marked metrics; a toy program still uses the existing runner.
- Syntax/type/no-main/package/exception/OOM/timeout/output-flood/System.exit/thread/cancel/JDK-unavailable cases meet G.3 expected status/error/cleanup behavior.
- Serial and G1 JDK 21 GC logs match committed golden parser fixtures.
- Hostile cross-origin and non-JSON POSTs are rejected; the server binds only to `127.0.0.1`; no shell command interpolation or user-controlled run-directory names.
- Request, analysis, engine, and final result payloads validate against their versioned schemas; timeouts, output caps, environment scrubbing, and unsupported-platform `prlimit` reporting are explicit.
- No C++ or frozen file changes; Node 22 strict typecheck/build, lint, Vitest, Java build, and all G.3 rows pass.

### Stop conditions

- Stop if a requirement would require changing a frozen C++/shared-interface file or any fixed architecture/API/security decision.
- Stop if Java 21 or Node 22 cannot be used, a test demonstrates an existing C++ regression, or any gate fails three consecutive fix attempts.
- Do not claim Linux process-limit coverage on this macOS host; verify and record the plan-defined `unsupported-platform` result instead.

## T3 completion — controller and JVM execution backend

- Steps 1–3: Java 21 analyzer (`java/analyzer`), launcher with shutdown-hook MXBean metrics (`java/launcher`), JSON helper, and `java/build.sh` (`javac -Xlint:all -Werror` + `jar`, JDK-only).
- Steps 4–6: Node 22 workspaces (`web/shared`, `web/server`), strict TypeScript, Fastify loopback controller, Java and custom adapters, JDK 21 Serial/G1 GC-log parser, D.10 routes (`health`, `samples`, `analyze`, `runs`, `runs/:id`, `cancel`); trace, snapshot and region routes are explicit 404 stubs. Added `run-request` and `jvm-engine-result` schemas and extended `run-result` / `structured-error` (jvm engine, compile phase, `RESOURCE_LIMIT`, `PROGRAM_EXIT`).
- Step 7: 5 Java and 4 toy samples; Vitest suite `web/server/test` (23 tests) covering the G.3 rows and golden Serial/G1 logs captured from JDK 21.0.12.1 (`web/server/test/fixtures`).
- Defects found and fixed by the suite: (1) analyzer was launched with `-jar` though the jar has no manifest main class (now `-cp`); (2) `run-request.schema.json` failed Ajv strict mode (`type: object` missing in the engine-specific `allOf` branches), which prevented the controller from starting; (3) GC-log regex did not match padded tags (`[gc          ]`) so no pause was parsed; (4) HotSpot prints the `-XX:+ExitOnOutOfMemoryError` message to stdout, so OOM detection also checks stdout; (5) lint `prefer-const` in `process.ts`.
- Gates (JDK 21.0.12.1, Node 22.23.3, macOS): `./java/build.sh`, `npm run build`, `npm run lint`, `npm test` (23/23) pass; no orphan `gcd-java`/`gcd_runner` processes afterwards. No C++ or frozen files changed.
- Platform limitation: `prlimit` is Linux-only; this macOS host reports `unsupported-platform` in `limits.prlimit`. Linux process-limit coverage is not claimed. The OOM case relies on `-Xmx` plus `ExitOnOutOfMemoryError`, not prlimit.
- Not verified here: a curl-level run against a started server (tests use Fastify `inject` with loopback host headers), and the "JDK missing" case is covered via a nonexistent `javaPath`, not by removing `java` from `PATH`.
- Known gap: `toolVersions.jdk` reads `GCD_JDK_VERSION` from the environment and is `unknown` unless set, even though health probes the real version.

## Phase 3 — Java source analysis

- `java/analyzer/AstBuilder.java` converts javac trees (`TreeScanner`, `SourcePositions`, `LineMap`) to the D.5 `AstNode` JSON: kind = `Tree.Kind`, per-kind labels (identifiers, member names, literals, primitive types, modifiers) truncated to 80 chars, compiler spans (UTF-16 offsets; columns use javac's `LineMap`, which expands tabs), `NOPOS` nodes kept with `synthetic: true` and no span. Selection is breadth-first capped at 5,000 nodes; ids are pre-order over the kept nodes; truncation adds an `AST_TRUNCATED` note diagnostic. The analyzer runs on a 256 MiB-stack thread to survive deeply nested expressions.
- Two paths: the full run path rebuilds the AST after `analyze()` so the implicit default constructor appears (flagged synthetic); `POST /api/analyze` uses a new `--parse-only` analyzer flag (parse-time syntax diagnostics, no compile, no implicit constructor).
- Contract/type changes: `synthetic` added to the `astNode` schema and shared `AstNode` type.
- Tests (`web/server/test/analyze.test.ts`, 16): golden AST JSON for the 5 samples (`test/golden/`, regenerate with `UPDATE_GOLDEN=1`), span round-trip/containment, contiguous ids, synthetic constructor, 6,000-element initializer truncating to exactly 5,000 nodes, syntax-error location, and a ~300-line program analyzed in <2 s on this host. `vitest.config.ts` now runs test files sequentially because the orphan-process check is machine-wide.
- Gates: `./java/build.sh`, `npm run build`, `npm run lint`, `npm test` (39/39) pass with JDK 21 and Node 22; no orphan processes.
- Deviations/limits: `routes/analyze.ts` was not split out (the route stays in `server.ts`). A `StackOverflowError` while building the AST yields `ast: null` rather than failing the run; that path is untested. The 2 s check is a timing assertion on one host and may be flaky under load.

## Phase 4 — Dashboard MVP

- New workspace `web/client` (Vite 5, React 18, strict TypeScript, CodeMirror 6, `react-resizable-panels`; sizes persist via `autoSaveId`). Panels: `TopBar` (engine, sample, Run/Stop/Reset, status pill, permanent engine banner), `EditorPanel` (Java mode for JVM, plain text for toy; gutter markers for diagnostics; AST-node highlight; jump-to-error), `AstPanel` (lazy tree, kind/label/line:col, synthetic and truncation badges, click selects span), `StatsPanel` (totals and per-collection tables with M/E/R/U provenance badges as distinct shapes plus tooltip of source/note; unavailable metrics show their reason), `OutputPanel` (structured errors with jump links, compiler diagnostics, stdout/stderr, truncation banners), per-panel `ErrorBoundary`. State is one `useReducer`; `useRunPolling` polls `GET /api/runs/:id` every 250 ms until a terminal status. A finished run with a located error moves the cursor to it.
- Controller serves `web/client/dist` itself: files are indexed once at startup into a URL→file map (no path concatenation from requests, no symlinks); `@fastify/static` was deliberately not used because `npm audit` reports path-traversal advisories against it. `vite dev` proxies `/api` and strips the browser `Origin` header so the same-origin check still holds.
- Fixed in passing: JDK vendor/version were `unknown` in results (the controller now exports the probed values at startup).
- Tests: 12 client tests (Testing Library/jsdom: every badge, Unavailable-with-reason, partial result while running, program error with/without location, truncation banners, lazy AST, store, and an App test with mocked fetch covering load→run→poll→output and engine switch); `npm run smoke` (`web/scripts/smoke.mjs`) starts the built controller on port 4188, serves `/`, runs the Java and toy samples, and asserts terminal statuses, an AST, and per-GC records. The orphan-process test now matches only processes under its own run directory.
- Gates (JDK 21, Node 22): `npm run build`, `npm run lint`, `npm test` (server 39 + client 12), `npm run smoke` pass. Run → AST → Statistics → Output was checked manually in the in-app browser against the Allocation sample.
- `web/package.json` pins `react`/`react-dom` 18.3.1 via `overrides` (npm otherwise hoisted React 19 and broke the tests); the lockfile was regenerated.
- Not done / limits: compile-error cursor jump and Stop button were not exercised in a real browser (only the Output jump link and polling are unit-tested); no `AstPanel` virtualisation (≤5,000 nodes, collapsed by default); no light-theme visual check; the toy language has no editor syntax mode; `npm audit` reports moderate dev-only advisories (Vite 5's esbuild dev server, vitest tooling), which affect `vite dev` only, not the controller or built output.
- Deferred by plan to later phases: heap graph, timeline, regions, compare, benchmarks.
- Race fixed after the P4 commit: the controller released its single-run slot only after writing `run-result.json`, so a client that saw a terminal status and immediately posted another run could get a spurious 409 BUSY (this made 3 controller tests fail intermittently). The slot is now released in the same tick the terminal result becomes visible, and cleanup only clears the slot if it still belongs to that run. Three consecutive full `npm test` runs passed afterwards.

## Phase 5 — Custom GC visualisation

- Controller: `GET /api/runs/:id/trace?afterSeq=&maxEvents=` (≤ 50,000; default 10,000) returns whole batches with `firstSeq > afterSeq`, a `next` cursor (null at the end) and the trailer on the last page, so paging never splits, skips or repeats a sequence number; each batch is validated against `trace-batch.schema.json`. `GET /api/runs/:id/snapshots/:index` serves `snapshot-<n>.json` after schema validation (`heap-snapshot.schema.json`; >2,000 objects is a schema violation), with a strict `^(0|[1-9][0-9]{0,5})$` index check, so no request value reaches a file path unvalidated. JVM runs get a 404 stating that HotSpot exposes neither object graph nor events; unfinished runs get 409; untraced runs and missing snapshots 404. The controller now derives `result.trace` (available/complete/eventCount/droppedCount/batchCount) by reading the trace, where a missing trailer or any drops means `complete: false`; a trace file over 80 MiB is refused rather than read. The contract validator now loads the snapshot and trace-batch schemas.
- Client: `HeapGraphPanel` (Cytoscape.js, lazy-loaded chunk; breadth-first layout from root-entry nodes; snapshot slider; header "Custom runtime heap at GC #k (mark complete)"; survived = green circle, will-be-freed = red dashed rounded box, live-at-end = blue, roots = diamonds with a thicker border on their targets; a "layout is reconstructed, not memory addresses" note; "Why alive?" follows `discoveredBy` back to the root and highlights the path; victims say they will be freed; truncation banner), `TimelinePanel` (plain SVG: per-statement allocation / root-change+field-write bars, GC markers that open that GC's snapshot, and a live-objects line that uses the engine's own before/after counts rather than client-side GC logic), `TraceBanner` (incomplete trace / partial load), `useTrace` (bounded paging, 10 pages × 10,000 events). Snapshots are structurally re-validated in the client; a malformed one shows an error card and a 2,001-object one is refused with a pointer to the region view (Phase 6, not built yet). JVM runs show "Not available for HotSpot: object graph is not exposed through supported APIs" in the heap tab and a note in the timeline. Custom runs now always request `traceLevel: mutator` and snapshots. The default pane layout was changed (saved sizes use new `-v2` ids) so the graph has room.
- Also fixed: the controller indexed `web/client/dist` only at startup, so a rebuilt client produced 404s for the new hashed assets until the server restarted (this blanked the page during a `npm run dev` session). It now re-indexes on a miss, at most once a second.
- Tests: server 47 (trace pagination units and over HTTP, parameter validation, missing/invalid data, HotSpot 404, in-progress 409, bundled sample's two unrooted objects freed with their `ref` edge, chain tail discovered via `root`); client 30 (graph model, why-alive paths including a corrupt cycle, snapshot validation incl. 2,000 vs 2,001, panel states with Cytoscape mocked, slider, truncation/incomplete banners, timeline bucketing and marker click, trace paging); smoke now also checks the trace and snapshot endpoints. Build, lint, tests and smoke pass (JDK 21, Node 22).
- Acceptance (I.7) checked: the sample shows two unrooted objects unmarked with the `ref` edge (server test); the cycle sample's two members both show as freed and a chain tail's "Why alive?" highlights the full chain to its root (both seen in the in-app browser; the chain case and the cycle are also covered in tests).
- Not done / limits: the Cytoscape canvas itself (colours, layout, tap handling) is exercised only manually in the in-app browser, not in automated tests (jsdom cannot render it; tests mock it); no `cose` layout option; only mutator-level traces are requested, so mark-visit and sweep-free events (`MV`, `SF`) are not shown; a trace larger than 100,000 events is only partially loaded (with a banner); light theme and large (≈2,000-object) graphs were not visually checked; Stop and the compile-error cursor jump from Phase 4 are still only unit-tested.

## Phase 6 — Regions, batched instrumentation, slot reuse

- **6A batching:** already complete from T2 (`EventBuffer`, caps, overflow policy, interning, trailer, trace levels, batch-size flag; G.1 row 16 in `event_buffer_tests`). No new work.
- **6B regions** (`include/memory/region_table.hpp`, header-only because the root `CMakeLists.txt` is frozen and cannot list a new `.cpp`): `RegionTable` keeps per-region live/allocated/survivors/freed/intra-edge counters and an exact cross-region edge map. `region(h) = slot(h) / R`, R a power of two (the runner and request schema accept 0, 16, 32, 64, 128, 256; tests also use R = 1). The write barrier in `Heap::setField` and the sweep/allocate hooks run only when R > 0. `Heap::verifyRegions()` recomputes everything from scratch (I6) and is called by `verifyInvariants()`; `Heap::regionGraph()` exports the D.8 region graph (`verified` reflects that recomputation; `slotEnd` is inclusive; `rootTargets` is derived at export time). Reference-integrity hardening: a `setField` whose target is a valid handle that no longer resolves is stored as null and counted in `staleWritesRejected`. `verifyInvariants()` now also checks I4 (every stored field target resolves).
- **6C slot reuse:** `Heap::Options{regionSize, slotReuse}`. With reuse, `raw = generation << 32 | slot` (generation starts at 1, slot < 2^32 − 1, so a handle can never equal the invalid sentinel); sweep bumps the slot's generation and pushes it on a LIFO free list; a slot whose generation reaches the limit (2^31, lowered by `setGenerationLimitForTesting` in tests) is retired and counted in `slotsRetired`; `resolve()` also compares generations. I8 free-list consistency is checked in `verifyInvariants()`. Without reuse, handles are the plain slot index exactly as in V1. `gc_interface.hpp` is untouched.
- **Runner:** `--region-size N` (0/16/32/64/128/256), `--slot-reuse`, `--regions-dir <dir>` (requires a region size); a `gcd.region-graph/1` file is written after each collection's sweep (`point: gc_end`) and at program end; the result's `engineResult.runtime.heap` reports the real values and `engineResult.regionGraphs` indexes the files. Snapshots now carry the real `slot`, `generation` and `region`. New `region-graph` schema and example; `custom-engine-result` gained `regionGraphs`.
- **Controller / UI:** `GET /api/runs/:id/regions?gc=<n>|end` (schema-validated; 404 with the HotSpot explanation for JVM runs, 404 when regions were off, 400 for a bad `gc`); the earlier "variants unsupported" guard is gone. The toolbar shows a Regions size select and a Slot-reuse checkbox for the custom engine; a new Regions tab draws the region graph with Cytoscape (box size = live objects, thick border = holds a root target, edge labels = cross-region counts, "counters verified" badge, ≤ 1,000 regions), and "Show its objects in the heap graph" filters the heap graph to that region.
- **Tests:** G.1 row 12 `handle_reuse_tests`, row 13 `region_tests` (verify after every operation across R ∈ {1, 16, 64, 256} × reuse on/off), row 15 `differential_tests` (freed `allocSeq` sets and live counts identical across 8 variants: A′, B64, B16, C, D, E, E+B, E+D), row 18 `gc_property_tests` now runs every seed against all 8 variants (I6 after every operation for the first 200 seeds, then every 16th operation and after each collection); runner CLI checks; 5 server and 11 client tests. Gates: Debug (which also runs `verifyInvariants()` after every collection), Release and ASan+UBSan builds each 12/12 CTest; Release with 10,000 property seeds × 8 variants, 10,000 differential seeds × 8 variants and 1,000 region seeds × 8 configurations all passed; web build, lint, server 52, client 41, smoke pass.
- **Observed effect (E.6):** on a churn program the slots scanned per collection grow 20→40→60→80 without reuse and stay at 20, 22, 22, 22 with reuse, while freed counts are identical.
- **Bugs found by the new tests:** two test-only defects (a range-for over a temporary `HeapView`, the same pattern as in T2, and an observer that dangled after its owner was moved, caught by ASan); `verifyInvariants()` I5 is only valid right after a collection, so tests now collect before the final check. No collector defect was found.
- **Not done / limits:** the plan's dormant-hook overhead check (observer-off collect time within 3 % of V1 on W6) and the barrier-cost measurements belong to Phase 7 and were not run; the 2^32 slot-space exhaustion path is untested; the region graph is exported per GC and at program end only (no per-statement series); the Regions tab canvas was checked by eye in the in-app browser, while automated tests mock Cytoscape; large region counts (≈1,000) were not looked at; H2 (region overview cost) is not measured yet.

## Phase 7 — Benchmarks and comparison

- **Harness** (`bench/heap_bench.cpp`): W1–W7 drive `gc::IHeap` directly from a seeded generator; 15 variants (A built from the `v1-baseline` tag in a separate worktree with the same compiler and flags; A′, a second A′ for the noise floor, B, D, E, E+D, and C with trace levels mutator and full × batch sizes 1, 64, 1,024, 8,192). Each process runs 5 warm-up + 10 measured iterations; 3 fresh processes per cell; variant order is shuffled per (process, workload) from a fixed seed. Metrics: total and collect time, mark/sweep split, scan counters, trace events/bytes/buffer bytes, region metadata bytes, a per-collection digest of (freed, live) for the H5 equivalence check, and per-process peak RSS. H2 mode times a region overview built from a full snapshot against the `RegionTable` export (`Heap::regionGraph(false)` skips verification so only the export is timed).
- **Orchestration**: `bench/run_bench.sh` builds both binaries, records the environment, runs the Release correctness evidence (10,000 property seeds × 8 variants, 10,000 differential seeds, 1,000 region seeds), the collector matrix, H2, the HotSpot runs, then `bench/analyze.py`. `--quick` runs the same pipeline at tiny sizes (pipeline check only, never committed). `bench/jvm_bench.py` runs J1–J5 (mirrors of W1, W2, W3, W4, W7) as fresh JDK 21 processes, 10 each, `-Xms=-Xmx=64m`, Serial and G1, through the same launcher the controller uses. `bench/analyze.py` is standard-library only (no numpy, pandas or matplotlib are installed here): medians, 10,000-resample percentile bootstrap CIs, a difference counts as real only if the CI excludes 1 and the effect exceeds max(2 %, the measured A′-vs-A′ noise floor); it writes `summary.json`, `REPORT.md`, CSV tables and SVG figures.
- **Results** are committed in `bench/results/2026-10-18-akshats-macbook-air/` (raw files, tables, figures, `REPORT.md`, `summary.json`; ≈ 3.8 MB). Verdicts: H1 pass, H5 pass (42 digest cells, 0 mismatches), H3 pass at both levels (7 of 7 workloads; B = 1,024 removes 83–94 % of B = 1's overhead), H4 pass by its criterion (k* ≤ 1 on 6 of 7 workloads; barrier ≈ 58 ns per `setField`; W5 k* = 24), dormant-hook collect-time criterion pass (A′/A on W6 = 0.956), **H2 fail**: the region export was only 1.2× (N = 10⁵) and 1.4× (N = 10⁶) faster than the snapshot, against a 2× criterion (it was 6.6× at 10⁴ and 26.8× at 10³). This is reported as measured: the H2 graph is random with no locality, so nearly every reference crosses regions and the overview is almost as large as the graph (unfavourable case; stated in the report's threats section).
- **Findings worth acting on**: (1) the first pilot showed `sizeof(memory::Object)` had grown from 48 B (V1) to 152 B because the mark forest (`discoveredBy`) was stored on every object; it now lives in an observer-only side table in `Heap`, leaving `Object` at 64 B (V1 48 B + `allocSeq` and `allocStatement`); all Debug, Release and ASan tests pass after the change. (2) Whole-run time of V2 with every feature off is still 1.06–1.15× V1 on most workloads and 1.43× on W5; the collect-time-only criterion passes, but the reference-integrity hardening in `setField` (an extra `resolve` of the target) and the larger `Object` cost real time on the mutator path. (3) Slot reuse (E) cut W1 run time to 0.41× of A′ and collect time to 0.26×, and shows the D1 slot-scan growth fix in `figures/w6_collect_per_round.svg`. (4) Full tracing (D, E+D) costs 4–19× on whole-run time, mostly string building and I/O per event.
- **Dashboard**: `GET /api/benchmarks` lists committed result sets (schema-validated against the new `benchmark-summary.schema.json`; quick runs are never listed; ids are matched only against directory listings, never concatenated into paths) and `GET /api/benchmarks/:id` serves one. A Compare tab (`web/shared/src/compare.ts`) implements F.4: a delta only for the same engine, same metric key and same unit with neither side unavailable; cross-engine rows are side by side with no delta and wall times are never combined into a speed-up; the header sentence is always shown. A Benchmarks tab shows hypothesis verdicts (with glyphs as well as colour), the evidence, a ratio chart with CI whiskers (solid = real, faded = within noise), the H2 table and the HotSpot reference table with the F.4 note.
- **Tests**: 8 new client tests (compare rules and panels, benchmark panel states), 3 server tests (listing, id handling, quick/invalid exclusion); totals server 55, client 47, C++ 12 in Debug, Release and ASan. Lint, build and smoke pass.
- **Not done / limits**: the machine was on battery power with no CPU pinning (macOS), a single machine, so results are not claimed for Linux; the batching grid ran at 0.25 scale (explained in the report); the committed raw files embed this host's name in the directory name; JVM "heap after last GC" is quantised to MiB by the unified log format; the Compare tab has no persistence across page reloads.

## Phase 8 — Hardening, documentation, report

- **Security review against H.1** and a resource-exhaustion re-run of G.3 (`web/server/test/hardening.test.ts`, 20 tests). Gaps found and fixed:
  1. A `Host` header without a port was accepted as if it carried the controller's port; it now means port 80 and is rejected.
  2. Children a program started and abandoned survived a normal exit (the process group was only killed on timeout, output limit or cancel); the group is now killed on every child exit.
  3. SIGINT, SIGTERM and SIGHUP killed the controller without stopping active runs, leaving detached JVMs behind; `index.ts` now closes the app (abort, wait for the group kill) before exiting.
  4. Two controllers shared one run directory (`gcd-runs`), so a second instance's startup sweep could kill and delete the first's live runs; the run directory is now per port (`gcd-runs-<port>`, or `GCD_RUN_ROOT`) and a `.controller.pid` lock makes a second live controller on the same directory refuse to start (a stale lock with a dead pid is taken over). This was hit in practice: earlier smoke runs on a different port used the same directory as the user's dev server.
  5. No browser-side hardening headers: added CSP (`default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`, inline styles allowed for CodeMirror), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Resource-Policy`, `Cache-Control: no-store` for the API; `requestTimeout` 30 s and keep-alive 5 s. The dashboard was re-checked in the browser under the policy with a clean console.
  6. `/api/health` now reports `jdk.supported` (JDK 21 only) and the dashboard shows setup banners for a missing or unsupported JDK or an unbuilt analyzer/runner.
- **Verified by test, no change needed**: environment scrubbing (injected `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS`, `CLASSPATH` and a secret variable never reach the program); stack overflow, 20,000-thread bomb, direct-buffer exhaustion, stdout and stderr floods, 14,000-deep parentheses and a 30,000-term `+` chain (the 256 MiB analyzer thread stack held), a 64 KiB toy program, ten back-to-back runs without leftovers, 409 and cancel mid-run, preflight never approved and no `Access-Control-*` header on any response, strict body validation (413/400/415), static-file traversal attempts, IPv4-loopback-only listening (`::1` and the external address refuse connections), orphan sweep, SIGTERM cleanup.
- **Documentation**: README rewritten (the "skeleton only" status is gone; V1 credits kept; V2 maintenance stated), `docs/v2/{architecture,contracts,methodology,security,report}.md`, stale comments fixed in `include/memory/heap.hpp` and `tests/gc_tests.cpp` (comments only). The V1 interpreter headers still say "skeleton only" in their comments; they were left untouched on purpose because those files are frozen for variant A.
- **Setup**: `scripts/setup.sh [--check]` verifies CMake ≥ 3.15, a C++17 compiler, JDK 21 and Node 22 (finding them even when other versions are the default), builds the runner, Java tools and web workspaces; `scripts/start.sh` starts the controller with the right toolchains. A fresh `git clone` of this branch went from nothing to a built, healthy dashboard (health OK, dashboard 200, 8 smoke checks passing) in about 30 s on this Mac (warm npm cache; the default Node was 26 and the scripts used 22).
- **Gates**: Debug 12/12 C++ tests; web build and lint clean; server 75 and client 48 tests pass. The Release and ASan C++ suites last ran in Phase 7 and only comments changed in C++ since.
- **Not done / limits**: the acceptance criterion "clean Ubuntu 24.04 VM reaches a working dashboard in ≤ 15 minutes" was **not** tested (no Linux VM here); the Linux `prlimit` path and its effect are untested; on macOS a Java program can write to disk until its timeout (no file-size limit); `user.home` inside the JVM comes from the passwd entry, not the scrubbed `$HOME`; the hardened bubblewrap mode is documented, not built or tested; the report's ◇ references need their DOIs confirmed before submission; the report is a draft in Markdown, not a typeset document.

## Follow-up — object builder and test lab

- **Strategy**: the code is always the single source of truth; the toy language has no comments, so the builder keeps its spec outside the program. A pure, deterministic generator (`web/shared/src/builder.ts`) produces toy source plus an independently computed prediction (freed and live after each `gc()`, live reference fields). The dashboard builder, the CLI (`web/scripts/gen-toy.mjs`) and the tests all call it, so the same spec gives byte-identical programs everywhere, and the builder displays its CLI equivalent.
- **Builder** (custom engine, collapsible above the editor): object counter (stepper, field and slider), cycles-vs-chains slider, chain and cycle length ranges, extra links per object (a range) with an optional locality window, kept-roots share, unroot rounds, a "gc() while everything is rooted" option, seed with reshuffle, ten presets, live statistics with a 64 KiB meter (a program over the limit is flagged and not run), and the predicted outcome. *Generate into editor* writes the code; *Live sync* then regenerates on every spec change until the user edits the code, after which a banner says the builder no longer overwrites it. After a run the panel compares the real run with the prediction, but only when the run's source equals the current generated source.
- **Test lab** (bottom tab; `web/scripts/lab.mjs`; `web/server/test/lab.test.ts`): ten presets plus N seeded random scenarios, each run under four heap variants (plain, regions 16, slot reuse, regions 64 + slot reuse); checks status, allocations, per-collection freed / live-before / live-after, totals, the program-end snapshot and the region counters (verified flag, live, allocated and edge totals) against the prediction.
- **Result**: the real collector matched the prediction in every case: 64 of 64 from the command line, 56 of 56 in the dashboard, and in the server suite all ten presets and 25 fuzzed scenarios × 4 variants. The tests are not vacuous: a tampered prediction is detected, and the unit tests found a real generator bug (a locality-window link wrapped from the last object to the first).
- **Limits**: one variable per object, so the 64 KiB source limit allows about 1,300 objects with no extra links (about 900 with ~1.5 links each); the builder cannot read hand-written code back into a spec; the lab's variants cover regions and slot reuse but not trace levels; the lab uses the one-run-at-a-time controller, so it waits for any active run.
- **Also fixed**: the Cytoscape canvases did not refit when their pane was resized, so a graph laid out in a small pane showed only a slice; both canvases now refit on resize.
- **Gates**: server 87, client 76 tests pass; build, lint and smoke pass; no C++ changed.
