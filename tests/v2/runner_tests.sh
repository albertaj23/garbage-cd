#!/usr/bin/env bash
set -euo pipefail

runner=${1:?runner executable required}
baseline=${2:?baseline executable required}
repo=$(cd "$(dirname "$0")/../.." && pwd)
node_bin=${NODE:-node}

"$node_bin" - "$runner" "$baseline" "$repo" <<'NODE'
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const [runner, baseline, repo] = process.argv.slice(2);
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gcd-runner-tests-"));

function runCase(name, source, expectedExit, expectedCode = null, extraArgs = []) {
  const sourcePath = path.join(temporaryDirectory, `${name}.gcd`);
  const resultPath = path.join(temporaryDirectory, `${name}.json`);
  fs.writeFileSync(sourcePath, source);
  const child = spawnSync(
    runner,
    ["--source", sourcePath, "--result", resultPath, ...extraArgs],
    {
    encoding: "utf8",
    },
  );
  assert.equal(child.signal, null, `${name} terminated by ${child.signal}`);
  assert.equal(child.status, expectedExit, `${name}: ${child.stderr}`);

  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(result.schema, "gcd.run-result/1");
  assert.match(result.runId, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.equal(
    result.sourceSha256,
    crypto.createHash("sha256").update(source).digest("hex"),
  );
  if (expectedCode) {
    assert.equal(result.status, "program_error");
    assert.equal(result.errors[0].code, expectedCode);
  } else {
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.errors, []);
  }
  return result;
}

