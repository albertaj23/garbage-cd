import type { HeapSnapshot, RunResult, SnapshotObject, TraceBatch } from "@gcd/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/GraphCanvas", () => ({
  GraphCanvas: ({ graph, highlight, onSelect }: { graph: { nodes: Array<{ id: string; state: string }> }; highlight: { nodeIds: string[] } | null; onSelect: (id: string) => void }) => (
    <div data-testid="graph-canvas" data-highlight={highlight?.nodeIds.join(",") ?? ""}>
      {graph.nodes.map((node) => (
        <button key={node.id} data-state={node.state} onClick={() => onSelect(node.id)}>
          {node.id}
        </button>
      ))}
    </div>
  )
}));

import { HeapGraphPanel, HOTSPOT_NOTICE } from "../src/components/HeapGraphPanel";
import { TimelinePanel } from "../src/components/TimelinePanel";
import { buildGraph, whyAlive } from "../src/lib/graph";
import { parseSnapshot, SnapshotRejected } from "../src/lib/snapshot";
import { buildTimeline } from "../src/lib/timeline";
import type { TraceState } from "../src/useTrace";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const obj = (id: string, over: Partial<SnapshotObject> = {}): SnapshotObject => ({
  id,
  slot: Number(id),
  generation: 0,
  region: null,
  allocSeq: Number(id) + 1,
  allocStatement: Number(id),
  marked: true,
  fields: [],
  ...over
});

/** root "r" -> 0 -next-> 1 -next-> 2 ; object 3 is unreachable. */
function snapshot(over: Partial<HeapSnapshot> = {}): HeapSnapshot {
  return {
    schema: "gcd.heap-snapshot/1",
    runId: "run1",
    index: 0,
    point: "mark_complete",
    gcIndex: 1,
    statementIndex: 4,
    totalObjects: 4,
    totalEdges: 3,
    truncated: false,
    roots: [{ name: "r", target: "0" }],
    objects: [
      obj("0", { fields: [{ name: "next", target: "1" }], discoveredBy: { parent: null, field: null, root: "r" } }),
      obj("1", { fields: [{ name: "next", target: "2" }], discoveredBy: { parent: "0", field: "next", root: null } }),
      obj("2", { discoveredBy: { parent: "1", field: "next", root: null } }),
      obj("3", { marked: false, fields: [{ name: "ref", target: "3" }] })
    ],
    ...over
  };
}

function run(over: Partial<RunResult> = {}): RunResult {
  return {
    schema: "gcd.run-result/1",
    runId: "run1",
    engine: "custom",
    language: "gcd-toy",
    sourceSha256: "0".repeat(64),
    createdAt: "t",
    status: "succeeded",
    phases: {},
    output: { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false },
    errors: [],
    limits: {},
    toolVersions: {},
    trace: { available: true, complete: true, eventCount: 5, droppedCount: 0, batchCount: 1 },
    engineResult: {
      kind: "custom",
      snapshots: [
        { index: 0, gcIndex: 1, point: "mark_complete", objectCount: 4, truncated: false },
        { index: 1, gcIndex: null, point: "program_end", objectCount: 3, truncated: false }
      ],
      collections: [{ gcIndex: 1, statementIndex: 4, liveBefore: { value: 4 }, liveAfter: { value: 3 }, freed: { value: 1 } }]
    },
    ...over
  };
}

describe("graph model", () => {
  it("classifies survivors, victims and roots and adds root entry nodes", () => {
    const graph = buildGraph(snapshot());
    const state = Object.fromEntries(graph.nodes.map((node) => [node.id, node.state]));
    expect(state).toMatchObject({ "0": "survived", "3": "freed", "root:r": "root" });
    expect(graph.nodes.find((node) => node.id === "0")?.isRootTarget).toBe(true);
    expect(graph.edges.filter((edge) => edge.isRootEdge)).toHaveLength(1);
    expect(graph.edges.find((edge) => edge.source === "3")?.label).toBe("ref");
    expect(graph.rootEntries).toEqual(["root:r"]);
  });

  it("marks everything live at program end and omits edges leaving a truncated slice", () => {
    const end = snapshot({ point: "program_end", objects: [obj("0", { marked: null, fields: [{ name: "next", target: "9" }] })] });
    const graph = buildGraph(end);
    expect(graph.nodes.find((node) => node.id === "0")?.state).toBe("live");
    expect(graph.edges.filter((edge) => !edge.isRootEdge)).toHaveLength(0);
  });

  it("explains why a chain tail is alive by highlighting the whole path to its root", () => {
    const result = whyAlive(snapshot(), "2");
    expect(result.kind).toBe("path");
    if (result.kind !== "path") return;
    expect(result.nodeIds).toEqual(["root:r", "0", "1", "2"]);
    expect(result.edgeIds).toEqual(["r:0", "e:0:0", "e:1:0"]);
    expect(result.description).toContain("through 2 intermediate objects");
  });

  it("says a direct root target is pointed at directly, and that victims will be freed", () => {
    expect(whyAlive(snapshot(), "0")).toMatchObject({ kind: "path", description: expect.stringContaining("directly") });
    expect(whyAlive(snapshot(), "3")).toMatchObject({ kind: "freed" });
    expect(whyAlive(snapshot({ objects: [obj("0", { marked: null })] }), "0").kind).toBe("unknown");
    expect(whyAlive(snapshot(), "42").kind).toBe("unknown");
  });

  it("does not loop forever on a corrupt discovery cycle", () => {
    const corrupt = snapshot({
      objects: [
        obj("0", { discoveredBy: { parent: "1", field: "x", root: null } }),
        obj("1", { discoveredBy: { parent: "0", field: "x", root: null } })
      ]
    });
    expect(whyAlive(corrupt, "0").kind).toBe("unknown");
  });
});

