import type { Metric, RunResult } from "./index.js";

/** F.4: the sentence every comparison must carry. */
export const COMPARE_HEADER =
  "Separate runtimes, separate programs. Differences reflect language, runtime, object model and collector together.";

export type ComparisonKind = "delta" | "side-by-side" | "one-sided";

export interface ComparisonRow {
  label: string;
  a: Metric | null;
  b: Metric | null;
  kind: ComparisonKind;
  /** Present only when `kind` is "delta": b minus a, and b / a when a is not zero. */
  delta?: { absolute: number; ratio: number | null };
  note: string;
}

export interface Comparison {
  header: string;
  crossEngine: boolean;
  rows: ComparisonRow[];
}

const isMetric = (value: unknown): value is Metric =>
  typeof value === "object" && value !== null && "unit" in value && "provenance" in value && "value" in value;

function totals(run: RunResult): Record<string, Metric> {
  const raw = (run.engineResult as { totals?: Record<string, unknown> } | undefined)?.totals ?? {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, Metric] => isMetric(entry[1])));
}

const usable = (metric: Metric | null | undefined): metric is Metric =>
  !!metric && metric.value !== null && metric.provenance !== "unavailable";

/** Concepts that exist in both engines but are measured on different bases (rule 2). */
const CONCEPTS: Array<{ label: string; jvm: string; custom: string; why: string }> = [
  { label: "Collections", jvm: "gcCount", custom: "collections", why: "HotSpot counts its own collector cycles; the custom runtime counts explicit gc() calls" },
  { label: "Memory allocated", jvm: "allocatedBytesMainThread", custom: "allocations", why: "bytes on the main thread versus objects" },
  { label: "Memory reclaimed", jvm: "objectsReclaimed", custom: "freed", why: "HotSpot does not expose object counts" },
  { label: "Peak or live size", jvm: "heapPeakUsed", custom: "liveAfter", why: "peak heap bytes versus live objects after the last collection" }
];

/**
 * Rules (F.4): a delta only for the same engine kind, the same metric key, the same unit, and
 * neither side unavailable. Cross-engine rows and concept rows are shown side by side with no delta
 * and never produce a speed-up figure.
 */
export function compareRuns(a: RunResult, b: RunResult): Comparison {
  const crossEngine = a.engine !== b.engine;
  const ta = totals(a);
  const tb = totals(b);
  const rows: ComparisonRow[] = [];

  if (!crossEngine) {
    for (const key of [...new Set([...Object.keys(ta), ...Object.keys(tb)])]) {
      const ma = ta[key] ?? null;
      const mb = tb[key] ?? null;
      if (!ma || !mb) {
        rows.push({ label: key, a: ma, b: mb, kind: "one-sided", note: "present in only one run" });
        continue;
      }
      if (ma.unit !== mb.unit) {
        rows.push({ label: key, a: ma, b: mb, kind: "side-by-side", note: `different units (${ma.unit} vs ${mb.unit}) - not directly comparable` });
        continue;
      }
      if (!usable(ma) || !usable(mb)) {
        rows.push({ label: key, a: ma, b: mb, kind: "side-by-side", note: "unavailable on at least one side - no delta" });
        continue;
      }
      const mixed = ma.provenance !== mb.provenance ? ` (provenance differs: ${ma.provenance} vs ${mb.provenance})` : "";
      rows.push({
        label: key,
        a: ma,
        b: mb,
        kind: "delta",
        delta: { absolute: (mb.value as number) - (ma.value as number), ratio: ma.value === 0 ? null : (mb.value as number) / (ma.value as number) },
        note: `same engine, same key, same unit${mixed}`
      });
    }
    return { header: COMPARE_HEADER, crossEngine, rows };
  }

  const jvmRun = a.engine === "jvm" ? a : b;
  const customRun = a.engine === "custom" ? a : b;
  const tj = totals(jvmRun);
  const tc = totals(customRun);
  for (const concept of CONCEPTS) {
    const mj = tj[concept.jvm] ?? null;
    const mc = tc[concept.custom] ?? null;
    const left = a.engine === "jvm" ? mj : mc;
    const right = a.engine === "jvm" ? mc : mj;
    rows.push({
      label: concept.label,
      a: left,
      b: right,
      kind: "side-by-side",
      note: `different bases - not directly comparable: ${concept.why}`
    });
  }
  const wa = ta.wallTimeMs ?? null;
  const wb = tb.wallTimeMs ?? null;
  rows.push({
    label: "Wall time",
    a: wa,
    b: wb,
    kind: "side-by-side",
    note: "timings from different engines are never combined into a speed-up figure"
  });
  return { header: COMPARE_HEADER, crossEngine, rows };
}
