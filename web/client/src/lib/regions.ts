import { MAX_RENDERED_REGIONS, type RegionGraph } from "@gcd/shared";

export class RegionGraphRejected extends Error {
  constructor(message: string, readonly kind: "invalid" | "too-large") {
    super(message);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Structural check of `gcd.region-graph/1`; the controller has already validated the JSON Schema. */
export function parseRegionGraph(value: unknown): RegionGraph {
  if (!isObject(value) || value.schema !== "gcd.region-graph/1" || !Array.isArray(value.regions) || !Array.isArray(value.edges)) {
    throw new RegionGraphRejected("Not a gcd.region-graph/1 document", "invalid");
  }
  if (value.regions.length > MAX_RENDERED_REGIONS) {
    throw new RegionGraphRejected(
      `The graph has ${value.regions.length} regions; the region view renders at most ${MAX_RENDERED_REGIONS}`,
      "too-large"
    );
  }
  const ids = new Set<number>();
  for (const region of value.regions) {
    if (!isObject(region) || !isCount(region.id) || !isCount(region.liveObjects) || !isCount(region.allocatedTotal) || ids.has(region.id)) {
      throw new RegionGraphRejected("Region graph contains a malformed region", "invalid");
    }
    ids.add(region.id);
  }
  for (const edge of value.edges) {
    if (!isObject(edge) || !isCount(edge.from) || !isCount(edge.to) || !isCount(edge.count) || !ids.has(edge.from) || !ids.has(edge.to)) {
      throw new RegionGraphRejected("Region graph contains an edge to an unknown region", "invalid");
    }
  }
  return value as unknown as RegionGraph;
}
