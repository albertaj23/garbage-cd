import type { HeapSnapshot, RunResult, SnapshotIndexEntry } from "@gcd/shared";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { buildGraph, whyAlive, type WhyAlive } from "../lib/graph";
import { parseSnapshot, SnapshotRejected } from "../lib/snapshot";
import { TraceBanner } from "./TraceBanner";

// Cytoscape is large; load it only when a heap graph is first drawn.
const GraphCanvas = lazy(() => import("./GraphCanvas").then((module) => ({ default: module.GraphCanvas })));

type Load =
  | { status: "loading" }
  | { status: "ready"; snapshot: HeapSnapshot }
  | { status: "error"; message: string; tooLarge: boolean };

export const HOTSPOT_NOTICE = "Not available for HotSpot: object graph is not exposed through supported APIs";

export function snapshotEntries(run: RunResult | null): SnapshotIndexEntry[] {
  const raw = (run?.engineResult as { snapshots?: unknown } | undefined)?.snapshots;
  return Array.isArray(raw) ? (raw as SnapshotIndexEntry[]) : [];
}

export function HeapGraphPanel({
  run,
  selectedIndex,
  onSelectIndex,
  tracePartial,
  regionFilter = null,
  onClearRegionFilter
}: {
  run: RunResult | null;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  tracePartial: boolean;
  regionFilter?: number | null;
  onClearRegionFilter?: () => void;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const cache = useRef(new Map<string, Load>());
  const entries = snapshotEntries(run);
  const runId = run?.runId ?? null;
  const finished = !!run && run.status !== "running" && run.status !== "queued";
  const entry = entries.find((item) => item.index === selectedIndex) ?? entries[0];
  const wanted = entry?.index;

  useEffect(() => {
    setSelectedNode(null);
    if (!runId || !finished || wanted === undefined) return;
    const key = `${runId}:${wanted}`;
    const hit = cache.current.get(key);
    if (hit) {
      setLoad(hit);
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    api
      .snapshot(runId, wanted)
      .then((raw) => ({ status: "ready", snapshot: parseSnapshot(raw) }) as Load)
      .catch(
        (error: unknown): Load => ({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          tooLarge: error instanceof SnapshotRejected && error.kind === "too-large"
        })
      )
      .then((result) => {
        cache.current.set(key, result);
        if (!cancelled) setLoad(result);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, finished, wanted]);

  const graph = useMemo(() => (load.status === "ready" ? buildGraph(load.snapshot, regionFilter) : null), [load, regionFilter]);
  const why = useMemo<WhyAlive | null>(
    () => (load.status === "ready" && selectedNode && !selectedNode.startsWith("root:") ? whyAlive(load.snapshot, selectedNode) : null),
    [load, selectedNode]
  );

  if (!run) return <p className="muted">Run a program on the custom runtime to see its heap.</p>;
  if (run.engine === "jvm") return <p className="muted" role="note">{HOTSPOT_NOTICE}</p>;
  if (!finished) return <p className="muted">Heap snapshots appear when the run finishes.</p>;
  if (entries.length === 0) return <p className="muted">This run produced no heap snapshots.</p>;

  const position = entries.findIndex((item) => item.index === entry?.index);
  const title = entry
    ? entry.point === "mark_complete"
      ? `Custom runtime heap at GC #${entry.gcIndex} (mark complete)`
      : "Custom runtime heap at program end"
    : "";

  return (
    <div className="heap">
      <TraceBanner run={run} partial={tracePartial} />
      <div className="heap-head">
        <strong>{title}</strong>
        <label className="slider">
          Snapshot{" "}
          <input
            type="range"
            aria-label="Snapshot"
            min={0}
            max={entries.length - 1}
            value={Math.max(position, 0)}
            onChange={(event) => onSelectIndex(entries[Number(event.target.value)]!.index)}
          />{" "}
          {position + 1} / {entries.length}
        </label>
      </div>
      <p className="legend">
        <span className="swatch survived" /> survived (marked) <span className="swatch freed" /> will be freed (unmarked){" "}
        <span className="swatch live" /> live at program end <span className="swatch root" /> root · layout is reconstructed, not memory addresses
      </p>
      {load.status === "loading" ? <p className="muted">Loading snapshot…</p> : null}
      {load.status === "error" ? (
        <div className="error-card" role="alert">
          <strong>{load.tooLarge ? "Snapshot too large to draw." : "Snapshot could not be displayed."}</strong>
          <p>{load.message}</p>
          {load.tooLarge ? <p className="muted">Use the Regions tab (start the run with a region size) to inspect heaps this large, then filter the graph to one region.</p> : null}
        </div>
      ) : null}
      {load.status === "ready" && graph ? (
        <>
          {load.snapshot.truncated ? (
            <p className="banner" role="alert">
              Truncated: showing {load.snapshot.objects.length} of {load.snapshot.totalObjects} objects (all roots plus a breadth-first slice).
            </p>
          ) : null}
          {load.snapshot.objects.length === 0 ? <p className="muted">The heap is empty at this point.</p> : null}
          {regionFilter !== null ? (
            <p className="banner" role="status">
              Showing only objects in region {regionFilter} ({graph.nodes.filter((node) => node.state !== "root").length} of {load.snapshot.objects.length}); edges leaving the region are hidden.{" "}
              <button className="link" onClick={onClearRegionFilter}>
                Show all
              </button>
            </p>
          ) : null}
          <Suspense fallback={<p className="muted">Loading graph renderer…</p>}>
            <GraphCanvas
              graph={graph}
              highlight={why?.kind === "path" ? { nodeIds: why.nodeIds, edgeIds: why.edgeIds } : null}
              selectedId={selectedNode}
              onSelect={setSelectedNode}
            />
          </Suspense>
          <div className="why" aria-live="polite">
            {why ? (
              <>
                <strong>Why alive?</strong> {why.description}
              </>
            ) : (
              <span className="muted">Click an object to see why it is alive.</span>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
