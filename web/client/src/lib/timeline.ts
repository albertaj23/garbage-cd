import type { TraceBatch } from "@gcd/shared";

export interface StatementBucket {
  statement: number;
  allocations: number;
  rootChanges: number;
  fieldWrites: number;
}

export interface GcMarker {
  gcIndex: number;
  statement: number;
  liveBefore: number | null;
  liveAfter: number | null;
  freed: number | null;
}

export interface Timeline {
  buckets: StatementBucket[];
  maxStatement: number;
  maxPerStatement: number;
  gcs: GcMarker[];
  maxLive: number;
}

type Row = Record<string, unknown>;

const metricValue = (value: unknown): number | null => {
  if (typeof value === "object" && value !== null && "value" in value) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === "number" ? inner : null;
  }
  return null;
};

/** Counts mutator events per statement and lifts GC markers from the engine's per-collection records. */
export function buildTimeline(batches: TraceBatch[], collections: Row[]): Timeline {
  const byStatement = new Map<number, StatementBucket>();
  for (const batch of batches) {
    for (const event of batch.events) {
      const statement = event[2];
      const kind = event[1];
      let bucket = byStatement.get(statement);
      if (!bucket) {
        bucket = { statement, allocations: 0, rootChanges: 0, fieldWrites: 0 };
        byStatement.set(statement, bucket);
      }
      if (kind === "A") bucket.allocations++;
      else if (kind === "RS" || kind === "RC") bucket.rootChanges++;
      else if (kind === "FW") bucket.fieldWrites++;
    }
  }
  const gcs: GcMarker[] = collections.map((row) => ({
    gcIndex: Number(row.gcIndex),
    statement: Number(row.statementIndex),
    liveBefore: metricValue(row.liveBefore),
    liveAfter: metricValue(row.liveAfter),
    freed: metricValue(row.freed)
  }));
  const buckets = [...byStatement.values()].sort((a, b) => a.statement - b.statement);
  const statements = [...buckets.map((bucket) => bucket.statement), ...gcs.map((gc) => gc.statement)];
  return {
    buckets,
    maxStatement: statements.length ? Math.max(...statements) : 0,
    maxPerStatement: Math.max(1, ...buckets.map((bucket) => bucket.allocations + bucket.rootChanges + bucket.fieldWrites)),
    gcs,
    maxLive: Math.max(1, ...gcs.map((gc) => Math.max(gc.liveBefore ?? 0, gc.liveAfter ?? 0)))
  };
}
