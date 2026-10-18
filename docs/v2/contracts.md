# Data contracts

Every payload crossing a process or HTTP boundary has a versioned JSON Schema (Draft 2020-12) in
`contracts/schemas/` and a runner- or controller-generated example in `contracts/examples/`. The
controller validates every result with Ajv in strict mode before it is stored or served; a payload
that fails validation becomes `internal_error` with a `SCHEMA_VIOLATION` error naming the failing path.

| Schema | Describes |
| --- | --- |
| `run-request.schema.json` | `POST /api/runs` body: engine, source (≤ 65,536 chars), per-engine options |
| `run-result.schema.json` | the envelope for both engines: status, phases, output, errors, static analysis, engine result, trace summary, limits, tool versions |
| `jvm-engine-result.schema.json` | Engine J totals, per-collector rows and per-collection records |
| `custom-engine-result.schema.json` | Engine C totals, per-collection records, snapshot and region-graph indexes |
| `static-analysis.schema.json` | AST (Java or toy), diagnostics, Java main-class information |
| `structured-error.schema.json` | error code, phase, message, optional location and detail |
| `heap-snapshot.schema.json` | a `mark_complete` or `program_end` snapshot (≤ 2,000 objects) |
| `trace-batch.schema.json` | one NDJSON batch of events |
| `region-graph.schema.json` | region counters and cross-region edges after a collection or at program end |
| `benchmark-summary.schema.json` | output of `bench/analyze.py` |

## The Metric wrapper

Every number the dashboard shows is `{ value, unit, provenance, source, note? }` where `value` may be
`null`.

| Provenance | Meaning | Examples |
| --- | --- | --- |
| `measured` | read from a clock, counter, MXBean or GC log | collect time, `gcCount`, objects freed |
| `estimated` | computed from a documented formula | estimated bytes of freed objects |
| `reconstructed` | rebuilt after the fact | graph layouts |
| `unavailable` | the platform does not expose it | HotSpot object counts, roots, mark counts |

`unavailable` always carries a reason (`note`) and renders as "Unavailable — reason", never as zero.

## Statuses and errors

Run `status`: `queued`, `running`, `succeeded`, `compile_error`, `program_error`, `timeout`,
`output_limit`, `resource_limit`, `cancelled`, `internal_error`.

Error codes: `SOURCE_TOO_LARGE`, `BAD_REQUEST`, `BUSY`, `LEX_ERROR`, `PARSE_ERROR`, `COMPILE_ERROR`,
`NO_MAIN_METHOD`, `RUNTIME_ERROR`, `UNCAUGHT_EXCEPTION`, `OUT_OF_MEMORY`, `TIMEOUT`, `OUTPUT_LIMIT`,
`RESOURCE_LIMIT`, `PROGRAM_EXIT`, `PROCESS_CRASH`, `CANCELLED`, `ENGINE_UNAVAILABLE`,
`SCHEMA_VIOLATION`, `INTERNAL`. A located error carries `location{line, column, …, provenance}` where
provenance is `compiler` (javac positions) or `derived` (toy statement spans from `;` offsets).

Exit codes of `gcd_runner`: 0 ok, 2 program error with a valid result written, 3 usage or I/O error,
4 internal error.

## Identifiers and ordering

- `runId` is a ULID (`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`); it is the run directory name and is never
  user-controlled.
- Object ids in snapshots and traces are the heap handle as a decimal string. Without slot reuse that
  is the slot index; with it, `generation << 32 | slot`.
- Trace events are `[seq, kind, statementIndex, …args]` with a contiguous `seq`; batches carry
  `firstSeq`/`lastSeq`, interned names in `strings`, and `droppedTotal`. A final
  `{"type":"end","complete":…,"droppedByKind":{…}}` line is the trailer; a missing trailer means the
  runner died and the controller reports `trace.complete = false`.
- Region ids are `slot / regionSize`; `slotEnd` is the last slot index (inclusive).

## Comparison rules (`web/shared/src/compare.ts`)

1. A delta appears only for the same engine, the same metric key and the same unit, with neither side
   `unavailable`.
2. Cross-engine rows (collections, memory allocated, memory reclaimed, peak or live size) are shown
   side by side with a note that the bases differ, and have no delta.
3. Timings from different engines are never combined into a speed-up.
4. The header "Separate runtimes, separate programs. Differences reflect language, runtime, object
   model and collector together." is always shown.

## Compatibility

Schema ids and the `gcd.*/1` constants version each payload. Additive fields are allowed only where a
schema says `additionalProperties: true` (the benchmark summary's nested objects); everything else
rejects unknown fields so drift is caught by tests rather than by users.
