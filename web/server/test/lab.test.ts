import { checkRegionGraph, checkRun, checkSnapshot, fuzzScenarios, LAB_VARIANTS, PRESET_SCENARIOS, scenarioGenerated, type Check, type Scenario } from "@gcd/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { headers, runRequest, runToEnd, start } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  ({ app } = await start());
}, 30_000);
afterAll(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: "GET", url, headers });

/** Runs one scenario under one variant and returns every check, failing ones included. */
async function runScenario(scenario: Scenario, variant: (typeof LAB_VARIANTS)[number]): Promise<Check[]> {
  const generated = scenarioGenerated(scenario);
  if (!generated.stats.fits) return [{ name: "fits in 64 KiB", ok: false, detail: `${generated.stats.bytes} bytes` }];
  const result = await runToEnd(
    app,
    runRequest("custom", generated.source, {
      custom: {
        traceLevel: "mutator",
        snapshots: true,
        ...(variant.regionSize ? { regionSize: variant.regionSize } : {}),
        ...(variant.slotReuse ? { slotReuse: true } : {})
      }
    })
  );
  const checks = checkRun(generated, result);
  if (result.status !== "succeeded") return checks;
  const snapshots = result.engineResult.snapshots as Array<{ index: number; point: string }>;
  const end = snapshots.find((item) => item.point === "program_end");
  if (end) checks.push(...checkSnapshot(generated, (await get(`/api/runs/${result.runId}/snapshots/${end.index}`)).json()));
  if (variant.regionSize) {
    checks.push(...checkRegionGraph(generated, (await get(`/api/runs/${result.runId}/regions?gc=end`)).json()));
  }
  return checks;
}

const failures = (checks: Check[]) => checks.filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`);

describe("test lab: builder-predicted outcomes match the real collector", () => {
  for (const scenario of PRESET_SCENARIOS) {
    it(`${scenario.id} under every heap variant`, async () => {
      for (const variant of LAB_VARIANTS) {
        expect(failures(await runScenario(scenario, variant)), `${scenario.id} / ${variant.id}`).toEqual([]);
      }
    }, 120_000);
  }

  it("agrees on 25 fuzzed scenarios across all variants (I9 end to end)", async () => {
    const scenarios = fuzzScenarios(25, 2026);
    for (const scenario of scenarios) {
      for (const variant of LAB_VARIANTS) {
        expect(failures(await runScenario(scenario, variant)), `${scenario.id} / ${variant.id}`).toEqual([]);
      }
    }
  }, 600_000);

  it("is a real test: a wrong expectation is detected", async () => {
    const generated = scenarioGenerated(PRESET_SCENARIOS[2]!);
    const result = await runToEnd(app, runRequest("custom", generated.source));
    const tampered = structuredClone(generated);
    tampered.expected.collections[0]!.freed += 1;
    tampered.expected.liveFinal += 1;
    const bad = checkRun(tampered, result).filter((item) => !item.ok);
    expect(bad.length).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
