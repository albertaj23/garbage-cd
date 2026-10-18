import type { AstNode, StaticAnalysisResult } from "@gcd/shared";
import { useState } from "react";

export interface SpanSelection {
  start: number;
  end: number;
}

function Node({
  node,
  depth,
  selectedId,
  onSelect
}: {
  node: AstNode;
  depth: number;
  selectedId: number | null;
  onSelect: (node: AstNode) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  return (
    <li>
      <div className={`ast-row${selectedId === node.id ? " selected" : ""}`}>
        <button
          className="twisty"
          aria-label={open ? "collapse" : "expand"}
          disabled={!hasChildren}
          onClick={() => setOpen(!open)}
        >
          {hasChildren ? (open ? "▾" : "▸") : "·"}
        </button>
        <button className="ast-label" onClick={() => onSelect(node)}>
          <span className="kind">{node.kind}</span>
          {node.label ? <span className="label"> {node.label}</span> : null}
          {node.span ? (
            <span className="muted">
              {" "}
              {node.span.line}:{node.span.column}
            </span>
          ) : null}
          {node.synthetic ? <span className="chip">synthetic</span> : null}
        </button>
      </div>
      {open && hasChildren ? (
        <ul>
          {node.children.map((child) => (
            <Node key={child.id} node={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function AstPanel({
  analysis,
  onSelectSpan
}: {
  analysis: StaticAnalysisResult | undefined;
  onSelectSpan: (span: SpanSelection) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  if (!analysis?.ast) return <p className="muted">No AST available for this run.</p>;
  return (
    <div className="ast">
      <p className="muted">
        {analysis.nodeCount} nodes
        {analysis.truncated ? <span className="banner inline"> truncated at 5,000 nodes</span> : null}
      </p>
      <ul className="tree">
        <Node
          node={analysis.ast}
          depth={0}
          selectedId={selectedId}
          onSelect={(node) => {
            setSelectedId(node.id);
            if (node.span) onSelectSpan({ start: node.span.start, end: node.span.end });
          }}
        />
      </ul>
    </div>
  );
}
