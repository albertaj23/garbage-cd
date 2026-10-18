import { compareRuns, COMPARE_HEADER, type BenchmarkSummary, type Metric, type RunResult } from "@gcd/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BenchmarkPanel } from "../src/components/BenchmarkPanel";
import { ComparePanel } from "../src/components/ComparePanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const m = (value: number | null, unit: string, over: Partial<Metric> = {}): Metric => ({
  value,
  unit,
  provenance: value === null ? "unavailable" : "measured",
  source: "test",
  ...over
});

function run(id: string, engine: "jvm" | "custom", totals: Record<string, Metric>): RunResult {
  return {
    schema: "gcd.run-result/1",
    runId: id.padEnd(26, "0"),
    engine,
    language: engine === "jvm" ? "java" : "gcd-toy",
    sourceSha256: "0".repeat(64),
    createdAt: "t",
    status: "succeeded",
    phases: {},
    output: { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false },
    errors: [],
    limits: {},
    toolVersions: {},
    engineResult: { kind: engine, totals }
  };
}

describe("compareRuns (F.4)", () => {
  it("computes a delta only for the same engine, key and unit when neither side is unavailable", () => {
    const a = run("A", "custom", { allocations: m(10, "objects"), freed: m(4, "objects"), wallTimeMs: m(5, "ms"), liveAfter: m(null, "objects") });
    const b = run("B", "custom", { allocations: m(20, "objects"), freed: m(6, "B"), wallTimeMs: m(2.5, "ms"), liveAfter: m(3, "objects"), extra: m(1, "x") });
    const rows = Object.fromEntries(compareRuns(a, b).rows.map((row) => [row.label, row]));
    expect(rows.allocations!.kind).toBe("delta");
    expect(rows.allocations!.delta).toEqual({ absolute: 10, ratio: 2 });
    expect(rows.wallTimeMs!.delta!.ratio).toBe(0.5);
    expect(rows.freed!.kind).toBe("side-by-side");
    expect(rows.freed!.note).toContain("different units");
    expect(rows.freed!.delta).toBeUndefined();
    expect(rows.liveAfter!.kind).toBe("side-by-side");
    expect(rows.liveAfter!.note).toContain("unavailable");
    expect(rows.extra!.kind).toBe("one-sided");
  });

  it("never emits a delta across engines and never a wall-time ratio", () => {
    const jvm = run("J", "jvm", { gcCount: m(40, "collections"), wallTimeMs: m(120, "ms"), allocatedBytesMainThread: m(1000, "bytes"), objectsReclaimed: m(null, "objects"), heapPeakUsed: m(2048, "bytes") });
    const custom = run("C", "custom", { collections: m(4, "collections"), wallTimeMs: m(3, "ms"), allocations: m(50, "objects"), freed: m(40, "objects"), liveAfter: m(10, "objects") });
    const comparison = compareRuns(jvm, custom);
    expect(comparison.crossEngine).toBe(true);
    expect(comparison.header).toBe(COMPARE_HEADER);
    expect(comparison.rows.every((row) => row.kind === "side-by-side" && row.delta === undefined)).toBe(true);
    const wall = comparison.rows.find((row) => row.label === "Wall time")!;
    expect(wall.a!.value).toBe(120);
    expect(wall.b!.value).toBe(3);
    expect(wall.note).toContain("never combined into a speed-up");
    const swapped = compareRuns(custom, jvm).rows.find((row) => row.label === "Collections")!;
    expect(swapped.a!.value).toBe(4);
    expect(swapped.b!.value).toBe(40);
    expect(swapped.note).toContain("not directly comparable");
  });

  it("flags differing provenance on a legitimate delta", () => {
    const a = run("A", "custom", { x: m(1, "u") });
    const b = run("B", "custom", { x: m(2, "u", { provenance: "estimated" }) });
    expect(compareRuns(a, b).rows[0]!.note).toContain("provenance differs");
  });
});

