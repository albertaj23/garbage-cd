#!/usr/bin/env node
// Runs the test lab against a running controller (default http://127.0.0.1:4177) and exits non-zero
// if any scenario disagrees with the builder's prediction.
//
//   node web/scripts/lab.mjs [--url http://127.0.0.1:4177] [--fuzz 20] [--seed 1]
//                            [--scenarios id,id] [--variants plain,reuse] [--only-fuzz]
import {
  checkRegionGraph, checkRun, checkSnapshot, fuzzScenarios, LAB_VARIANTS, PRESET_SCENARIOS, scenarioGenerated
} from "../shared/dist/index.js";

const options = { url: "http://127.0.0.1:4177", fuzz: 10, seed: 1, scenarios: null, variants: null, onlyFuzz: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--only-fuzz") { options.onlyFuzz = true; continue; }
  const value = args[++i];
  if (flag === "--url") options.url = value;
  else if (flag === "--fuzz") options.fuzz = Number(value);
  else if (flag === "--seed") options.seed = Number(value);
  else if (flag === "--scenarios") options.scenarios = new Set(value.split(","));
  else if (flag === "--variants") options.variants = new Set(value.split(","));
  else { console.error(`unknown flag ${flag}`); process.exit(2); }
}

async function call(path, init) {
  const response = await fetch(`${options.url}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(body?.error ?? body)}`);
  return body;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCase(scenario, variant) {
  const generated = scenarioGenerated(scenario);
  if (!generated.stats.fits) return [{ name: "fits in 64 KiB", ok: false, detail: `${generated.stats.bytes} bytes` }];
  const custom = { traceLevel: "mutator", snapshots: true, ...(variant.regionSize ? { regionSize: variant.regionSize } : {}), ...(variant.slotReuse ? { slotReuse: true } : {}) };
  const { runId } = await call("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ schema: "gcd.run-request/1", engine: "custom", source: generated.source, options: { custom } })
  });
  let run;
  do { await sleep(100); run = await call(`/api/runs/${runId}`); } while (run.status === "running" || run.status === "queued");
  const checks = checkRun(generated, run);
  if (run.status === "succeeded") {
    const end = (run.engineResult.snapshots ?? []).find((item) => item.point === "program_end");
    if (end) checks.push(...checkSnapshot(generated, await call(`/api/runs/${runId}/snapshots/${end.index}`)));
    if (variant.regionSize) checks.push(...checkRegionGraph(generated, await call(`/api/runs/${runId}/regions?gc=end`)));
  }
  return checks;
}

const scenarios = [
  ...(options.onlyFuzz ? [] : PRESET_SCENARIOS.filter((item) => !options.scenarios || options.scenarios.has(item.id))),
  ...fuzzScenarios(options.fuzz, options.seed)
];
const variants = LAB_VARIANTS.filter((item) => !options.variants || options.variants.has(item.id));
let failures = 0;
let cases = 0;
for (const scenario of scenarios) {
  for (const variant of variants) {
    cases++;
    let checks;
    try { checks = await runCase(scenario, variant); } catch (error) { checks = [{ name: "request", ok: false, detail: String(error) }]; }
    const bad = checks.filter((item) => !item.ok);
    if (bad.length) failures++;
    console.log(`${bad.length ? "FAIL" : "ok  "} ${scenario.id} / ${variant.id} (${checks.length} checks)`);
    for (const item of bad) console.log(`      ${item.name}: ${item.detail}`);
  }
}
console.log(`\n${cases - failures}/${cases} cases passed`);
process.exit(failures ? 1 : 0);
