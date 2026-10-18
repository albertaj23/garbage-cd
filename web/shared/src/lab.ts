/**
 * Test-lab definitions shared by the dashboard, the controller's integration tests and the CLI
 * (web/scripts/lab.mjs): preset and fuzzed scenarios, the heap variants each one runs under, and the
 * checks that compare a real run with the outcome the builder predicted.
 */
import { BUILDER_LIMITS, generate, normalizeSpec, type BuilderSpec, type Generated } from "./builder.js";
import type { HeapSnapshot, RegionGraph, RunResult } from "./index.js";

export interface Scenario {
  id: string;
  title: string;
  spec: Partial<BuilderSpec>;
}

export interface LabVariant {
  id: string;
  title: string;
  regionSize: 0 | 16 | 32 | 64 | 128 | 256;
  slotReuse: boolean;
}

export const LAB_VARIANTS: LabVariant[] = [
  { id: "plain", title: "no regions, no reuse", regionSize: 0, slotReuse: false },
  { id: "regions-16", title: "regions of 16", regionSize: 16, slotReuse: false },
  { id: "reuse", title: "slot reuse", regionSize: 0, slotReuse: true },
  { id: "regions-64-reuse", title: "regions of 64 + slot reuse", regionSize: 64, slotReuse: true }
];

export const PRESET_SCENARIOS: Scenario[] = [
  { id: "single-chain", title: "One chain of 100, dropped", spec: { objects: 100, cycleShare: 0, chainLength: [100, 100], extraLinks: [0, 0], keepRoots: 0, rounds: 1, collectFirst: true } },
  { id: "single-cycle", title: "One cycle of 100, dropped", spec: { objects: 100, cycleShare: 100, cycleLength: [100, 100], extraLinks: [0, 0], keepRoots: 0, rounds: 1, collectFirst: true } },
  { id: "all-rooted", title: "Everything stays rooted (nothing is freed)", spec: { objects: 80, keepRoots: 100, rounds: 1 } },
  { id: "all-garbage", title: "Everything dropped (nothing survives)", spec: { objects: 80, keepRoots: 0, extraLinks: [0, 0], rounds: 1 } },
  { id: "mixed-50", title: "50 % cycles, 50 % chains, 300 objects", spec: { objects: 300, cycleShare: 50, chainLength: [2, 12], cycleLength: [2, 8], extraLinks: [0, 0], keepRoots: 40, rounds: 3 } },
  { id: "cross-links", title: "Dense random cross-links keep garbage alive", spec: { objects: 200, cycleShare: 40, extraLinks: [1, 3], locality: 0, keepRoots: 20, rounds: 3 } },
  { id: "local-links", title: "Extra links within a window of 5 (locality)", spec: { objects: 250, cycleShare: 50, chainLength: [4, 10], extraLinks: [1, 2], locality: 5, keepRoots: 25, rounds: 4 } },
  { id: "many-singletons", title: "Many tiny groups", spec: { objects: 400, cycleShare: 30, chainLength: [1, 2], cycleLength: [2, 3], extraLinks: [0, 1], keepRoots: 50, rounds: 5 } },
  { id: "long-rounds", title: "Progressive death over 8 rounds", spec: { objects: 500, cycleShare: 50, chainLength: [5, 20], cycleLength: [3, 10], extraLinks: [0, 0], keepRoots: 0, rounds: 8, collectFirst: false } },
  { id: "large", title: "Large heap (900 objects, spans many regions)", spec: { objects: 900, cycleShare: 50, chainLength: [10, 40], cycleLength: [5, 20], extraLinks: [0, 1], locality: 30, keepRoots: 30, rounds: 3 } }
];

