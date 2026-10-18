import type { Metric, RunResult } from "@gcd/shared";
import { humanize, isMetric } from "../format";
import { MetricValue, ProvenanceBadge } from "./ProvenanceBadge";

type Row = Record<string, unknown>;

function MetricTable({ title, entries }: { title: string; entries: Array<[string, Metric]> }) {
  if (entries.length === 0) return null;
  return (
    <section>
      <h3>{title}</h3>
      <table className="kv">
        <tbody>
          {entries.map(([key, metric]) => (
            <tr key={key}>
              <th scope="row">{humanize(key)}</th>
              <td>
                <MetricValue metric={metric} />
              </td>
              <td>
                <ProvenanceBadge metric={metric} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CollectionsTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p className="muted">No collections were recorded.</p>;
  const columns = [
    ...new Set(
      rows.flatMap((row) =>
        Object.entries(row)
          .filter(([, value]) => isMetric(value) || typeof value === "number" || typeof value === "string")
          .map(([key]) => key)
      )
    )
  ];
  return (
    <div className="table-scroll">
      <table className="grid">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{humanize(column)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => {
                const value = row[column];
                return (
                  <td key={column}>
                    {isMetric(value) ? (
                      <>
                        <MetricValue metric={value} /> <ProvenanceBadge metric={value} />
                      </>
                    ) : (
                      String(value ?? "")
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatsPanel({ run }: { run: RunResult | null }) {
  if (!run) return <p className="muted">Run a program to see statistics.</p>;
  const engine = run.engineResult as Row | undefined;
  if (!engine) {
    return (
      <p className="muted">
        {run.status === "running" ? "Run in progress — statistics appear when it finishes." : "No engine result."}
      </p>
    );
  }
  const totals = Object.entries((engine.totals as Row | undefined) ?? {}).filter(
    (entry): entry is [string, Metric] => isMetric(entry[1])
  );
  const collections = Array.isArray(engine.collections) ? (engine.collections as Row[]) : [];
  const jvm = engine.jvm as { version: string; vendor: string; collector: string } | undefined;
  return (
    <div className="stats">
      <p className="legend">
        Provenance: <span className="badge badge-measured">M</span> measured{" "}
        <span className="badge badge-estimated">E</span> estimated{" "}
        <span className="badge badge-reconstructed">R</span> reconstructed{" "}
        <span className="badge badge-unavailable">U</span> unavailable
      </p>
      {jvm ? (
        <p className="muted">
          {jvm.vendor} {jvm.version} · {jvm.collector} collector
        </p>
      ) : null}
      <MetricTable title="Totals" entries={totals} />
      <section>
        <h3>Collections ({collections.length})</h3>
        <CollectionsTable rows={collections} />
      </section>
      {run.status === "running" ? <p className="muted">Partial result: run still in progress.</p> : null}
    </div>
  );
}
