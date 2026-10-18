import type { RunResult } from "@gcd/shared";
import { useMemo } from "react";
import { buildTimeline } from "../lib/timeline";
import type { TraceState } from "../useTrace";
import { snapshotEntries } from "./HeapGraphPanel";
import { TraceBanner } from "./TraceBanner";

const W = 640;
const H = 220;
const PAD = { left: 40, right: 30, top: 12, bottom: 34 };

export function TimelinePanel({
  run,
  trace,
  onSelectGc
}: {
  run: RunResult | null;
  trace: TraceState;
  onSelectGc: (snapshotIndex: number) => void;
}) {
  const collections = useMemo(
    () => (((run?.engineResult as { collections?: unknown } | undefined)?.collections as Array<Record<string, unknown>> | undefined) ?? []),
    [run]
  );
  const timeline = useMemo(() => buildTimeline(trace.batches, collections), [trace.batches, collections]);
  if (!run) return <p className="muted">Run a program on the custom runtime to see its timeline.</p>;
  if (run.engine === "jvm") return <p className="muted" role="note">Timeline is only available for the custom runtime: HotSpot object events are not exposed.</p>;
  if (run.status === "running" || run.status === "queued") return <p className="muted">The timeline appears when the run finishes.</p>;
  if (!run.trace?.available) return <p className="muted">This run was not traced.</p>;
  if (trace.status === "loading") return <p className="muted">Loading trace…</p>;
  if (trace.status === "error") {
    return (
      <div className="error-card" role="alert">
        <strong>The trace could not be loaded.</strong> {trace.error}
      </div>
    );
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const span = Math.max(timeline.maxStatement, 1);
  const x = (statement: number) => PAD.left + (statement / span) * innerW;
  const barW = Math.max(3, Math.min(24, innerW / (span + 1) - 2));
  const yCount = (count: number) => (count / timeline.maxPerStatement) * innerH;
  const yLive = (live: number) => PAD.top + innerH - (live / timeline.maxLive) * innerH;
  const snapshots = snapshotEntries(run);
  const livePoints = timeline.gcs
    .flatMap((gc) => [
      gc.liveBefore === null ? null : `${x(gc.statement)},${yLive(gc.liveBefore)}`,
      gc.liveAfter === null ? null : `${x(gc.statement)},${yLive(gc.liveAfter)}`
    ])
    .filter((point): point is string => point !== null)
    .join(" ");

  return (
    <div className="timeline">
      <TraceBanner run={run} partial={trace.partial} />
      <p className="legend">
        Bars: mutator events per statement (<span className="swatch live" /> allocations, <span className="swatch estimated" /> root changes and field writes). Line: live objects before → after each GC. Dashed verticals: collections (click to open its snapshot).
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Statement timeline" className="timeline-svg">
        <line x1={PAD.left} y1={PAD.top + innerH} x2={W - PAD.right} y2={PAD.top + innerH} className="axis" />
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + innerH} className="axis" />
        <text x={W / 2} y={H - 6} textAnchor="middle" className="axis-label">statement index</text>
        <text x={6} y={PAD.top + 8} className="axis-label">live</text>
        {timeline.buckets.map((bucket) => {
          const allocH = yCount(bucket.allocations);
          const otherH = yCount(bucket.rootChanges + bucket.fieldWrites);
          return (
            <g key={bucket.statement} data-testid="bucket">
              <title>{`statement ${bucket.statement}: ${bucket.allocations} allocations, ${bucket.rootChanges} root changes, ${bucket.fieldWrites} field writes`}</title>
              <rect x={x(bucket.statement) - barW / 2} y={PAD.top + innerH - allocH} width={barW} height={allocH} className="bar-alloc" />
              <rect x={x(bucket.statement) - barW / 2} y={PAD.top + innerH - allocH - otherH} width={barW} height={otherH} className="bar-other" />
            </g>
          );
        })}
        {livePoints ? <polyline points={livePoints} className="live-line" fill="none" /> : null}
        {timeline.gcs.map((gc) => {
          const snapshot = snapshots.find((item) => item.gcIndex === gc.gcIndex);
          return (
            <g
              key={gc.gcIndex}
              className={`gc-marker${snapshot ? " clickable" : ""}`}
              role="button"
              aria-label={`GC ${gc.gcIndex}`}
              tabIndex={snapshot ? 0 : -1}
              onClick={() => snapshot && onSelectGc(snapshot.index)}
              onKeyDown={(event) => event.key === "Enter" && snapshot && onSelectGc(snapshot.index)}
            >
              <title>{`GC #${gc.gcIndex} at statement ${gc.statement}: live ${gc.liveBefore ?? "?"} → ${gc.liveAfter ?? "?"}, freed ${gc.freed ?? "?"}`}</title>
              <line x1={x(gc.statement)} x2={x(gc.statement)} y1={PAD.top} y2={PAD.top + innerH} />
              <rect x={x(gc.statement) - 7} y={PAD.top} width={14} height={innerH} fill="transparent" />
              <text x={x(gc.statement)} y={PAD.top + 10} textAnchor="middle">GC{gc.gcIndex}</text>
            </g>
          );
        })}
        {[0, span].map((tick) => (
          <text key={tick} x={x(tick)} y={PAD.top + innerH + 14} textAnchor="middle" className="axis-label">{tick}</text>
        ))}
      </svg>
    </div>
  );
}
