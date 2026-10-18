import type { BenchmarkListing, BenchmarkSummary, Verdict } from "@gcd/shared";
import { useEffect, useState } from "react";
import { api } from "../api";

const verdictGlyph: Record<Verdict, string> = { pass: "✔ pass", fail: "✖ fail", inconclusive: "? inconclusive" };

const WORKLOADS = ["W1", "W2", "W3", "W4", "W5", "W6", "W7"];
const VARIANTS = [
  { id: "B", label: "B regions" },
  { id: "D", label: "D regions+trace" },
  { id: "E", label: "E slot reuse" },
  { id: "ED", label: "E+D" }
];

function RatioChart({ summary, metric }: { summary: BenchmarkSummary; metric: "total" | "collect" }) {
  const cap = 3;
  const width = 720;
  const height = 190;
  const left = 34;
  const groupWidth = (width - left - 8) / WORKLOADS.length;
  const barWidth = groupWidth / (VARIANTS.length + 1);
  const y = (value: number) => 14 + (1 - Math.min(value, cap) / cap) * (height - 44);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric} time relative to A-prime`} className="timeline-svg">
      <line x1={left} y1={y(0)} x2={width - 8} y2={y(0)} className="axis" />
      <line x1={left} y1={y(1)} x2={width - 8} y2={y(1)} className="axis" strokeDasharray="4 3" />
      {[0, 1, 2, 3].map((tick) => (
        <text key={tick} x={left - 4} y={y(tick) + 3} textAnchor="end" className="axis-label">
          {tick}×
        </text>
      ))}
      {WORKLOADS.map((workload, wi) => (
        <g key={workload}>
          <text x={left + wi * groupWidth + groupWidth / 2} y={height - 12} textAnchor="middle" className="axis-label">
            {workload}
          </text>
          {VARIANTS.map((variant, vi) => {
            const row = summary.collector.find((item) => item.workload === workload && item.variant === variant.id);
            if (!row) return null;
            const ratio = row[metric];
            const x = left + wi * groupWidth + (vi + 0.5) * barWidth;
            return (
              <g key={variant.id} className={`ratio-bar v${vi}${ratio.real ? " real" : ""}`}>
                <title>{`${workload} ${variant.label}: ×${ratio.ratio.toFixed(3)} (95% CI ${ratio.lo?.toFixed(3) ?? "?"}–${ratio.hi?.toFixed(3) ?? "?"})${ratio.real ? " — real" : " — within noise"}`}</title>
                <rect x={x} y={y(ratio.ratio)} width={barWidth * 0.8} height={Math.max(0, y(0) - y(ratio.ratio))} />
                {ratio.lo != null && ratio.hi != null ? (
                  <line x1={x + barWidth * 0.4} x2={x + barWidth * 0.4} y1={y(ratio.lo)} y2={y(ratio.hi)} className="whisker" />
                ) : null}
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

function number(value: number | null | undefined, digits = 1): string {
  return value == null ? "n/a" : value >= 1000 ? Math.round(value).toLocaleString() : value.toFixed(digits);
}

export function BenchmarkPanel() {
  const [listing, setListing] = useState<BenchmarkListing[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [summary, setSummary] = useState<BenchmarkSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<"total" | "collect">("total");

  useEffect(() => {
    api
      .benchmarks()
      .then((items) => {
        setListing(items);
        setSelected(items[0]?.id ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setSummary(null);
    api
      .benchmark(selected)
      .then((value) => !cancelled && setSummary(value))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (error) {
    return (
      <div className="error-card" role="alert">
        <strong>Benchmark results could not be loaded.</strong> {error}
      </div>
    );
  }
  if (!listing) return <p className="muted">Loading benchmark results…</p>;
  if (listing.length === 0) {
    return <p className="muted">No committed benchmark results yet. Run bench/run_bench.sh to produce some.</p>;
  }
  if (!summary) return <p className="muted">Loading {selected}…</p>;
  const env = summary.environment as Record<string, unknown>;
  return (
    <div className="benchmarks">
      <div className="heap-head">
        <label>
          Result set{" "}
          <select aria-label="Result set" value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
            {listing.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {String(env.cpuModel ?? "?")} · {String(env.cores ?? "?")} cores · power {String(env.power ?? "?")}
        </span>
      </div>
      <p className="muted">{summary.method.noiseRule}</p>
      <h3>Hypotheses</h3>
      <table className="grid hypotheses">
        <thead>
          <tr>
            <th>ID</th>
            <th>Hypothesis</th>
            <th>Verdict</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {summary.hypotheses.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.id}</th>
              <td title={row.criterion}>{row.statement}</td>
              <td className={`verdict verdict-${row.verdict}`}>{verdictGlyph[row.verdict]}</td>
              <td className="evidence">{row.evidence}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>
        Run time relative to A′{" "}
        <select aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value as "total" | "collect")}>
          <option value="total">whole run</option>
          <option value="collect">collect time only</option>
        </select>
      </h3>
      <p className="legend">
        Bars are median ratios; whiskers are 95 % bootstrap CIs; dashed line = no change. Solid bars are real differences (CI excludes 1 and the effect exceeds the noise floor); faded bars are within noise.{" "}
        {VARIANTS.map((variant, index) => (
          <span key={variant.id}>
            <span className={`swatch v${index}`} /> {variant.label}{" "}
          </span>
        ))}
      </p>
      <RatioChart summary={summary} metric={metric} />
      <h3>Region overview versus full snapshot (H2)</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>Objects</th>
            <th>Snapshot ms</th>
            <th>Export ms</th>
            <th>Ratio [95 % CI]</th>
          </tr>
        </thead>
        <tbody>
          {summary.h2.map((row) => (
            <tr key={row.objects}>
              <td>{row.objects.toLocaleString()}</td>
              <td>{number(row.snapshotMs, 3)}</td>
              <td>{number(row.exportMs, 4)}</td>
              <td>
                {number(row.ratio)}× [{number(row.lo)}, {number(row.hi)}]
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>HotSpot reference runs</h3>
      <p className="banner" role="note">
        Separate runtimes, separate programs. Differences reflect language, runtime, object model and collector together. These rows show behaviour only; no row is a speed comparison with the custom runtime.
      </p>
      <table className="grid">
        <thead>
          <tr>
            <th>Program</th>
            <th>Collector</th>
            <th>GCs</th>
            <th>Pause total ms</th>
            <th>Heap after last GC</th>
            <th>Wall ms</th>
          </tr>
        </thead>
        <tbody>
          {summary.jvm.map((row) => (
            <tr key={`${row.program}-${row.collector}`}>
              <td>{row.program}</td>
              <td>{row.collector}</td>
              <td>{number(row.gcCount, 0)}</td>
              <td>{number(row.gcPauseTotalMs, 2)}</td>
              <td>{number(row.heapAfterLastGcBytes, 0)} B</td>
              <td>{number(row.wallMs, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
