import cytoscape, { type Core } from "cytoscape";
import type { RegionGraph } from "@gcd/shared";
import { useEffect, useRef } from "react";

function cssColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function RegionCanvas({
  graph,
  selected,
  onSelect
}: {
  graph: RegionGraph;
  selected: number | null;
  onSelect: (id: number | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!host.current) return;
    const text = cssColor("--text", "#222");
    const maxLive = Math.max(1, ...graph.regions.map((region) => region.liveObjects));
    const maxEdge = Math.max(1, ...graph.edges.map((edge) => edge.count));
    const instance = cytoscape({
      container: host.current,
      elements: [
        ...graph.regions.map((region) => ({
          data: {
            id: `region:${region.id}`,
            label: `R${region.id}\n${region.liveObjects} live`,
            size: 26 + (region.liveObjects / maxLive) * 44
          },
          classes: region.liveObjects === 0 ? "empty" : region.rootTargets > 0 ? "rooted" : ""
        })),
        ...graph.edges.map((edge) => ({
          data: {
            id: `edge:${edge.from}:${edge.to}`,
            source: `region:${edge.from}`,
            target: `region:${edge.to}`,
            label: String(edge.count),
            weight: 1 + (edge.count / maxEdge) * 5
          }
        }))
      ],
      minZoom: 0.2,
      maxZoom: 3,
      style: [
        { selector: "node", style: { label: "data(label)", "text-wrap": "wrap", color: text, "font-size": 10, "text-valign": "center", "text-halign": "center", width: "data(size)", height: "data(size)", shape: "round-rectangle", "background-color": cssColor("--accent", "#1f6feb"), "border-width": 2, "border-color": cssColor("--accent", "#1f6feb"), "background-opacity": 0.35 } },
        { selector: "node.rooted", style: { "border-width": 5 } },
        { selector: "node.empty", style: { "background-opacity": 0.05, "border-style": "dashed", "border-color": cssColor("--muted", "#667085") } },
        { selector: "edge", style: { width: "data(weight)", "line-color": cssColor("--muted", "#667085"), "target-arrow-color": cssColor("--muted", "#667085"), "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(label)", "font-size": 9, color: text, "text-background-color": cssColor("--panel", "#fff"), "text-background-opacity": 0.8 } },
        { selector: ":selected", style: { "border-color": cssColor("--warn", "#b26a00"), "border-width": 5 } }
      ],
      layout: { name: graph.regions.length > 12 ? "grid" : "circle", padding: 20 }
    });
    instance.on("tap", "node", (event) => onSelectRef.current(Number(String(event.target.id()).slice("region:".length))));
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
    instance.elements().unselect();
    if (selected !== null) instance.getElementById(`region:${selected}`).select();
  }, [graph, selected]);

  return <div className="graph-canvas" ref={host} data-testid="region-canvas" />;
}
