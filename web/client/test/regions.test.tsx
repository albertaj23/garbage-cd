import type { HeapSnapshot, RegionGraph, RunResult } from "@gcd/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/RegionCanvas", () => ({
  RegionCanvas: ({ graph, onSelect }: { graph: RegionGraph; onSelect: (id: number) => void }) => (
    <div data-testid="region-canvas">
      {graph.regions.map((region) => (
        <button key={region.id} onClick={() => onSelect(region.id)}>
          region-{region.id}
        </button>
      ))}
      <span data-testid="edge-count">{graph.edges.length}</span>
    </div>
  )
}));

import { RegionPanel } from "../src/components/RegionPanel";
import { TopBar } from "../src/components/TopBar";
import { api } from "../src/api";
import { buildGraph } from "../src/lib/graph";
import { parseRegionGraph, RegionGraphRejected } from "../src/lib/regions";
import { initialState, reducer } from "../src/store";
import { App } from "../src/App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const graph = (over: Partial<RegionGraph> = {}): RegionGraph => ({
  schema: "gcd.region-graph/1",
  runId: "run1",
  index: 0,
  point: "gc_end",
  regionSize: 16,
  gcIndex: 1,
  statementIndex: 5,
  verified: true,
  regions: [
    { id: 0, slotStart: 0, slotEnd: 15, liveObjects: 3, allocatedTotal: 5, survivorsLastGc: 3, freedLastGc: 2, rootTargets: 1, intraEdges: 2 },
    { id: 1, slotStart: 16, slotEnd: 31, liveObjects: 1, allocatedTotal: 1, survivorsLastGc: 1, freedLastGc: 0, rootTargets: 0, intraEdges: 0 }
  ],
  edges: [{ from: 0, to: 1, count: 2 }],
  ...over
});

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
    engineResult: {
      kind: "custom",
      snapshots: [
        { index: 0, gcIndex: 1, point: "mark_complete", objectCount: 4, truncated: false },
        { index: 1, gcIndex: null, point: "program_end", objectCount: 3, truncated: false }
      ],
      regionGraphs: [
        { index: 0, gcIndex: 1, point: "gc_end", regionCount: 2, verified: true },
        { index: 1, gcIndex: null, point: "program_end", regionCount: 2, verified: true }
      ]
    },
    ...over
  };
}

function stubRegions(body: unknown, status = 200) {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const panel = (r: RunResult | null, snapshotIndex = 0, props: Partial<Parameters<typeof RegionPanel>[0]> = {}) => (
  <RegionPanel run={r} snapshotIndex={snapshotIndex} selectedRegion={null} onSelectRegion={() => undefined} onShowObjects={() => undefined} {...props} />
);

describe("region graph validation", () => {
  it("accepts a valid graph and rejects malformed ones", () => {
    expect(parseRegionGraph(graph()).regions).toHaveLength(2);
    expect(() => parseRegionGraph({ schema: "x" })).toThrow(RegionGraphRejected);
    expect(() => parseRegionGraph(graph({ edges: [{ from: 0, to: 9, count: 1 }] }))).toThrow(/unknown region/);
    expect(() => parseRegionGraph(graph({ regions: [graph().regions[0]!, graph().regions[0]!] }))).toThrow(/malformed region/);
  });

  it("refuses more than 1,000 regions", () => {
    const regions = Array.from({ length: 1_001 }, (_, id) => ({ ...graph().regions[0]!, id }));
    try {
      parseRegionGraph(graph({ regions, edges: [] }));
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as RegionGraphRejected).kind).toBe("too-large");
    }
    expect(parseRegionGraph(graph({ regions: regions.slice(0, 1_000), edges: [] })).regions).toHaveLength(1_000);
  });
});

