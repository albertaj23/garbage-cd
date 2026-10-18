import type { RegionGraph, RunResult } from "@gcd/shared";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { parseRegionGraph, RegionGraphRejected } from "../lib/regions";
import { HOTSPOT_NOTICE, snapshotEntries } from "./HeapGraphPanel";

const RegionCanvas = lazy(() => import("./RegionCanvas").then((module) => ({ default: module.RegionCanvas })));

type Load =
  | { status: "loading" }
  | { status: "ready"; graph: RegionGraph }
  | { status: "error"; message: string };

export function regionGraphCount(run: RunResult | null): number {
  const listed = (run?.engineResult as { regionGraphs?: unknown } | undefined)?.regionGraphs;
  return Array.isArray(listed) ? listed.length : 0;
}

export function RegionPanel({
  run,
  snapshotIndex,
  selectedRegion,
  onSelectRegion,
  onShowObjects
}: {
  run: RunResult | null;
  snapshotIndex: number;
  selectedRegion: number | null;
  onSelectRegion: (id: number | null) => void;
  onShowObjects: () => void;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const cache = useRef(new Map<string, Load>());
  const finished = !!run && run.status !== "running" && run.status !== "queued";
  const runId = run?.runId ?? null;
  // The region graph that matches the selected heap snapshot: its collection, or program end.
  const entry = snapshotEntries(run).find((item) => item.index === snapshotIndex);
  const which: number | "end" = entry && entry.gcIndex !== null ? entry.gcIndex : "end";
  const enabled = regionGraphCount(run) > 0;

  useEffect(() => {
    if (!runId || !finished || !enabled) return;
    const key = `${runId}:${which}`;
    const hit = cache.current.get(key);
    if (hit) {
      setLoad(hit);
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    api
      .regions(runId, which)
      .then((raw): Load => ({ status: "ready", graph: parseRegionGraph(raw) }))
      .catch((error: unknown): Load => ({
        status: "error",
        message:
          error instanceof RegionGraphRejected || error instanceof Error ? error.message : String(error)
      }))
      .then((result) => {
        cache.current.set(key, result);
        if (!cancelled) setLoad(result);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, finished, enabled, which]);

  if (!run) return <p className="muted">Run a program on the custom runtime to see its regions.</p>;
  if (run.engine === "jvm") return <p className="muted" role="note">{HOTSPOT_NOTICE}</p>;
  if (!finished) return <p className="muted">Region graphs appear when the run finishes.</p>;
  if (!enabled) {
    return <p className="muted">Regions were off for this run. Choose a region size in the toolbar and run again.</p>;
  }
  if (load.status === "loading") return <p className="muted">Loading region graph…</p>;
  if (load.status === "error") {
    return (
      <div className="error-card" role="alert">
        <strong>The region graph could not be displayed.</strong>
        <p>{load.message}</p>
      </div>
    );
  }
  const { graph } = load;
  const chosen = graph.regions.find((region) => region.id === selectedRegion);
  return (
    <div className="heap">
      <div className="heap-head">
        <strong>
          {graph.point === "gc_end"
            ? `Region graph after GC #${graph.gcIndex} (sweep complete)`
            : "Region graph at program end"}
        </strong>
        <span className={graph.verified ? "muted" : "banner inline"} role="status">
          {graph.verified ? "✓ counters verified against a full recomputation" : "Counters failed verification"}
        </span>
      </div>
      <p className="legend">
        Address regions of {graph.regionSize} consecutive slots (not lifetime regions). Box size = live objects; thick border = holds a root target; edges = cross-region reference fields, labelled with counts. Observational only: regions never change what is freed.
      </p>
      <Suspense fallback={<p className="muted">Loading graph renderer…</p>}>
        <RegionCanvas graph={graph} selected={selectedRegion} onSelect={onSelectRegion} />
      </Suspense>
      <div className="why" aria-live="polite">
        {chosen ? (
          <>
            <strong>Region {chosen.id}</strong> (slots {chosen.slotStart}–{chosen.slotEnd}): {chosen.liveObjects} live, {chosen.allocatedTotal} allocated in total, {chosen.survivorsLastGc} survived and {chosen.freedLastGc} freed in the last GC, {chosen.intraEdges} internal edges, {chosen.rootTargets} root target{chosen.rootTargets === 1 ? "" : "s"}.{" "}
            <button className="link" onClick={onShowObjects}>
              Show its objects in the heap graph
            </button>
          </>
        ) : (
          <span className="muted">Click a region for details and to filter the heap graph to it.</span>
        )}
      </div>
    </div>
  );
}
