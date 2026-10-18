import type { Metric, Provenance } from "@gcd/shared";
import { formatValue } from "../format";

const letters: Record<Provenance, string> = {
  measured: "M",
  estimated: "E",
  reconstructed: "R",
  unavailable: "U"
};

export function ProvenanceBadge({ metric }: { metric: Metric }) {
  const tooltip = [`${metric.provenance}`, `source: ${metric.source}`, metric.note ? `note: ${metric.note}` : ""]
    .filter(Boolean)
    .join("\n");
  return (
    <span className={`badge badge-${metric.provenance}`} title={tooltip} aria-label={`provenance ${metric.provenance}`}>
      {letters[metric.provenance]}
    </span>
  );
}

export function MetricValue({ metric }: { metric: Metric }) {
  if (metric.value === null) {
    return (
      <span className="unavailable" title={metric.note ?? metric.source}>
        Unavailable{metric.note ? ` — ${metric.note}` : ""}
      </span>
    );
  }
  return <>{formatValue(metric.value, metric.unit)}</>;
}

