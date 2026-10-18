import { compareRuns, type ComparisonRow, type Metric, type RunResult } from "@gcd/shared";
import { useState } from "react";
import { formatMetric, humanize } from "../format";
import { ProvenanceBadge } from "./ProvenanceBadge";

const label = (run: RunResult, index: number) =>
  `${index + 1}. ${run.engine === "jvm" ? "JVM" : "custom"} · ${run.runId.slice(-6)} · ${run.status}`;

function Cell({ metric }: { metric: Metric | null }) {
  if (!metric) return <span className="muted">—</span>;
  return (
    <>
      {formatMetric(metric)} <ProvenanceBadge metric={metric} />
    </>
  );
}

function describeDelta(row: ComparisonRow): string {
  if (!row.delta) return "";
  const sign = row.delta.absolute > 0 ? "+" : "";
  const ratio = row.delta.ratio === null ? "" : ` (×${row.delta.ratio.toFixed(3)})`;
  return `${sign}${Number.isInteger(row.delta.absolute) ? row.delta.absolute : row.delta.absolute.toFixed(3)} ${row.a?.unit ?? ""}${ratio}`;
}

export function ComparePanel({ history }: { history: RunResult[] }) {
  const [first, setFirst] = useState(0);
  const [second, setSecond] = useState(1);
  if (history.length < 2) {
    return (
      <p className="muted">
        Run at least two programs in this session to compare them. Runs on different engines can be compared side by side, but never as a speed-up.
      </p>
    );
  }
  const a = history[Math.min(first, history.length - 1)]!;
  const b = history[Math.min(second, history.length - 1)]!;
  const comparison = compareRuns(a, b);
  return (
    <div className="compare">
      <div className="heap-head">
        <label>
          Run A{" "}
          <select aria-label="Run A" value={first} onChange={(e) => setFirst(Number(e.target.value))}>
            {history.map((run, index) => (
              <option key={run.runId} value={index}>
                {label(run, index)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Run B{" "}
          <select aria-label="Run B" value={second} onChange={(e) => setSecond(Number(e.target.value))}>
            {history.map((run, index) => (
              <option key={run.runId} value={index}>
                {label(run, index)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="banner" role="note">
        {comparison.header}
      </p>
      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>Metric</th>
              <th>A</th>
              <th>B</th>
              <th>Delta</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => (
              <tr key={row.label} data-kind={row.kind}>
                <th scope="row">{humanize(row.label)}</th>
                <td>
                  <Cell metric={row.a} />
                </td>
                <td>
                  <Cell metric={row.b} />
                </td>
                <td>{row.kind === "delta" ? describeDelta(row) : <span className="muted">no delta</span>}</td>
                <td className="muted">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
