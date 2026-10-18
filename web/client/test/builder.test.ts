import { BUILDER_LIMITS, checkRegionGraph, checkRun, checkSnapshot, defaultSpec, fuzzScenarios, generate, LAB_VARIANTS, normalizeSpec, parseRange, PRESET_SCENARIOS, scenarioGenerated, toCliArgs, type BuilderSpec, type RegionGraph, type RunResult } from "@gcd/shared";
import { describe, expect, it } from "vitest";

const lines = (source: string) => source.trim().split("\n");
const count = (source: string, pattern: RegExp) => lines(source).filter((line) => pattern.test(line)).length;

describe("spec normalisation", () => {
  it("clamps every field, orders ranges and never throws", () => {
    const spec = normalizeSpec({
      objects: 99999,
      cycleShare: -5,
      chainLength: [9, 2],
      cycleLength: [0, 1],
      extraLinks: [50, 1],
      locality: -3,
      keepRoots: 250,
      rounds: 0,
      seed: Number.NaN
    });
    expect(spec.objects).toBe(BUILDER_LIMITS.maxObjects);
    expect(spec.cycleShare).toBe(0);
    expect(spec.chainLength).toEqual([2, 9]);
    expect(spec.cycleLength).toEqual([2, 2]);
    expect(spec.extraLinks).toEqual([1, BUILDER_LIMITS.maxExtraLinks]);
    expect(spec.locality).toBe(0);
    expect(spec.keepRoots).toBe(100);
    expect(spec.rounds).toBe(1);
    expect(spec.seed).toBe(0);
    expect(normalizeSpec({ objects: 0 }).objects).toBe(1);
  });

  it("parses ranges for the UI and the CLI", () => {
    expect(parseRange("3-8")).toEqual([3, 8]);
    expect(parseRange(" 5 ")).toEqual([5, 5]);
    expect(parseRange("a-b")).toBeNull();
    expect(parseRange("")).toBeNull();
  });
});

