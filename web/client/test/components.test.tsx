import type { AstNode, Metric, RunResult, StaticAnalysisResult } from "@gcd/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AstPanel } from "../src/components/AstPanel";
import { OutputPanel } from "../src/components/OutputPanel";
import { MetricValue, ProvenanceBadge } from "../src/components/ProvenanceBadge";
import { StatsPanel } from "../src/components/StatsPanel";
import { isActive, reducer, initialState } from "../src/store";

afterEach(cleanup);

const metric = (over: Partial<Metric> = {}): Metric => ({
  value: 5,
  unit: "ms",
  provenance: "measured",
  source: "test source",
  ...over
});

function run(over: Partial<RunResult> = {}): RunResult {
  return {
    schema: "gcd.run-result/1",
    runId: "01M55N1Y3H22E6825WH41B0ZGN",
    engine: "jvm",
    language: "java",
    sourceSha256: "0".repeat(64),
    createdAt: "2026-01-01T00:00:00Z",
    status: "succeeded",
    phases: {},
    output: { stdout: "hi\n", stderr: "", stdoutTruncated: false, stderrTruncated: false },
    errors: [],
    limits: {},
    toolVersions: {},
    ...over
  };
}

describe("provenance", () => {
  it("renders every badge with its letter and a tooltip carrying source and note", () => {
    const cases: Array<[Metric["provenance"], string]> = [
      ["measured", "M"],
      ["estimated", "E"],
      ["reconstructed", "R"],
      ["unavailable", "U"]
    ];
    for (const [provenance, letter] of cases) {
      const { unmount } = render(<ProvenanceBadge metric={metric({ provenance, note: "why" })} />);
      const badge = screen.getByLabelText(`provenance ${provenance}`);
      expect(badge.textContent).toBe(letter);
      expect(badge.getAttribute("title")).toContain("test source");
      expect(badge.getAttribute("title")).toContain("why");
      unmount();
    }
  });

  it("renders a missing metric as Unavailable with its reason", () => {
    render(<MetricValue metric={metric({ value: null, provenance: "unavailable", note: "not exposed by HotSpot" })} />);
    expect(screen.getByText(/Unavailable/).textContent).toContain("not exposed by HotSpot");
  });
});

describe("StatsPanel", () => {
  it("shows a placeholder before any run and a partial note while running", () => {
    const { unmount } = render(<StatsPanel run={null} />);
    expect(screen.getByText(/Run a program/)).toBeTruthy();
    unmount();
    render(<StatsPanel run={run({ status: "running" })} />);
    expect(screen.getByText(/statistics appear when it finishes/)).toBeTruthy();
  });

  it("renders totals with badges and unavailable metrics", () => {
    render(
      <StatsPanel
        run={run({
          engineResult: {
            kind: "jvm",
            jvm: { version: "21", vendor: "X", collector: "serial" },
            totals: {
              gcCount: metric({ value: 3, unit: "collections" }),
              objectsReclaimed: metric({ value: null, provenance: "unavailable", note: "HotSpot hides this" })
            },
            collections: []
          }
        })}
      />
    );
    expect(screen.getByText("3 collections")).toBeTruthy();
    expect(screen.getByText(/HotSpot hides this/)).toBeTruthy();
    expect(screen.getAllByLabelText("provenance measured").length).toBeGreaterThan(0);
    expect(screen.getByText(/No collections were recorded/)).toBeTruthy();
  });
});

