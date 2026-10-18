import {
  checkRegionGraph,
  checkRun,
  checkSnapshot,
  scenarioGenerated,
  type Check,
  type LabVariant,
  type RunResult,
  type Scenario
} from "@gcd/shared";
import { api } from "../api";

export interface LabOutcome {
  scenario: Scenario;
  variant: LabVariant;
  checks: Check[];
  objects: number;
  runId: string | null;
  error: string | null;
}

async function waitForTerminal(runId: string, signal: { cancelled: boolean }): Promise<RunResult> {
  for (;;) {
    const run = await api.getRun(runId);
    if (run.status !== "running" && run.status !== "queued") return run;
    if (signal.cancelled) throw new Error("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/** Runs one scenario under one heap variant and checks it against the builder's prediction. */
export async function runLabCase(
  scenario: Scenario,
  variant: LabVariant,
  signal: { cancelled: boolean }
): Promise<LabOutcome> {
  const generated = scenarioGenerated(scenario);
  const base = { scenario, variant, objects: generated.stats.objects };
  if (!generated.stats.fits) {
    return { ...base, runId: null, error: null, checks: [{ name: "fits in the 64 KiB source limit", ok: false, detail: `${generated.stats.bytes} bytes` }] };
  }
  try {
    const { runId } = await api.startRun("custom", generated.source, {
      regionSize: variant.regionSize,
      slotReuse: variant.slotReuse
    });
    const run = await waitForTerminal(runId, signal);
    const checks = checkRun(generated, run);
    if (run.status === "succeeded") {
      const snapshots = (run.engineResult as { snapshots?: Array<{ index: number; point: string }> } | undefined)?.snapshots ?? [];
      const end = snapshots.find((item) => item.point === "program_end");
      if (end) checks.push(...checkSnapshot(generated, await api.snapshot(runId, end.index)));
      if (variant.regionSize !== 0) checks.push(...checkRegionGraph(generated, await api.regions(runId, "end")));
    }
    return { ...base, runId, error: null, checks };
  } catch (error) {
    return { ...base, runId: null, error: error instanceof Error ? error.message : String(error), checks: [] };
  }
}

export const outcomePassed = (outcome: LabOutcome): boolean =>
  outcome.error === null && outcome.checks.length > 0 && outcome.checks.every((item) => item.ok);