describe("generator", () => {
  it("is deterministic and the seed changes the program", () => {
    const a = generate({ objects: 120, seed: 7 });
    expect(generate({ objects: 120, seed: 7 }).source).toBe(a.source);
    expect(generate({ objects: 120, seed: 8 }).source).not.toBe(a.source);
  });

  it("allocates exactly the requested number of objects and reports honest statistics", () => {
    for (const objects of [1, 2, 3, 17, 100, 640]) {
      const g = generate({ objects, extraLinks: [0, 2], seed: objects });
      expect(count(g.source, /^o\d+ = new Object\(\);$/)).toBe(objects);
      expect(g.stats.objects).toBe(objects);
      expect(g.stats.edges).toBe(count(g.source, /^o\d+\.\w+ = o\d+;$/));
      expect(g.stats.statements).toBe(lines(g.source).length);
      expect(g.stats.bytes).toBe(g.source.length);
      expect(g.groups.reduce((total, group) => total + group.length, 0)).toBe(objects);
      expect(g.stats.chains + g.stats.cycles).toBe(g.stats.groups);
      expect(g.expected.totalEdges).toBe(g.stats.edges);
    }
  });

  it("honours the cycle share: 0 gives only chains and 100 gives only cycles (bar a lone leftover)", () => {
    expect(generate({ objects: 200, cycleShare: 0 }).stats.cycles).toBe(0);
    const all = generate({ objects: 200, cycleShare: 100, cycleLength: [2, 6], seed: 3 });
    expect(all.groups.filter((group) => group.kind === "chain").every((group) => group.length === 1)).toBe(true);
    expect(all.stats.cycles).toBeGreaterThan(20);
    const mixed = generate({ objects: 2000, cycleShare: 50, chainLength: [2, 4], cycleLength: [2, 4], seed: 11 });
    const share = mixed.stats.cycles / mixed.stats.groups;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
  });

  it("keeps group lengths inside the requested ranges (the last group may be shorter)", () => {
    const g = generate({ objects: 500, cycleShare: 50, chainLength: [4, 9], cycleLength: [3, 7], seed: 5, extraLinks: [0, 0] });
    g.groups.slice(0, -1).forEach((group) => {
      const [lo, hi] = group.kind === "chain" ? [4, 9] : [3, 7];
      expect(group.length).toBeGreaterThanOrEqual(lo);
      expect(group.length).toBeLessThanOrEqual(hi);
    });
  });

  it("builds chains as next-links and closes cycles back onto the head", () => {
    const g = generate({ objects: 5, cycleShare: 100, cycleLength: [5, 5], extraLinks: [0, 0], seed: 1 });
    expect(lines(g.source).filter((line) => line.includes(".next ="))).toEqual([
      "o0.next = o1;", "o1.next = o2;", "o2.next = o3;", "o3.next = o4;", "o4.next = o0;"
    ]);
    const chain = generate({ objects: 4, cycleShare: 0, chainLength: [4, 4], extraLinks: [0, 0] });
    expect(count(chain.source, /\.next = /)).toBe(3);
  });

  it("gives every object a number of extra links inside the requested range, never to itself", () => {
    const g = generate({ objects: 150, cycleShare: 0, chainLength: [1, 1], extraLinks: [2, 4], seed: 9 });
    const perObject = new Map<number, number>();
    for (const line of lines(g.source)) {
      const match = /^o(\d+)\.x\d+ = o(\d+);$/.exec(line);
      if (!match) continue;
      expect(match[1]).not.toBe(match[2]);
      perObject.set(Number(match[1]), (perObject.get(Number(match[1])) ?? 0) + 1);
    }
    expect(perObject.size).toBe(150);
    for (const total of perObject.values()) {
      expect(total).toBeGreaterThanOrEqual(2);
      expect(total).toBeLessThanOrEqual(4);
    }
  });

  it("keeps extra links inside the locality window", () => {
    const g = generate({ objects: 300, cycleShare: 0, extraLinks: [1, 3], locality: 6, seed: 4 });
    let seen = 0;
    for (const line of lines(g.source)) {
      const match = /^o(\d+)\.x\d+ = o(\d+);$/.exec(line);
      if (!match) continue;
      seen++;
      expect(Math.abs(Number(match[1]) - Number(match[2]))).toBeLessThanOrEqual(6);
    }
    expect(seen).toBeGreaterThan(300);
  });

  it("emits one gc() per round, plus one when collecting first", () => {
    for (const rounds of [1, 3, 6]) {
      for (const collectFirst of [false, true]) {
        const g = generate({ objects: 200, rounds, collectFirst, keepRoots: 0, cycleShare: 50, seed: rounds });
        const expectedRounds = Math.min(rounds, g.groups.length);
        expect(count(g.source, /^gc\(\);$/)).toBe(expectedRounds + (collectFirst ? 1 : 0));
        expect(g.expected.collections).toHaveLength(expectedRounds + (collectFirst ? 1 : 0));
      }
    }
  });

  it("predicts the obvious extremes", () => {
    const rooted = generate({ objects: 50, keepRoots: 100, rounds: 3, collectFirst: false });
    expect(rooted.expected.freedTotal).toBe(0);
    expect(rooted.expected.liveFinal).toBe(50);
    const garbage = generate({ objects: 50, keepRoots: 0, extraLinks: [0, 0], rounds: 2, collectFirst: false });
    expect(garbage.expected.freedTotal).toBe(50);
    expect(garbage.expected.liveFinal).toBe(0);
    expect(garbage.expected.liveEdges).toBe(0);
    const first = generate({ objects: 50, collectFirst: true });
    expect(first.expected.collections[0]).toEqual({ label: "all objects rooted", freed: 0, liveAfter: 50 });
  });

  it("conserves objects: freed + live = allocated, and rounds only ever free", () => {
    for (const scenario of [...PRESET_SCENARIOS, ...fuzzScenarios(60, 99)]) {
      const g = scenarioGenerated(scenario);
      expect(g.expected.freedTotal + g.expected.liveFinal).toBe(g.expected.allocations);
      let alive = g.expected.allocations;
      for (const collection of g.expected.collections) {
        expect(collection.freed).toBeGreaterThanOrEqual(0);
        expect(alive - collection.freed).toBe(collection.liveAfter);
        alive = collection.liveAfter;
      }
      expect(g.expected.liveEdges).toBeLessThanOrEqual(g.expected.totalEdges);
    }
  });

  it("matches an independent reachability computation on random specs", () => {
    for (const scenario of fuzzScenarios(80, 7)) {
      const g = scenarioGenerated(scenario);
      // Replay the emitted statements on a tiny model heap, independent of the generator internals.
      const variables = new Map<string, number>();
      const fields = new Map<number, string[]>();
      const targets = new Map<string, number>();
      let next = 0;
      let alive = new Set<number>();
      const freed: number[] = [];
      const live: number[] = [];
      for (const line of lines(g.source)) {
        let m: RegExpExecArray | null;
        if ((m = /^(o\d+) = new Object\(\);$/.exec(line))) {
          variables.set(m[1]!, next); alive.add(next); fields.set(next, []); next++;
        } else if ((m = /^(o\d+)\.(\w+) = (o\d+);$/.exec(line))) {
          const source = variables.get(m[1]!)!;
          targets.set(`${source}.${m[2]}`, variables.get(m[3]!)!);
          fields.get(source)!.push(m[2]!);
        } else if ((m = /^(o\d+) = null;$/.exec(line))) {
          variables.delete(m[1]!);
        } else if (line === "gc();") {
          const seen = new Set<number>();
          const stack = [...variables.values()];
          while (stack.length) {
            const id = stack.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            for (const field of fields.get(id)!) stack.push(targets.get(`${id}.${field}`)!);
          }
          freed.push(alive.size - seen.size);
          live.push(seen.size);
          alive = seen;
        } else {
          throw new Error(`unexpected statement ${line}`);
        }
      }
      expect(freed, scenario.id).toEqual(g.expected.collections.map((item) => item.freed));
      expect(live, scenario.id).toEqual(g.expected.collections.map((item) => item.liveAfter));
    }
  });

  it("flags programs that exceed the 64 KiB source limit instead of hiding them", () => {
    expect(generate({ objects: 100 }).stats.fits).toBe(true);
    const big = generate({ objects: BUILDER_LIMITS.maxObjects, extraLinks: [2, 2] });
    expect(big.stats.fits).toBe(false);
    expect(big.stats.bytes).toBeGreaterThan(BUILDER_LIMITS.maxSourceBytes);
  });

  it("round-trips through the CLI flag form", () => {
    const spec: BuilderSpec = { ...defaultSpec(), objects: 321, seed: 42, chainLength: [2, 9], extraLinks: [1, 3], locality: 4, collectFirst: false };
    const flags = toCliArgs(spec);
    expect(flags).toContain("--objects 321");
    expect(flags).toContain("--extra-links 1-3");
    expect(flags).toContain("--collect-first no");
  });
});