describe("ComparePanel", () => {
  it("asks for two runs, then shows the header, cells and no-delta text", () => {
    const one = run("A", "custom", { allocations: m(1, "objects") });
    const { rerender } = render(<ComparePanel history={[one]} />);
    expect(screen.getByText(/at least two programs/)).toBeTruthy();
    const two = run("B", "jvm", { gcCount: m(2, "collections") });
    rerender(<ComparePanel history={[one, two]} />);
    expect(screen.getByRole("note").textContent).toBe(COMPARE_HEADER);
    expect(screen.getAllByText("no delta").length).toBeGreaterThan(0);
    expect(screen.queryByText(/×\d/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Run B"), { target: { value: "0" } });
    expect(screen.getByText(/Allocations|allocations/i)).toBeTruthy();
  });
});

const summary: BenchmarkSummary = {
  schema: "gcd.benchmark-summary/1",
  id: "2026-10-18-test",
  createdAt: "2026-10-18T00:00:00Z",
  environment: { cpuModel: "Test CPU", cores: 8, power: "AC" },
  method: { resamples: 10000, minEffect: 0.02, noiseRule: "a difference is real if the CI excludes 1" },
  collector: [
    { workload: "W1", variant: "B", samples: 30, medianTotalMs: 10, medianCollectMs: 5, total: { ratio: 1.2, lo: 1.1, hi: 1.3, real: true }, collect: { ratio: 1, lo: 0.9, hi: 1.1, real: false } }
  ],
  hypotheses: [
    { id: "H5", statement: "Observation never changes collection", criterion: "identical freed sets", verdict: "pass", evidence: "0 mismatches" },
    { id: "H3-full", statement: "Batching lowers overhead", criterion: "removes 50%", verdict: "fail", evidence: "2 of 7" },
    { id: "H2", statement: "Overview is cheaper", criterion: "2x", verdict: "inconclusive", evidence: "no data" }
  ],
  h2: [{ objects: 100000, snapshotMs: 12.5, exportMs: 0.5, ratio: 25, lo: 20, hi: 30 }],
  jvm: [{ program: "J1", collector: "serial", runs: 10, gcCount: 101, gcPauseTotalMs: 60, heapAfterLastGcBytes: 1048576, wallMs: 120 }]
};

describe("BenchmarkPanel", () => {
  const stub = (map: Record<string, unknown>) =>
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          map[url] === undefined
            ? new Response(JSON.stringify({ error: { code: "X", message: "missing" } }), { status: 404 })
            : new Response(JSON.stringify(map[url]), { status: 200 })
        )
      )
    );

  it("shows every verdict with a glyph, the evidence, the F.4 note and the ratio chart", async () => {
    stub({ "/api/benchmarks": [{ id: "2026-10-18-test", createdAt: "x" }], "/api/benchmarks/2026-10-18-test": summary });
    render(<BenchmarkPanel />);
    expect(await screen.findByText("Observation never changes collection")).toBeTruthy();
    expect(screen.getByText("✔ pass")).toBeTruthy();
    expect(screen.getByText("✖ fail")).toBeTruthy();
    expect(screen.getByText("? inconclusive")).toBeTruthy();
    expect(screen.getByText("0 mismatches")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("Separate runtimes, separate programs");
    expect(screen.getByRole("img", { name: /relative to A-prime/ })).toBeTruthy();
    expect(screen.getByText(/×1\.200/, { selector: "title" })).toBeTruthy();
    expect(screen.getByText(/real/, { selector: "title" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "collect" } });
    await waitFor(() => expect(screen.getByText(/within noise/, { selector: "title" })).toBeTruthy());
  });

  it("explains an empty listing and surfaces load errors", async () => {
    stub({ "/api/benchmarks": [] });
    render(<BenchmarkPanel />);
    expect(await screen.findByText(/No committed benchmark results/)).toBeTruthy();
    cleanup();
    stub({});
    render(<BenchmarkPanel />);
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
  });
});
