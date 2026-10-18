import type { Metric } from "@gcd/shared";

export interface GcCollection {
  gcId: number;
  uptimeMs: number;
  kind: string;
  cause: string;
  heapBefore: Metric;
  heapAfter: Metric;
  heapCapacity: Metric;
  pause: Metric;
}

const measured = (value: number, unit: string, source: string): Metric => ({
  value,
  unit,
  provenance: "measured",
  source
});

function bytes(value: string): number | null {
  const match = /^([\d.]+)([KMG])?$/.exec(value);
  if (!match) return null;
  const scale = match[2] === "K" ? 1024 : match[2] === "M" ? 1024 ** 2 : match[2] === "G" ? 1024 ** 3 : 1;
  return Number(match[1]) * scale;
}

export function parseGcLog(text: string): GcCollection[] {
  const collections: GcCollection[] = [];
  const pattern =
    /^\[(\d+(?:\.\d+)?)s\]\[[^\]]+\]\[gc\s*\]\s+GC\((\d+)\)\s+Pause\s+(.+?)(?:\s+\(([^()]*)\))?\s+([\d.]+[KMG]?)->([\d.]+[KMG]?)\(([\d.]+[KMG]?)\)\s+([\d.]+)ms(?:\s|$)/;
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    const before = bytes(match[5]!);
    const after = bytes(match[6]!);
    const capacity = bytes(match[7]!);
    const pause = Number(match[8]);
    if (before === null || after === null || capacity === null || !Number.isFinite(pause)) {
      continue;
    }
    const description = match[3]!.trim();
    collections.push({
      gcId: Number(match[2]),
      uptimeMs: Number(match[1]) * 1_000,
      kind: description,
      cause: match[4]?.trim() || "not reported",
      heapBefore: measured(before, "bytes", "HotSpot unified GC log"),
      heapAfter: measured(after, "bytes", "HotSpot unified GC log"),
      heapCapacity: measured(capacity, "bytes", "HotSpot unified GC log"),
      pause: measured(pause, "ms", "HotSpot unified GC log")
    });
  }
  return collections;
}

export function metric(
  value: number | null,
  unit: string,
  source: string,
  note?: string
): Metric {
  return value === null
    ? {
        value: null,
        unit,
        provenance: "unavailable",
        source,
        ...(note === undefined ? {} : { note })
      }
    : measured(value, unit, source);
}
