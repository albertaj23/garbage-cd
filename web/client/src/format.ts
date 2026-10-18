import type { Metric } from "@gcd/shared";

export function isMetric(value: unknown): value is Metric {
  return (
    typeof value === "object" &&
    value !== null &&
    "provenance" in value &&
    "unit" in value &&
    "value" in value
  );
}

export function formatValue(value: number, unit: string): string {
  if (unit === "bytes" || unit === "B") {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MiB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${value} B`;
  }
  if (unit === "ms") return `${Number.isInteger(value) ? value : value.toFixed(3)} ms`;
  if (unit === "ratio") return value.toFixed(4);
  return `${Number.isInteger(value) ? value : value.toFixed(3)}${unit ? ` ${unit}` : ""}`;
}

export function formatMetric(metric: Metric): string {
  return metric.value === null ? "Unavailable" : formatValue(metric.value, metric.unit);
}

export function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}
