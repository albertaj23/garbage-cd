import type { HeapSnapshot } from "@gcd/shared";

export type NodeState = "freed" | "survived" | "live" | "root";

export interface GraphNode {
  id: string;
  label: string;
  state: NodeState;
  isRootTarget: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  isRootEdge: boolean;
}

export interface HeapGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Ids of synthetic root-entry nodes (`root:<name>`), used as layout roots. */
  rootEntries: string[];
}

export const rootNodeId = (name: string) => `root:${name}`;

/** Pure translation of a snapshot into nodes and edges; positions are chosen later by the layout. */
export function buildGraph(snapshot: HeapSnapshot, onlyRegion: number | null = null): HeapGraph {
  const objects = onlyRegion === null ? snapshot.objects : snapshot.objects.filter((object) => object.region === onlyRegion);
  const present = new Set(objects.map((object) => object.id));
  const rootTargets = new Set(snapshot.roots.map((root) => root.target));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const object of objects) {
    nodes.push({
      id: object.id,
      label: `#${object.id}`,
      state: object.marked === false ? "freed" : object.marked === true ? "survived" : "live",
      isRootTarget: rootTargets.has(object.id)
    });
    object.fields.forEach((field, index) => {
      // Edges to objects outside a truncated slice are omitted rather than drawn dangling.
      if (field.target !== null && present.has(field.target)) {
        edges.push({
          id: `e:${object.id}:${index}`,
          source: object.id,
          target: field.target,
          label: field.name,
          isRootEdge: false
        });
      }
    });
  }
  const rootEntries: string[] = [];
  snapshot.roots.forEach((root, index) => {
    if (!present.has(root.target)) return;
    const id = rootNodeId(root.name);
    if (!rootEntries.includes(id)) {
      rootEntries.push(id);
      nodes.push({ id, label: root.name, state: "root", isRootTarget: false });
    }
    edges.push({ id: `r:${index}`, source: id, target: root.target, label: "", isRootEdge: true });
  });
  return { nodes, edges, rootEntries };
}

export type WhyAlive =
  | { kind: "path"; nodeIds: string[]; edgeIds: string[]; rootName: string | null; description: string }
  | { kind: "freed"; description: string }
  | { kind: "unknown"; description: string };

/** Follows the mark spanning forest (`discoveredBy`) from an object back to the root that reached it. */
export function whyAlive(snapshot: HeapSnapshot, id: string): WhyAlive {
  const byId = new Map(snapshot.objects.map((object) => [object.id, object] as const));
  const start = byId.get(id);
  if (!start) return { kind: "unknown", description: "Object is not in this snapshot." };
  if (start.marked === false) {
    return { kind: "freed", description: `#${id} was not reached during marking: it will be freed by this collection.` };
  }
  if (start.marked === null) {
    return { kind: "unknown", description: "Program-end snapshot: no mark phase ran, so there is no discovery path." };
  }
  const nodeIds = [id];
  const edgeIds: string[] = [];
  const seen = new Set([id]);
  let current = start;
  for (let steps = 0; steps <= snapshot.objects.length; steps++) {
    const found = current.discoveredBy;
    if (!found) {
      return { kind: "unknown", description: "The snapshot carries no discovery information for this object." };
    }
    if (found.root !== null) {
      const rootIndex = snapshot.roots.findIndex((root) => root.name === found.root && root.target === current.id);
      nodeIds.push(rootNodeId(found.root));
      if (rootIndex >= 0) edgeIds.push(`r:${rootIndex}`);
      nodeIds.reverse();
      edgeIds.reverse();
      const intermediates = nodeIds.length - 2;
      return {
        kind: "path",
        nodeIds,
        edgeIds,
        rootName: found.root,
        description: intermediates === 0
          ? `#${id} is alive because root "${found.root}" points directly at it.`
          : `#${id} is alive because root "${found.root}" reaches it through ${intermediates} intermediate object${intermediates === 1 ? "" : "s"}.`
      };
    }
    const parent = found.parent === null ? undefined : byId.get(found.parent);
    if (!parent || seen.has(parent.id)) {
      return { kind: "unknown", description: "The discovery chain leaves this snapshot (it may be truncated)." };
    }
    const fieldIndex = parent.fields.findIndex((field) => field.name === found.field && field.target === current.id);
    if (fieldIndex >= 0) edgeIds.push(`e:${parent.id}:${fieldIndex}`);
    nodeIds.push(parent.id);
    seen.add(parent.id);
    current = parent;
  }
  return { kind: "unknown", description: "The discovery chain did not terminate." };
}
