import type { RunResult } from "@gcd/shared";

export function TraceBanner({ run, partial }: { run: RunResult; partial?: boolean }) {
  const trace = run.trace;
  if (!trace || !trace.available) return null;
  return (
    <>
      {!trace.complete ? (
        <p className="banner" role="alert">
          Trace incomplete: {trace.droppedCount > 0 ? `${trace.droppedCount} events were dropped` : "the runner did not finish writing the trace"}
          . Timelines and replays may be missing events.
        </p>
      ) : null}
      {partial ? (
        <p className="banner" role="alert">
          Only the first part of the trace ({trace.eventCount} events in total) was loaded for display.
        </p>
      ) : null}
    </>
  );
}