describe("lab checks", () => {
  const generated = generate({ objects: 20, cycleShare: 0, chainLength: [20, 20], extraLinks: [0, 0], keepRoots: 0, rounds: 1, collectFirst: true });
  const metric = (value: number) => ({ value, unit: "objects", provenance: "measured", source: "t" });
  const run = (overrides: Partial<RunResult> = {}): RunResult =>
    ({
      status: "succeeded",
      errors: [],
      engineResult: {
        totals: { allocations: metric(20), freed: metric(20), liveAfter: metric(0) },
        collections: [
          { liveBefore: metric(20), freed: metric(0), liveAfter: metric(20) },
          { liveBefore: metric(20), freed: metric(20), liveAfter: metric(0) }
        ]
      },
      ...overrides
    }) as unknown as RunResult;

  it("passes a run that matches and fails each deviation", () => {
    expect(checkRun(generated, run()).filter((item) => !item.ok)).toEqual([]);
    const wrong = run();
    (wrong.engineResult as { collections: Array<{ freed: ReturnType<typeof metric> }> }).collections[1]!.freed = metric(19);
    expect(checkRun(generated, wrong).some((item) => !item.ok && item.name.includes("gc 2"))).toBe(true);
    const failed = checkRun(generated, run({ status: "program_error", errors: [{ code: "RUNTIME_ERROR", phase: "execute", message: "boom" }] }));
    expect(failed.map((item) => item.name)).toEqual(["run status", "errors"]);
    expect(failed[1]!.detail).toContain("boom");
  });

  it("checks region and snapshot summaries", () => {
    const survivors = generate({ objects: 12, cycleShare: 0, chainLength: [12, 12], extraLinks: [0, 0], keepRoots: 100, rounds: 1, collectFirst: false });
    const graph = { verified: true, regions: [{ liveObjects: 12, allocatedTotal: 12, intraEdges: 7 }, { liveObjects: 0, allocatedTotal: 0, intraEdges: 0 }], edges: [{ from: 0, to: 1, count: 4 }] } as unknown as RegionGraph;
    expect(checkRegionGraph(survivors, graph).filter((item) => !item.ok)).toEqual([]);
    graph.edges[0]!.count = 3;
    expect(checkRegionGraph(survivors, graph).filter((item) => !item.ok).map((item) => item.name)).toEqual(["region edges (intra + cross)"]);
    const snapshot = { totalObjects: 12, truncated: false, objects: Array.from({ length: 12 }, (_, i) => ({ fields: i < 11 ? [{ name: "next", target: String(i + 1) }] : [] })) };
    expect(checkSnapshot(survivors, snapshot as never).filter((item) => !item.ok)).toEqual([]);
  });

  it("defines a preset for the interesting shapes and four heap variants", () => {
    expect(PRESET_SCENARIOS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(PRESET_SCENARIOS.map((scenario) => scenario.id)).size).toBe(PRESET_SCENARIOS.length);
    expect(LAB_VARIANTS.map((variant) => variant.id)).toEqual(["plain", "regions-16", "reuse", "regions-64-reuse"]);
    expect(PRESET_SCENARIOS.every((scenario) => scenarioGenerated(scenario).stats.fits)).toBe(true);
    expect(fuzzScenarios(5, 1).map((s) => s.id)).toEqual(fuzzScenarios(5, 1).map((s) => s.id));
    expect(fuzzScenarios(3, 1)[0]!.spec).not.toEqual(fuzzScenarios(3, 2)[0]!.spec);
  });
});
