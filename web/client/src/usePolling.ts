import type { RunResult } from "@gcd/shared";
import { useEffect } from "react";
import { api } from "./api";

/** Polls GET /api/runs/:id every `intervalMs` until the run reaches a terminal status. */
export function useRunPolling(
  runId: string | null,
  onProgress: (run: RunResult) => void,
  onError: (message: string) => void,
  intervalMs = 250
): void {
  useEffect(() => {
    if (!runId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const run = await api.getRun(runId);
        if (stopped) return;
        onProgress(run);
        if (run.status === "running" || run.status === "queued") {
          timer = setTimeout(tick, intervalMs);
        }
      } catch (error) {
        if (!stopped) onError(error instanceof Error ? error.message : String(error));
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, intervalMs]);
}
