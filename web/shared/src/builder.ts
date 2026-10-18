/**
 * Workload builder for the toy language: a declarative spec (object count, chain and cycle mix,
 * extra-link ranges, rooting and collection rounds) is turned into toy source code plus the exact
 * outcome the collector must produce, computed independently by a plain reachability walk.
 *
 * The generated source is ordinary toy code. Code and builder are two ways to write the same
 * program: the generator is pure and deterministic (same spec, same text), the GUI and the CLI
 * (web/scripts/gen-toy.mjs) share it, and the expected outcome is what the test lab checks real
 * runs against.
 */

export interface BuilderSpec {
  seed: number;
  /** Number of objects to allocate. */
  objects: number;
  /** Percentage of groups that are cycles; the rest are chains. */
  cycleShare: number;
  /** Inclusive length range of chain groups (objects). */
  chainLength: [number, number];
  /** Inclusive length range of cycle groups (at least 2). */
  cycleLength: [number, number];
  /** Inclusive range of extra outgoing references per object, on top of chain and cycle links. */
  extraLinks: [number, number];
  /** 0 = extra links may target any object; otherwise the maximum index distance. */
  locality: number;
  /** Percentage of groups whose head variable stays rooted at the end. */
  keepRoots: number;
  /** Number of unroot-and-collect rounds the dropped groups are spread over. */
  rounds: number;
  /** Collect once while everything is still rooted (nothing may be freed). */
  collectFirst: boolean;
}

export const BUILDER_LIMITS = {
  maxObjects: 3_000,
  maxGroupLength: 1_000,
  maxExtraLinks: 8,
  maxLocality: 1_000,
  maxRounds: 8,
  maxSourceBytes: 65_536
} as const;

export function defaultSpec(): BuilderSpec {
  return {
    seed: 1,
    objects: 60,
    cycleShare: 50,
    chainLength: [3, 8],
    cycleLength: [2, 5],
    extraLinks: [0, 1],
    locality: 0,
    keepRoots: 30,
    rounds: 2,
    collectFirst: true
  };
}

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Number.isFinite(value) ? Math.trunc(value) : lo));

function normalizedRange(range: [number, number], lo: number, hi: number): [number, number] {
  const a = clamp(range[0], lo, hi);
  const b = clamp(range[1], lo, hi);
  return a <= b ? [a, b] : [b, a];
}

