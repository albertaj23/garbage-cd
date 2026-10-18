import type { RunResult, StructuredError } from "@gcd/shared";

export interface Jump {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export function OutputPanel({ run, onJump }: { run: RunResult | null; onJump: (jump: Jump) => void }) {
  if (!run) return <p className="muted">No output yet.</p>;
  const diagnostics = run.staticAnalysis?.diagnostics ?? [];
  return (
    <div className="output">
      {run.errors.map((error: StructuredError, index) => (
        <div key={index} className="error-row" role="alert">
          <strong>{error.code}</strong> <span className="muted">({error.phase})</span> {error.message}
          {error.location ? (
            <button className="link" onClick={() => onJump(error.location!)}>
              line {error.location.line}:{error.location.column}
            </button>
          ) : null}
          {error.detail?.stackTop?.length ? (
            <pre className="stack">{error.detail.stackTop.join("\n")}</pre>
          ) : null}
        </div>
      ))}
      {diagnostics
        .filter((diagnostic) => diagnostic.severity !== "note")
        .map((diagnostic, index) => (
          <div key={`d${index}`} className={`diag diag-${diagnostic.severity}`}>
            <strong>{diagnostic.severity}</strong> {diagnostic.message}
            {diagnostic.location ? (
              <button className="link" onClick={() => onJump(diagnostic.location!)}>
                line {diagnostic.location.line}:{diagnostic.location.column}
              </button>
            ) : null}
          </div>
        ))}
      <h3>stdout</h3>
      {run.output.stdoutTruncated ? <p className="banner">stdout truncated at 64 KiB.</p> : null}
      <pre className="stream" aria-label="stdout">
        {run.output.stdout || "(empty)"}
      </pre>
      {run.output.stderr || run.output.stderrTruncated ? (
        <>
          <h3>stderr</h3>
          {run.output.stderrTruncated ? <p className="banner">stderr truncated.</p> : null}
          <pre className="stream" aria-label="stderr">
            {run.output.stderr}
          </pre>
        </>
      ) : null}
    </div>
  );
}
