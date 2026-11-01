import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { drawWorkflowGraph, type GraphInput, type GraphMarks, hitOf } from "@/lib/wfGraph";

const PULSE_MS = 1600;

/** The workflow graph as an SVG: drawn again only when the graph or its marks change, with every pulse on the wall
 *  clock's phase, so a redraw on a poll never restarts a working node's pulse. A click names a node or a map item. */
export function WorkflowGraph({ graph, marks, onSelect, className, label = "Workflow graph", minScale = 0.8, maxScale = 1.3 }: {
  graph: GraphInput | null | undefined;
  marks?: GraphMarks;
  onSelect?: (hit: { path: string; item: number | null }) => void;
  className?: string;
  label?: string;
  /** The drawing is scaled to its container's width within these bounds; past them the container scrolls. */
  minScale?: number;
  maxScale?: number;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [room, setRoom] = useState(0);
  const key = useMemo(() => JSON.stringify([graph?.nodes ?? null, marks ?? null]), [graph, marks]);
  useEffect(() => {
    if (!svg.current) return;
    const size = drawWorkflowGraph(svg.current, graph, marks);
    setNatural((n) => (n.w === size.w && n.h === size.h ? n : size));
    svg.current.style.setProperty("--wf-phase", `-${Date.now() % PULSE_MS}ms`);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const box = svg.current?.parentElement;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setRoom(e.contentRect.width));
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  const scale = natural.w && room ? Math.min(maxScale, Math.max(minScale, room / natural.w)) : 1;
  return (
    <svg ref={svg} role="img" aria-label={label} className={cn("wf select-none", className)}
      style={natural.w ? { width: natural.w * scale, height: natural.h * scale, maxWidth: "none", minWidth: 0 } : undefined}
      onClick={(e) => { const hit = hitOf(e.target); if (hit && onSelect) onSelect(hit); }} />
  );
}

/** The graph's key: who works a node, and what its state means. */
export function GraphLegend({ run = false }: { run?: boolean }) {
  const who: [string, string][] = [["hsl(var(--wf-jev))", "Jev"], ["hsl(var(--wf-parallel))", "Parallel"], ["hsl(var(--wf-openrouter))", "OpenRouter"], ["hsl(var(--wf-tool))", "Tool"], ["hsl(var(--muted-foreground))", "Code"], ["hsl(var(--primary))", "Agent"]];
  const states: [string, string][] = [["border-success bg-success/40", "Done"], ["border-primary bg-primary/20", "Working"], ["border-dashed border-warning", "Held (paused)"], ["border-warning bg-warning/60", "Needs review"], ["border-destructive bg-destructive/60", "Failed"], ["border-dashed border-border-strong", "Pending"]];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[10.5px] text-muted-foreground">
      {who.map(([c, l]) => <span key={l} className="inline-flex items-center gap-1.5"><span className="inline-block size-2" style={{ background: c }} />{l}</span>)}
      {run && <span className="h-3 border-l" aria-hidden />}
      {run && states.map(([c, l]) => <span key={l} className="inline-flex items-center gap-1.5"><span className={cn("inline-block size-2.5 border", c)} />{l}</span>)}
    </div>
  );
}