/** Clamps every field into its legal range and orders the ranges; never throws. */
export function normalizeSpec(input: Partial<BuilderSpec> = {}): BuilderSpec {
  const base = { ...defaultSpec(), ...input };
  return {
    seed: clamp(base.seed, 0, 0x7fffffff),
    objects: clamp(base.objects, 1, BUILDER_LIMITS.maxObjects),
    cycleShare: clamp(base.cycleShare, 0, 100),
    chainLength: normalizedRange(base.chainLength, 1, BUILDER_LIMITS.maxGroupLength),
    cycleLength: normalizedRange(base.cycleLength, 2, BUILDER_LIMITS.maxGroupLength),
    extraLinks: normalizedRange(base.extraLinks, 0, BUILDER_LIMITS.maxExtraLinks),
    locality: clamp(base.locality, 0, BUILDER_LIMITS.maxLocality),
    keepRoots: clamp(base.keepRoots, 0, 100),
    rounds: clamp(base.rounds, 1, BUILDER_LIMITS.maxRounds),
    collectFirst: Boolean(base.collectFirst)
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BuilderGroup {
  kind: "chain" | "cycle";
  /** Index of the first object (the head, whose variable is the group's root). */
  start: number;
  length: number;
  kept: boolean;
  /** 1-based round in which the head is unrooted; null for kept groups. */
  droppedInRound: number | null;
}

export interface ExpectedCollection {
  label: string;
  freed: number;
  liveAfter: number;
}

export interface ExpectedOutcome {
  allocations: number;
  /** One entry per `gc()` statement, in order. */
  collections: ExpectedCollection[];
  freedTotal: number;
  liveFinal: number;
  /** Reference fields stored in objects that are still live at the end. */
  liveEdges: number;
  /** Reference fields stored in total (live or not). */
  totalEdges: number;
}

export interface Generated {
  spec: BuilderSpec;
  source: string;
  groups: BuilderGroup[];
  stats: {
    objects: number;
    groups: number;
    chains: number;
    cycles: number;
    edges: number;
    statements: number;
    bytes: number;
    fits: boolean;
  };
  expected: ExpectedOutcome;
}

interface Edge {
  src: number;
  field: string;
  dst: number;
}

export function generate(input: Partial<BuilderSpec> = {}): Generated {
  const spec = normalizeSpec(input);
  const rng = mulberry32(spec.seed);
  const between = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
  const n = spec.objects;

  // 1. Partition the objects into consecutive groups.
  const groups: BuilderGroup[] = [];
  for (let position = 0; position < n; ) {
    const remaining = n - position;
    let kind: "chain" | "cycle" = rng() * 100 < spec.cycleShare ? "cycle" : "chain";
    const range = kind === "cycle" ? spec.cycleLength : spec.chainLength;
    const length = Math.min(between(range[0], range[1]), remaining);
    if (kind === "cycle" && length < 2) kind = "chain"; // a lone leftover object cannot form a cycle
    groups.push({ kind, start: position, length, kept: false, droppedInRound: null });
    position += length;
  }

  // 2. Links: group links first, then extra links in object order.
  const edges: Edge[] = [];
  for (const group of groups) {
    for (let k = 0; k + 1 < group.length; k++) edges.push({ src: group.start + k, field: "next", dst: group.start + k + 1 });
    if (group.kind === "cycle") edges.push({ src: group.start + group.length - 1, field: "next", dst: group.start });
  }
  if (n > 1) {
    for (let i = 0; i < n; i++) {
      const count = between(spec.extraLinks[0], spec.extraLinks[1]);
      for (let j = 0; j < count; j++) {
        let target =
          spec.locality > 0
            ? clamp(i + between(-spec.locality, spec.locality), 0, n - 1)
            : between(0, n - 1);
        // Never link an object to itself; step to a neighbour so the locality window still holds.
        if (target === i) target = i + 1 < n ? i + 1 : i - 1;
        edges.push({ src: i, field: `x${j}`, dst: target });
      }
    }
  }

  // 3. Decide which groups stay rooted and spread the others over the rounds.
  const order = groups.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const keepCount = Math.round((groups.length * spec.keepRoots) / 100);
  const keptSet = new Set(order.slice(0, keepCount));
  const dropped = order.slice(keepCount);
  const roundCount = dropped.length === 0 ? 1 : Math.min(spec.rounds, dropped.length);
  groups.forEach((group, index) => (group.kept = keptSet.has(index)));
  dropped.forEach((groupIndex, position) => {
    groups[groupIndex]!.droppedInRound = (position % roundCount) + 1;
  });

  // 4. Source text.
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`o${i} = new Object();`);
  for (const edge of edges) lines.push(`o${edge.src}.${edge.field} = o${edge.dst};`);
  if (spec.collectFirst) lines.push("gc();");
  const heads = new Set(groups.map((group) => group.start));
  for (let i = 0; i < n; i++) if (!heads.has(i)) lines.push(`o${i} = null;`);
  for (let round = 1; round <= roundCount; round++) {
    for (const group of groups) if (group.droppedInRound === round) lines.push(`o${group.start} = null;`);
    lines.push("gc();");
  }
  const source = `${lines.join("\n")}\n`;

  // 5. Expected outcome by a plain reachability walk over the same edges.
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  for (const edge of edges) adjacency[edge.src]!.push(edge.dst);
  const reachable = (roots: Iterable<number>): Set<number> => {
    const seen = new Set<number>();
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const next of adjacency[node]!) stack.push(next);
    }
    return seen;
  };
  const collections: ExpectedCollection[] = [];
  let alive = n;
  if (spec.collectFirst) collections.push({ label: "all objects rooted", freed: 0, liveAfter: n });
  const rootedHeads = new Set(groups.map((group) => group.start));
  let live = reachable(rootedHeads);
  for (let round = 1; round <= roundCount; round++) {
    for (const group of groups) if (group.droppedInRound === round) rootedHeads.delete(group.start);
    live = reachable(rootedHeads);
    collections.push({ label: `round ${round}`, freed: alive - live.size, liveAfter: live.size });
    alive = live.size;
  }
  // With collectFirst the interior variables were nulled before round 1; every object is still
  // reachable from its group head at that point, so the first round's baseline is n.
  let liveEdges = 0;
  for (const edge of edges) if (live.has(edge.src)) liveEdges++;

  const bytes = new TextEncoder().encode(source).length;
  return {
    spec,
    source,
    groups,
    stats: {
      objects: n,
      groups: groups.length,
      chains: groups.filter((group) => group.kind === "chain").length,
      cycles: groups.filter((group) => group.kind === "cycle").length,
      edges: edges.length,
      statements: lines.length,
      bytes,
      fits: bytes <= BUILDER_LIMITS.maxSourceBytes
    },
    expected: {
      allocations: n,
      collections,
      freedTotal: collections.reduce((total, item) => total + item.freed, 0),
      liveFinal: live.size,
      liveEdges,
      totalEdges: edges.length
    }
  };
}

/** The same spec as CLI flags for `web/scripts/gen-toy.mjs`, so GUI and command line agree. */
export function toCliArgs(input: Partial<BuilderSpec>): string {
  const spec = normalizeSpec(input);
  const parts = [
    `--objects ${spec.objects}`,
    `--seed ${spec.seed}`,
    `--cycle-share ${spec.cycleShare}`,
    `--chain-length ${spec.chainLength[0]}-${spec.chainLength[1]}`,
    `--cycle-length ${spec.cycleLength[0]}-${spec.cycleLength[1]}`,
    `--extra-links ${spec.extraLinks[0]}-${spec.extraLinks[1]}`,
    `--locality ${spec.locality}`,
    `--keep-roots ${spec.keepRoots}`,
    `--rounds ${spec.rounds}`,
    `--collect-first ${spec.collectFirst ? "yes" : "no"}`
  ];
  return parts.join(" ");
}

/** Parses "3-8" or "5" into an inclusive range. */
export function parseRange(text: string): [number, number] | null {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(text);
  if (!match) return null;
  const a = Number(match[1]);
  const b = match[2] === undefined ? a : Number(match[2]);
  return [a, b];
}