describe("snapshot validation", () => {
  it("accepts a well-formed snapshot", () => {
    expect(parseSnapshot(snapshot()).objects).toHaveLength(4);
  });

  it("rejects malformed documents as invalid", () => {
    expect(() => parseSnapshot({ schema: "other" })).toThrow(SnapshotRejected);
    expect(() => parseSnapshot({ ...snapshot(), objects: [{ id: "x", fields: [] }] })).toThrow(/malformed object/);
    expect(() => parseSnapshot({ ...snapshot(), objects: [obj("0"), obj("0")] })).toThrow(/Duplicate/);
    expect(() => parseSnapshot({ ...snapshot(), roots: [{ name: "r", target: "zz" }] })).toThrow(/malformed root/);
  });

  it("refuses 2,001 objects as too large", () => {
    const objects = Array.from({ length: 2_001 }, (_, index) => obj(String(index)));
    try {
      parseSnapshot({ ...snapshot(), objects });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotRejected);
      expect((error as SnapshotRejected).kind).toBe("too-large");
    }
    expect(parseSnapshot({ ...snapshot(), objects: objects.slice(0, 2_000) }).objects).toHaveLength(2_000);
  });
});

function stubSnapshots(responses: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const body = responses[url];
      return Promise.resolve(
        body === undefined
          ? new Response(JSON.stringify({ error: { code: "X", message: "missing" } }), { status: 404 })
          : new Response(JSON.stringify(body), { status: 200 })
      );
    })
  );
}

describe("HeapGraphPanel", () => {
  let selected = 0;
  beforeEach(() => {
    selected = 0;
  });
  const panel = (r: RunResult | null, partial = false) => (
    <HeapGraphPanel run={r} selectedIndex={selected} onSelectIndex={(index) => (selected = index)} tracePartial={partial} />
  );

  it("draws the mark-complete snapshot with an honest header and why-alive on click", async () => {
    stubSnapshots({ "/api/runs/run1/snapshots/0": snapshot() });
    render(panel(run()));
    expect(await screen.findByText("Custom runtime heap at GC #1 (mark complete)")).toBeTruthy();
    const canvas = await screen.findByTestId("graph-canvas");
    expect(canvas.querySelector('[data-state="freed"]')?.textContent).toBe("3");
    fireEvent.click(screen.getByText("2"));
    expect(screen.getByText(/alive because root "r"/)).toBeTruthy();
    expect(screen.getByTestId("graph-canvas").getAttribute("data-highlight")).toBe("root:r,0,1,2");
    fireEvent.click(screen.getByText("3"));
    expect(screen.getByText(/will be freed by this collection/)).toBeTruthy();
  });

  it("moves between snapshots with the slider", async () => {
    stubSnapshots({
      "/api/runs/run1/snapshots/0": snapshot(),
      "/api/runs/run1/snapshots/1": snapshot({ index: 1, point: "program_end", gcIndex: null, objects: [obj("0", { marked: null })] })
    });
    const { rerender } = render(panel(run()));
    await screen.findByText("Custom runtime heap at GC #1 (mark complete)");
    fireEvent.change(screen.getByLabelText("Snapshot"), { target: { value: "1" } });
    expect(selected).toBe(1);
    rerender(panel(run()));
    expect(await screen.findByText("Custom runtime heap at program end")).toBeTruthy();
  });

  it("shows an error card instead of a graph for a snapshot that fails validation", async () => {
    stubSnapshots({ "/api/runs/run1/snapshots/0": { schema: "wrong" } });
    render(panel(run()));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be displayed");
    expect(screen.queryByTestId("graph-canvas")).toBeNull();
  });

  it("refuses a 2,001-object snapshot and points at the Regions tab", async () => {
    const objects = Array.from({ length: 2_001 }, (_, index) => obj(String(index)));
    stubSnapshots({ "/api/runs/run1/snapshots/0": snapshot({ objects, totalObjects: 2_001 }) });
    render(panel(run()));
    const card = await screen.findByRole("alert");
    expect(card.textContent).toContain("too large");
    expect(card.textContent).toContain("Regions tab");
    expect(screen.queryByTestId("graph-canvas")).toBeNull();
  });

  it("warns when a snapshot is truncated and when the trace is incomplete", async () => {
    stubSnapshots({ "/api/runs/run1/snapshots/0": snapshot({ truncated: true, totalObjects: 5000 }) });
    render(panel(run({ trace: { available: true, complete: false, eventCount: 5, droppedCount: 12, batchCount: 1 } })));
    expect(await screen.findByText(/Truncated: showing 4 of 5000 objects/)).toBeTruthy();
    expect(screen.getByText(/Trace incomplete: 12 events were dropped/)).toBeTruthy();
  });

  it("explains that HotSpot has no object graph and waits for running runs", () => {
    render(panel(run({ engine: "jvm", language: "java" })));
    expect(screen.getByRole("note").textContent).toBe(HOTSPOT_NOTICE);
    cleanup();
    render(panel(run({ status: "running" })));
    expect(screen.getByText(/appear when the run finishes/)).toBeTruthy();
  });
});

