import { MAX_SNAPSHOT_OBJECTS, type HeapSnapshot } from "@gcd/shared";

export class SnapshotRejected extends Error {
  constructor(message: string, readonly kind: "invalid" | "too-large") {
    super(message);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isHandle = (value: unknown): value is string => typeof value === "string" && /^[0-9]+$/.test(value);

/**
 * Structural check of the D.8 contract. The controller already validates against the JSON Schema;
 * this guards the renderer so a malformed payload becomes an error card instead of a broken graph.
 */
export function parseSnapshot(value: unknown): HeapSnapshot {
  if (!isObject(value) || value.schema !== "gcd.heap-snapshot/1") {
    throw new SnapshotRejected("Not a gcd.heap-snapshot/1 document", "invalid");
  }
  if (!Array.isArray(value.objects) || !Array.isArray(value.roots)) {
    throw new SnapshotRejected("Snapshot is missing objects or roots", "invalid");
  }
  if (value.objects.length > MAX_SNAPSHOT_OBJECTS) {
    throw new SnapshotRejected(
      `Snapshot has ${value.objects.length} objects; the heap graph renders at most ${MAX_SNAPSHOT_OBJECTS}`,
      "too-large"
    );
  }
  const ids = new Set<string>();
  for (const object of value.objects) {
    if (!isObject(object) || !isHandle(object.id) || !Array.isArray(object.fields)) {
      throw new SnapshotRejected("Snapshot contains a malformed object", "invalid");
    }
    if (ids.has(object.id)) throw new SnapshotRejected(`Duplicate object id ${object.id}`, "invalid");
    ids.add(object.id);
    for (const field of object.fields) {
      if (!isObject(field) || typeof field.name !== "string" || !(field.target === null || isHandle(field.target))) {
        throw new SnapshotRejected(`Object ${object.id} has a malformed field`, "invalid");
      }
    }
  }
  for (const root of value.roots) {
    if (!isObject(root) || typeof root.name !== "string" || !isHandle(root.target)) {
      throw new SnapshotRejected("Snapshot contains a malformed root", "invalid");
    }
  }
  if (typeof value.index !== "number" || typeof value.truncated !== "boolean" || typeof value.totalObjects !== "number") {
    throw new SnapshotRejected("Snapshot header is malformed", "invalid");
  }
  return value as unknown as HeapSnapshot;
}