try {
  const writerSource = String.raw`
#include <iostream>
#include <string>
#include "json_writer.hpp"
int main() {
  JsonWriter writer;
  writer.beginObject();
  writer.key("value");
  writer.string(std::string(R"(quote " slash \ control )") + char(1) +
                " snowman \xE2\x98\x83 invalid " + char(0xf0));
  writer.endObject();
  std::cout << writer.str();
}
`;
  const writerExecutable = path.join(temporaryDirectory, "json-writer-test");
  const compiler = spawnSync(
    process.env.CXX || "c++",
    ["-std=c++17", "-I", path.join(repo, "tools/gcd_runner"), "-x", "c++", "-", "-o", writerExecutable],
    { input: writerSource, encoding: "utf8" },
  );
  assert.equal(compiler.status, 0, compiler.stderr);
  const writerOutput = spawnSync(writerExecutable, [], { encoding: "utf8" });
  assert.equal(writerOutput.status, 0, writerOutput.stderr);
  const escapedValue = JSON.parse(writerOutput.stdout).value;
  assert.ok(escapedValue.includes("☃"));
  assert.ok(escapedValue.includes('quote " slash \\ control'));
  assert.ok(escapedValue.includes("\u0001"));
  assert.ok(escapedValue.includes("\u00f0"));
  assert.ok(writerOutput.stdout.includes("\\u00f0"));

  const sampleSource = fs.readFileSync(path.join(repo, "examples/sample_program.txt"), "utf8");
  const sample = runCase("sample", sampleSource, 0);
  const baselineOutput = spawnSync(
    baseline,
    [path.join(repo, "examples/sample_program.txt")],
    { encoding: "utf8" },
  );
  assert.equal(baselineOutput.status, 0, baselineOutput.stderr);
  const reportValue = (label) => {
    const match = baselineOutput.stdout.match(new RegExp(`${label}:\\s+(\\d+)`));
    assert.ok(match, `baseline report missing ${label}`);
    return Number(match[1]);
  };
  assert.equal(sample.engineResult.totals.allocations.value, reportValue("total allocations so far"));
  assert.equal(sample.engineResult.totals.collections.value, reportValue("total collections so far"));
  assert.equal(sample.engineResult.collections[0].freed.value, reportValue("objects collected this run"));
  assert.equal(sample.engineResult.collections[0].liveAfter.value, reportValue("live objects after collection"));
  assert.equal(sample.engineResult.totals.allocations.value, 2);
  assert.equal(sample.engineResult.totals.collections.value, 1);
  assert.equal(sample.engineResult.totals.freed.value, 2);
  assert.equal(sample.engineResult.totals.liveAfter.value, 0);
  assert.match(sample.output.stdout, /gc\(\) called:/);
  assert.equal(sample.staticAnalysis.nodeCount, 12);

  const chain = runCase(
    "chain",
    "a = new Object(); b = new Object(); c = new Object(); a.next = b; b.next = c; a = null; gc();",
    0,
  );
  assert.equal(chain.engineResult.totals.freed.value, 1);
  assert.equal(chain.engineResult.totals.liveAfter.value, 2);

  const cycle = runCase(
    "cycle",
    "a = new Object(); b = new Object(); a.next = b; b.next = a; a = null; b = null; gc();",
    0,
  );
  assert.equal(cycle.engineResult.totals.freed.value, 2);

  runCase("runtime-error", "a = 5; a.f = null;", 2, "RUNTIME_ERROR");
  runCase("parse-error", "a = ;", 2, "PARSE_ERROR");
  runCase("lex-error", "// comment", 2, "LEX_ERROR");
  runCase("overflow-error", "a = 99999999999999999999;", 2, "RUNTIME_ERROR");
  const empty = runCase("empty", "", 0);
  assert.equal(empty.output.stdout, "");
  assert.equal(empty.engineResult.totals.allocations.value, 0);

  const located = runCase("runtime-span", "a = 5;\n  a.f = null;", 2, "RUNTIME_ERROR");
  assert.deepEqual(
    {
      line: located.errors[0].location.line,
      column: located.errors[0].location.column,
      endLine: located.errors[0].location.endLine,
      endColumn: located.errors[0].location.endColumn,
    },
    { line: 2, column: 3, endLine: 2, endColumn: 14 },
  );

  const tracePath = path.join(temporaryDirectory, "observed.ndjson");
  const snapshotsDirectory = path.join(temporaryDirectory, "snapshots");
  const observed = runCase(
    "observed",
    "a = new Object(); b = new Object(); c = new Object(); a.next = b; b = null; c = null; gc();",
    0,
    null,
    [
      "--trace",
      tracePath,
      "--trace-level",
      "full",
      "--batch-size",
      "3",
      "--snapshots-dir",
      snapshotsDirectory,
    ],
  );
  assert.equal(observed.engineResult.runtime.heap.observer, true);
  assert.equal(observed.engineResult.snapshots.length, 2);
  const snapshots = observed.engineResult.snapshots.map(({ index }) =>
    JSON.parse(fs.readFileSync(path.join(snapshotsDirectory, `snapshot-${index}.json`), "utf8")),
  );
  assert.deepEqual(
    snapshots.map(({ point }) => point),
    ["mark_complete", "program_end"],
  );
  assert.equal(snapshots[0].objects.length, 3);
  assert.equal(snapshots[0].objects.filter(({ marked }) => marked).length, 2);
  assert.equal(snapshots[0].objects.filter(({ marked }) => !marked).length, 1);
  assert.equal(snapshots[1].objects.length, 2);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.schema, "gcd.heap-snapshot/1");
    assert.equal(snapshot.runId, observed.runId);
  }

  const traceLines = fs.readFileSync(tracePath, "utf8").trim().split("\n");
  const trailer = JSON.parse(traceLines.pop());
  assert.equal(trailer.type, "end");
  assert.equal(trailer.complete, true);
  const batches = traceLines.map((line) => JSON.parse(line));
  const interned = new Map();
  const events = [];
  let expectedSequence = 1;
  batches.forEach((batch, batchIndex) => {
    assert.equal(batch.schema, "gcd.trace-batch/1");
    assert.equal(batch.runId, observed.runId);
    assert.equal(batch.batch, batchIndex);
    assert.equal(batch.firstSeq, expectedSequence);
    for (const [id, value] of Object.entries(batch.strings)) interned.set(Number(id), value);
    for (const event of batch.events) {
      assert.equal(event[0], expectedSequence++);
      events.push(event);
    }
    assert.equal(batch.lastSeq, expectedSequence - 1);
  });
  assert.equal(trailer.lastSeq, expectedSequence - 1);

  const model = new Map();
  const roots = new Map();
  let freedAtCurrentGc = [];
  for (const event of events) {
    const [, kind] = event;
    if (kind === "A") {
      model.set(event[3], new Map());
    } else if (kind === "RS") {
      const name = interned.get(event[3]);
      if (event[4] === null) roots.delete(name);
      else roots.set(name, event[4]);
    } else if (kind === "RC") {
      roots.delete(interned.get(event[3]));
    } else if (kind === "FW") {
      const fields = model.get(event[4]);
      assert.ok(fields, `write to unknown object ${event[4]}`);
      fields.set(interned.get(event[3]), event[5]);
    } else if (kind === "SF") {
      freedAtCurrentGc.push(event[3]);
    } else if (kind === "GE") {
      const reachable = new Set();
      const worklist = [...roots.values()];
      while (worklist.length > 0) {
        const handle = worklist.pop();
        if (handle === null || reachable.has(handle) || !model.has(handle)) continue;
        reachable.add(handle);
        worklist.push(...model.get(handle).values());
      }
      const expectedFreed = [...model.keys()].filter((handle) => !reachable.has(handle)).sort();
      assert.deepEqual(freedAtCurrentGc.sort(), expectedFreed);
      for (const handle of expectedFreed) model.delete(handle);
      freedAtCurrentGc = [];
    }
  }
  assert.equal(observed.engineResult.collections[0].freed.value, 1);

  const gcTracePath = path.join(temporaryDirectory, "gc-level.ndjson");
  runCase("gc-level", "a = new Object(); gc();", 0, null, [
    "--trace",
    gcTracePath,
    "--trace-level",
    "gc",
    "--batch-size",
    "1",
  ]);
  const gcBatches = fs
    .readFileSync(gcTracePath, "utf8")
    .trim()
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line));
  const gcKinds = gcBatches.flatMap(({ events: batchEvents }) =>
    batchEvents.map((event) => event[1]),
  );
  assert.ok(gcKinds.includes("GB"));
  assert.ok(gcKinds.includes("GE"));
  assert.ok(gcKinds.every((kind) => ["SB", "SE", "GB", "GE"].includes(kind)));

  const errorTrace = path.join(temporaryDirectory, "error.ndjson");
  runCase(
    "traced-error",
    "a = 5; a.f = null;",
    2,
    "RUNTIME_ERROR",
    ["--trace", errorTrace, "--trace-level", "full"],
  );
  const errorTraceLines = fs.readFileSync(errorTrace, "utf8").trim().split("\n");
  assert.equal(JSON.parse(errorTraceLines.at(-1)).type, "end");

  runCase("source-too-large", " ".repeat(65537), 2, "SOURCE_TOO_LARGE");

  const truncated = runCase("stdout-limit", "gc();".repeat(1000), 0);
  assert.equal(truncated.output.stdout.length, 65536);
  assert.equal(truncated.output.stdoutTruncated, true);

  const truncatedAst = runCase("ast-limit", "a=1;".repeat(3000), 0);
  assert.equal(truncatedAst.staticAnalysis.nodeCount, 5000);
  assert.equal(truncatedAst.staticAnalysis.truncated, true);

  const control = runCase("control-character", "a = \u0001;", 2, "LEX_ERROR");
  assert.ok(control.errors[0].message.includes("\u0001"));

  const usage = spawnSync(runner, ["--unknown"], { encoding: "utf8" });
  assert.equal(usage.status, 3);

  // Regions and slot reuse (Phase 6): flags are validated, and variants never change reclamation.
  const regionProgram = "a = new Object();\nb = new Object();\na.n = b;\nc = new Object();\nc = null;\ngc();\n";
  const plain = runCase("variant-plain", regionProgram, 0);
  const regionDirectory = path.join(temporaryDirectory, "regions");
  const variant = runCase("variant-both", regionProgram, 0, null, [
    "--region-size", "16", "--slot-reuse", "--regions-dir", regionDirectory,
  ]);
  assert.deepEqual(variant.engineResult.runtime.heap, { regionSize: 16, slotReuse: true, observer: false });
  assert.deepEqual(
    variant.engineResult.collections.map((c) => [c.freed.value, c.liveAfter.value]),
    plain.engineResult.collections.map((c) => [c.freed.value, c.liveAfter.value]),
  );
  assert.deepEqual(variant.engineResult.regionGraphs.map((g) => g.point), ["gc_end", "program_end"]);
  assert.ok(variant.engineResult.regionGraphs.every((g) => g.verified));
  const regionDocument = JSON.parse(fs.readFileSync(path.join(regionDirectory, "region-0.json"), "utf8"));
  assert.equal(regionDocument.schema, "gcd.region-graph/1");
  assert.equal(regionDocument.regions[0].freedLastGc, 1);
  assert.equal(regionDocument.regions[0].intraEdges, 1);
  for (const bad of [["--region-size", "48"], ["--region-size", "1"], ["--regions-dir", temporaryDirectory]]) {
    const rejected = spawnSync(runner, ["--source", path.join(temporaryDirectory, "variant-plain.gcd"), "--result", path.join(temporaryDirectory, "bad.json"), ...bad], { encoding: "utf8" });
    assert.equal(rejected.status, 3, `${bad.join(" ")} should be a usage error`);
  }

  console.log("runner tests passed");
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
NODE