describe("RegionPanel", () => {
  it("fetches the graph for the selected snapshot's collection and shows the verified badge", async () => {
    const fetchMock = stubRegions(graph());
    render(panel(run()));
    expect(await screen.findByText("Region graph after GC #1 (sweep complete)")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run1/regions?gc=1", undefined);
    expect(screen.getByText(/counters verified/)).toBeTruthy();
    expect(screen.getByText(/not lifetime regions/)).toBeTruthy();
    expect((await screen.findByTestId("edge-count")).textContent).toBe("1");  // the canvas is a lazy chunk
  });

  it("uses the program-end graph for the program-end snapshot", async () => {
    const fetchMock = stubRegions(graph({ point: "program_end", gcIndex: null }));
    render(panel(run(), 1));
    expect(await screen.findByText("Region graph at program end")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run1/regions?gc=end", undefined);
  });

  it("describes a selected region and offers to filter the heap graph", async () => {
    stubRegions(graph());
    const onSelectRegion = vi.fn();
    const onShowObjects = vi.fn();
    const { rerender } = render(panel(run(), 0, { onSelectRegion, onShowObjects }));
    fireEvent.click(await screen.findByText("region-0"));  // lazy canvas
    expect(onSelectRegion).toHaveBeenCalledWith(0);
    rerender(panel(run(), 0, { selectedRegion: 0, onSelectRegion, onShowObjects }));
    expect(screen.getByText(/slots 0–15/)).toBeTruthy();
    fireEvent.click(screen.getByText("Show its objects in the heap graph"));
    expect(onShowObjects).toHaveBeenCalled();
  });

  it("warns when counters failed verification", async () => {
    stubRegions(graph({ verified: false }));
    render(panel(run()));
    expect((await screen.findByRole("status")).textContent).toContain("failed verification");
  });

  it("explains off, HotSpot, running and error states", async () => {
    render(panel(run({ engineResult: { kind: "custom", snapshots: [], regionGraphs: [] } })));
    expect(screen.getByText(/Regions were off for this run/)).toBeTruthy();
    cleanup();
    render(panel(run({ engine: "jvm" })));
    expect(screen.getByRole("note").textContent).toContain("HotSpot");
    cleanup();
    render(panel(run({ status: "running" })));
    expect(screen.getByText(/appear when the run finishes/)).toBeTruthy();
    cleanup();
    stubRegions({ schema: "bogus" });
    render(panel(run()));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be displayed");
  });
});

describe("heap graph region filter", () => {
  it("keeps only objects of the chosen region and hides edges that leave it", () => {
    const snapshot: HeapSnapshot = {
      schema: "gcd.heap-snapshot/1",
      runId: "run1",
      index: 0,
      point: "mark_complete",
      gcIndex: 1,
      statementIndex: 1,
      totalObjects: 3,
      totalEdges: 2,
      truncated: false,
      roots: [{ name: "r", target: "0" }],
      objects: [
        { id: "0", slot: 0, generation: 0, region: 0, allocSeq: 1, allocStatement: 0, marked: true, fields: [{ name: "far", target: "20" }, { name: "near", target: "1" }] },
        { id: "1", slot: 1, generation: 0, region: 0, allocSeq: 2, allocStatement: 1, marked: true, fields: [] },
        { id: "20", slot: 20, generation: 0, region: 1, allocSeq: 3, allocStatement: 2, marked: true, fields: [] }
      ]
    };
    const filtered = buildGraph(snapshot, 0);
    expect(filtered.nodes.map((node) => node.id).sort()).toEqual(["0", "1", "root:r"]);
    expect(filtered.edges.filter((edge) => !edge.isRootEdge).map((edge) => edge.label)).toEqual(["near"]);
    expect(buildGraph(snapshot, 1).rootEntries).toEqual([]);
    expect(buildGraph(snapshot).nodes).toHaveLength(4);
  });
});

describe("run options", () => {
  it("shows region and slot-reuse controls only for the custom engine and reports changes", () => {
    const onOptions = vi.fn();
    const props = {
      samples: [],
      sampleName: "",
      status: "idle" as const,
      runId: null,
      customOptions: { regionSize: 0 as const, slotReuse: false },
      onOptions,
      onEngine: () => undefined,
      onSample: () => undefined,
      onRun: () => undefined,
      onStop: () => undefined,
      onReset: () => undefined
    };
    const { rerender } = render(<TopBar engine="jvm" {...props} />);
    expect(screen.queryByLabelText("Regions")).toBeNull();
    rerender(<TopBar engine="custom" {...props} />);
    fireEvent.change(screen.getByLabelText("Regions"), { target: { value: "64" } });
    expect(onOptions).toHaveBeenCalledWith({ regionSize: 64 });
    fireEvent.click(screen.getByLabelText("Slot reuse"));
    expect(onOptions).toHaveBeenCalledWith({ slotReuse: true });
  });

  it("stores options and sends them in the run request only for the custom engine", async () => {
    const state = reducer(initialState, { type: "options", options: { regionSize: 32, slotReuse: true } });
    expect(state.customOptions).toEqual({ regionSize: 32, slotReuse: true });
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ runId: "r" }), { status: 202 })));
    vi.stubGlobal("fetch", fetchMock);
    await api.startRun("custom", "x", state.customOptions);
    await api.startRun("custom", "x");
    await api.startRun("jvm", "x", state.customOptions);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(((call as unknown as [string, RequestInit])[1].body) as string));
    expect(bodies[0].options.custom).toMatchObject({ traceLevel: "mutator", snapshots: true, regionSize: 32, slotReuse: true });
    expect(bodies[1].options.custom.regionSize).toBeUndefined();
    expect(bodies[1].options.custom.slotReuse).toBeUndefined();
    expect(bodies[2].options).toBeUndefined();
  });
});

describe("App wiring", () => {
  it("has a Regions tab that explains it needs a region size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ jvm: [], custom: [] }), { status: 200 })))
    );
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Regions" }));
    await waitFor(() => expect(screen.getByText(/Run a program on the custom runtime to see its regions/)).toBeTruthy());
  });
});