describe("timeline", () => {
  const batch = (events: TraceBatch["events"]): TraceBatch => ({
    schema: "gcd.trace-batch/1",
    runId: "run1",
    batch: 0,
    firstSeq: 1,
    lastSeq: events.length,
    droppedTotal: 0,
    strings: {},
    events
  });
  const trace = (over: Partial<TraceState> = {}): TraceState => ({
    status: "ready",
    partial: false,
    error: null,
    batches: [batch([[1, "A", 0, "0"], [2, "A", 0, "1"], [3, "RS", 1, 0, "0"], [4, "FW", 2, 1, "0", "1", null], [5, "GB", 3, 1]])],
    ...over
  });

  it("buckets mutator events per statement and lifts GC markers from the collection records", () => {
    const result = buildTimeline(trace().batches, run().engineResult!.collections as Array<Record<string, unknown>>);
    expect(result.buckets.map((bucket) => [bucket.statement, bucket.allocations, bucket.rootChanges, bucket.fieldWrites])).toEqual([
      [0, 2, 0, 0],
      [1, 0, 1, 0],
      [2, 0, 0, 1],
      [3, 0, 0, 0]
    ]);
    expect(result.gcs).toEqual([{ gcIndex: 1, statement: 4, liveBefore: 4, liveAfter: 3, freed: 1 }]);
    expect(result.maxStatement).toBe(4);
  });

  it("renders bars and opens the snapshot of a clicked GC marker", () => {
    const onSelectGc = vi.fn();
    render(<TimelinePanel run={run()} trace={trace()} onSelectGc={onSelectGc} />);
    expect(screen.getAllByTestId("bucket")).toHaveLength(4);
    fireEvent.click(screen.getByLabelText("GC 1"));
    expect(onSelectGc).toHaveBeenCalledWith(0);
  });

  it("shows banners, loading, errors and the HotSpot note", () => {
    const incomplete = run({ trace: { available: true, complete: false, eventCount: 5, droppedCount: 0, batchCount: 1 } });
    render(<TimelinePanel run={incomplete} trace={trace({ partial: true })} onSelectGc={() => undefined} />);
    expect(screen.getByText(/Trace incomplete: the runner did not finish/)).toBeTruthy();
    expect(screen.getByText(/Only the first part of the trace/)).toBeTruthy();
    cleanup();
    render(<TimelinePanel run={run()} trace={trace({ status: "loading", batches: [] })} onSelectGc={() => undefined} />);
    expect(screen.getByText(/Loading trace/)).toBeTruthy();
    cleanup();
    render(<TimelinePanel run={run()} trace={trace({ status: "error", error: "boom", batches: [] })} onSelectGc={() => undefined} />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    cleanup();
    render(<TimelinePanel run={run({ engine: "jvm" })} trace={trace()} onSelectGc={() => undefined} />);
    expect(screen.getByRole("note").textContent).toContain("HotSpot");
    cleanup();
    render(<TimelinePanel run={run({ trace: { available: false, complete: false, eventCount: 0, droppedCount: 0, batchCount: 0 } })} trace={trace()} onSelectGc={() => undefined} />);
    expect(screen.getByText(/was not traced/)).toBeTruthy();
  });
});

describe("useTrace paging", () => {
  it("follows next cursors without gaps or duplicates", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { useTrace } = await import("../src/useTrace");
    const page = (first: number, next: number | null) => ({
      batches: [{ schema: "gcd.trace-batch/1", runId: "run1", batch: first, firstSeq: first, lastSeq: first + 1, droppedTotal: 0, strings: {}, events: [[first, "SB", 0], [first + 1, "SE", 0]] }],
      next,
      trailer: null
    });
    const fetchMock = vi.fn((url: string) => {
      const after = Number(new URL(url, "http://x").searchParams.get("afterSeq"));
      return Promise.resolve(new Response(JSON.stringify(after === -1 ? page(1, 2) : after === 2 ? page(3, 4) : page(5, null)), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTrace(run()));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.batches.flatMap((item) => item.events.map((event) => event[0]))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.current.partial).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
