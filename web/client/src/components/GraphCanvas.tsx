import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { useEffect, useRef } from "react";
import type { HeapGraph } from "../lib/graph";

export interface Highlight {
  nodeIds: string[];
  edgeIds: string[];
}

function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function GraphCanvas({
  graph,
  highlight,
  selectedId,
  onSelect
}: {
  graph: HeapGraph;
  highlight: Highlight | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!host.current) return;
    const text = cssColor("--text", "#222");
    const elements: ElementDefinition[] = [
      ...graph.nodes.map((node) => ({
        data: { id: node.id, label: node.label },
        classes: [node.state, node.isRootTarget ? "root-target" : ""].filter(Boolean).join(" ")
      })),
      ...graph.edges.map((edge) => ({
        data: { id: edge.id, source: edge.source, target: edge.target, label: edge.label },
        classes: edge.isRootEdge ? "root-edge" : ""
      }))
    ];
    const instance = cytoscape({
      container: host.current,
      elements,
      minZoom: 0.2,
      maxZoom: 3,
      style: [
        { selector: "node", style: { label: "data(label)", color: text, "font-size": 11, "text-valign": "center", "text-halign": "center", width: 34, height: 34, "border-width": 2 } },
        { selector: "node.survived", style: { "background-color": cssColor("--ok", "#1b7f3b"), "border-color": cssColor("--ok", "#1b7f3b"), shape: "ellipse", color: "#fff" } },
        { selector: "node.freed", style: { "background-color": cssColor("--error", "#c62828"), "border-color": cssColor("--error", "#c62828"), "border-style": "dashed", shape: "round-rectangle", color: "#fff", opacity: 0.8 } },
        { selector: "node.live", style: { "background-color": cssColor("--accent", "#1f6feb"), "border-color": cssColor("--accent", "#1f6feb"), shape: "ellipse", color: "#fff" } },
        { selector: "node.root", style: { "background-color": cssColor("--panel", "#fff"), "border-color": cssColor("--muted", "#667085"), shape: "diamond", width: 46, height: 46 } },
        { selector: "node.root-target", style: { "border-width": 5 } },
        { selector: "edge", style: { width: 1.5, "line-color": cssColor("--muted", "#667085"), "target-arrow-color": cssColor("--muted", "#667085"), "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(label)", "font-size": 9, color: text, "text-background-color": cssColor("--panel", "#fff"), "text-background-opacity": 0.8 } },
        { selector: "edge.root-edge", style: { "line-style": "dotted" } },
        { selector: ".path", style: { "line-color": cssColor("--warn", "#b26a00"), "target-arrow-color": cssColor("--warn", "#b26a00"), "border-color": cssColor("--warn", "#b26a00"), "border-width": 5, width: 3.5, "z-index": 10 } },
        { selector: ":selected", style: { "overlay-color": cssColor("--accent", "#1f6feb"), "overlay-opacity": 0.25 } }
      ],
      layout: {
        name: "breadthfirst",
        directed: true,
        padding: 20,
        spacingFactor: 1.2,
        // cytoscape accepts a selector string here although its typings declare string[]
        roots: (graph.rootEntries.length ? ".root" : undefined) as unknown as string[] | undefined
      }
    });
    instance.on("tap", "node", (event) => onSelectRef.current(event.target.id()));
    instance.on("tap", (event) => {
      if (event.target === instance) onSelectRef.current(null);
    });
    cy.current = instance;
    // The pane is resizable and may be laid out after the graph; refit whenever its size changes.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      instance.resize();
      instance.fit(undefined, 20);
    });
    if (observer && host.current) observer.observe(host.current);
    return () => {
      observer?.disconnect();
      instance.destroy();
      cy.current = null;
    };
  }, [graph]);

  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.elements().removeClass("path");
    if (highlight) {
      for (const id of [...highlight.nodeIds, ...highlight.edgeIds]) instance.getElementById(id).addClass("path");
    }
  }, [graph, highlight]);

  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.elements().unselect();
    if (selectedId) instance.getElementById(selectedId).select();
  }, [graph, selectedId]);

  return <div className="graph-canvas" ref={host} data-testid="graph-canvas" />;
}