describe("OutputPanel", () => {
  it("jumps to the location of a program error", () => {
    const onJump = vi.fn();
    render(
      <OutputPanel
        run={run({
          status: "program_error",
          errors: [
            {
              code: "UNCAUGHT_EXCEPTION",
              phase: "execute",
              message: "boom",
              location: { line: 4, column: 9, provenance: "derived" },
              detail: { stackTop: ["at Main.main(Main.java:4)"] }
            }
          ]
        })}
        onJump={onJump}
      />
    );
    fireEvent.click(screen.getByText("line 4:9"));
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ line: 4, column: 9 }));
    expect(screen.getByText(/Main.main/)).toBeTruthy();
  });

  it("renders a program error without a location and no jump link", () => {
    render(
      <OutputPanel
        run={run({ status: "program_error", errors: [{ code: "PROGRAM_EXIT", phase: "execute", message: "exit 7" }] })}
        onJump={() => undefined}
      />
    );
    expect(screen.getByText("PROGRAM_EXIT")).toBeTruthy();
    expect(screen.queryByText(/^line /)).toBeNull();
  });

  it("shows compiler diagnostics and truncation banners", () => {
    const analysis: StaticAnalysisResult = {
      schema: "gcd.static-analysis/1",
      language: "java",
      ast: null,
      nodeCount: 0,
      truncated: false,
      diagnostics: [
        { severity: "error", code: "x", message: "illegal start", location: { line: 2, column: 3, provenance: "compiler" } }
      ]
    };
    render(
      <OutputPanel
        run={run({
          status: "compile_error",
          staticAnalysis: analysis,
          output: { stdout: "abc", stderr: "e", stdoutTruncated: true, stderrTruncated: false }
        })}
        onJump={() => undefined}
      />
    );
    expect(screen.getByText("illegal start", { exact: false })).toBeTruthy();
    expect(screen.getByText(/stdout truncated/)).toBeTruthy();
    expect(screen.getByLabelText("stderr").textContent).toBe("e");
  });
});

describe("AstPanel", () => {
  const leaf = (id: number, extra: Partial<AstNode> = {}): AstNode => ({ id, kind: "LEAF", children: [], ...extra });
  const analysis = (over: Partial<StaticAnalysisResult> = {}): StaticAnalysisResult => ({
    schema: "gcd.static-analysis/1",
    language: "java",
    nodeCount: 5,
    truncated: false,
    diagnostics: [],
    ast: {
      id: 0,
      kind: "ROOT",
      children: [
        { id: 1, kind: "MID", children: [{ id: 2, kind: "DEEP", children: [leaf(3, { label: "hidden" })] }] },
        leaf(4, { synthetic: true })
      ]
    },
    ...over
  });

  it("expands lazily, flags synthetic nodes, and reports truncation", () => {
    render(<AstPanel analysis={analysis({ truncated: true })} onSelectSpan={() => undefined} />);
    expect(screen.getByText(/truncated at 5,000 nodes/)).toBeTruthy();
    expect(screen.getByText("synthetic")).toBeTruthy();
    expect(screen.queryByText("hidden")).toBeNull();
    fireEvent.click(screen.getAllByLabelText("expand")[0]!);
    fireEvent.click(screen.getAllByLabelText("expand")[0]!);
    expect(screen.queryByText("hidden")).not.toBeNull();
  });

  it("reports the span of a clicked node and says when no AST exists", () => {
    const onSelectSpan = vi.fn();
    const data = analysis();
    data.ast!.children[0]!.span = { start: 3, end: 9, line: 1, column: 4, endLine: 1, endColumn: 10, provenance: "compiler" };
    render(<AstPanel analysis={data} onSelectSpan={onSelectSpan} />);
    fireEvent.click(screen.getByText("MID"));
    expect(onSelectSpan).toHaveBeenCalledWith({ start: 3, end: 9 });
    cleanup();
    render(<AstPanel analysis={undefined} onSelectSpan={onSelectSpan} />);
    expect(screen.getByText(/No AST available/)).toBeTruthy();
  });
});

describe("store", () => {
  it("ignores progress for other runs, keeps edits per engine, and tracks activity", () => {
    const withSamples = reducer(initialState, {
      type: "samples",
      samples: { jvm: [{ engine: "jvm", name: "A", source: "a" }], custom: [{ engine: "custom", name: "B", source: "b" }] }
    });
    expect(withSamples.sources).toEqual({ jvm: "a", custom: "b" });
    const started = reducer(withSamples, { type: "started", runId: "r1", source: "" });
    expect(isActive(started.run, started.runId)).toBe(true);
    expect(reducer(started, { type: "progress", run: run({ runId: "other" }) }).run).toBeNull();
    const done = reducer(started, { type: "progress", run: run({ runId: "r1" }) });
    expect(isActive(done.run, done.runId)).toBe(false);
    const edited = reducer(withSamples, { type: "edit", source: "zzz" });
    expect(edited.sampleName).toBe("");
    expect(reducer(edited, { type: "engine", engine: "custom" }).sources.jvm).toBe("zzz");
  });
});
