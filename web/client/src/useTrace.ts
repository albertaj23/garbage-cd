import type { RunResult, TraceBatch } from "@gcd/shared";
import { useEffect, useState } from "react";
import { api } from "./api";

export interface TraceState {
  status: "idle" | "loading" | "ready" | "error";
  batches: TraceBatch[];
  /** True when the client stopped paging before the end of the trace. */
  partial: boolean;
  error: string | null;
}

const PAGE_EVENTS = 10_000;
const MAX_PAGES = 10;
const idle: TraceState = { status: "idle", batches: [], partial: false, error: null };

/** Loads every trace page for a finished custom run (bounded), following `next` without gaps. */
export function useTrace(run: RunResult | null): TraceState {
  const [state, setState] = useState<TraceState>(idle);
  const runId = run?.runId ?? null;
  const ready = !!run && run.engine === "custom" && run.status !== "running" && run.status !== "queued" && run.trace?.available === true;

  useEffect(() => {
    if (!runId || !ready) {
      setState(idle);
      return;
    }
    let cancelled = false;
    setState({ ...idle, status: "loading" });
    (async () => {
      const batches: TraceBatch[] = [];
      let after = -1;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await api.trace(runId, after, PAGE_EVENTS);
        batches.push(...result.batches);
        if (result.next === null) return { batches, partial: false };
        after = result.next;
      }
      return { batches, partial: true };
    })()
      .then((loaded) => {
        if (!cancelled) setState({ status: "ready", ...loaded, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ ...idle, status: "error", error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [runId, ready]);

  return state;
}