/** Seeded random scenarios over the whole spec space (the fuzz part of the lab). */
export function fuzzScenarios(count: number, seed: number): Scenario[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  const scenarios: Scenario[] = [];
  for (let i = 0; i < count; i++) {
    const chainA = between(1, 12);
    const cycleA = between(2, 8);
    const extraA = between(0, 2);
    const spec: Partial<BuilderSpec> = {
      seed: between(0, 1_000_000),
      objects: between(1, 600),
      cycleShare: between(0, 100),
      chainLength: [chainA, chainA + between(0, 20)],
      cycleLength: [cycleA, cycleA + between(0, 10)],
      extraLinks: [extraA, extraA + between(0, 2)],
      locality: next() < 0.5 ? 0 : between(1, 40),
      keepRoots: between(0, 100),
      rounds: between(1, BUILDER_LIMITS.maxRounds),
      collectFirst: next() < 0.5
    };
    scenarios.push({ id: `fuzz-${seed}-${i}`, title: `Fuzz ${i + 1} (seed ${spec.seed}, ${spec.objects} objects)`, spec });
  }
  return scenarios;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

type Row = Record<string, unknown>;
const metric = (value: unknown): number | null => {
  if (typeof value === "object" && value !== null && "value" in value) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === "number" ? inner : null;
  }
  return null;
};
const check = (name: string, actual: unknown, expected: unknown): Check => ({
  name,
  ok: actual === expected,
  detail: actual === expected ? String(expected) : `expected ${String(expected)}, got ${String(actual)}`
});

/** Compares a finished run of `generated.source` with the outcome the builder predicted. */
export function checkRun(generated: Generated, run: RunResult): Check[] {
  const checks: Check[] = [check("run status", run.status, "succeeded")];
  if (run.status !== "succeeded") {
    checks.push({ name: "errors", ok: false, detail: run.errors.map((error) => `${error.code}: ${error.message}`).join("; ") || "none reported" });
    return checks;
  }
  const engine = run.engineResult as { totals?: Row; collections?: Row[] } | undefined;
  const collections = engine?.collections ?? [];
  checks.push(check("allocations", metric(engine?.totals?.allocations), generated.expected.allocations));
  checks.push(check("collections", collections.length, generated.expected.collections.length));
  generated.expected.collections.forEach((expected, index) => {
    const actual = collections[index];
    if (!actual) return;
    checks.push(check(`gc ${index + 1} (${expected.label}) freed`, metric(actual.freed), expected.freed));
    checks.push(check(`gc ${index + 1} live after`, metric(actual.liveAfter), expected.liveAfter));
    const before = metric(actual.liveBefore);
    checks.push(check(`gc ${index + 1} live before = freed + live after`, before, expected.freed + expected.liveAfter));
  });
  checks.push(check("total freed", metric(engine?.totals?.freed), generated.expected.freedTotal));
  checks.push(check("final live objects", metric(engine?.totals?.liveAfter), generated.expected.liveFinal));
  return checks;
}

/** Region counters at program end must account for every object and every live reference field. */
export function checkRegionGraph(generated: Generated, graph: RegionGraph): Check[] {
  const live = graph.regions.reduce((total, region) => total + region.liveObjects, 0);
  const allocated = graph.regions.reduce((total, region) => total + region.allocatedTotal, 0);
  const intra = graph.regions.reduce((total, region) => total + region.intraEdges, 0);
  const cross = graph.edges.reduce((total, edge) => total + edge.count, 0);
  return [
    { name: "region counters verified by recomputation", ok: graph.verified, detail: String(graph.verified) },
    check("region live objects", live, generated.expected.liveFinal),
    check("region allocated total", allocated, generated.expected.allocations),
    check("region edges (intra + cross)", intra + cross, generated.expected.liveEdges)
  ];
}

/** The program-end snapshot must contain exactly the surviving objects (when it is not truncated). */
export function checkSnapshot(generated: Generated, snapshot: HeapSnapshot): Check[] {
  const checks: Check[] = [check("snapshot total objects", snapshot.totalObjects, generated.expected.liveFinal)];
  if (!snapshot.truncated) {
    checks.push(check("snapshot object list", snapshot.objects.length, generated.expected.liveFinal));
    const edges = snapshot.objects.reduce((total, object) => total + object.fields.filter((field) => field.target !== null).length, 0);
    checks.push(check("snapshot reference fields", edges, generated.expected.liveEdges));
  }
  return checks;
}

export function scenarioGenerated(scenario: Scenario): Generated {
  return generate(normalizeSpec(scenario.spec));
}
