import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ProviderIcon, providerIconSrc, providerIdForModel, providerIdForTool } from "@/components/ProviderIcon";
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
  const iconClipPrefix = useId().replace(/:/g, "");
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [room, setRoom] = useState(0);
  const key = useMemo(() => JSON.stringify([graph?.nodes ?? null, marks ?? null]), [graph, marks]);
  useEffect(() => {
    if (!svg.current) return;
    const size = drawWorkflowGraph(svg.current, graph, marks);
    // The SVG renderer keeps its coloured swatch while the provider's mark loads, and when loading fails. Fit the
    // circular badge into that same left gutter, with the complete logo inset on a light surface in either theme.
    let iconIndex = 0;
    for (const card of svg.current.querySelectorAll<SVGGElement>(".node.card[data-path]")) {
      const path = card.getAttribute("data-path")!;
      const meta = marks?.meta?.[path];
      const model = marks?.ran?.[path]?.model ?? meta?.model;
      const provider = meta?.decision && meta.provider ? meta.provider : meta?.tool ? providerIdForTool(meta.tool) : model ? providerIdForModel(model) : undefined;
      const src = provider ? providerIconSrc(provider) : undefined;
      const swatch = card.querySelector<SVGRectElement>(".swatch");
      if (!src || !swatch) continue;
      const ns = "http://www.w3.org/2000/svg";
      const cx = Number(swatch.getAttribute("x")) + 4;
      const cy = Number(swatch.getAttribute("y")) + 4;
      const clipId = `wf-provider-${iconClipPrefix}-${iconIndex++}`;
      const badge = document.createElementNS(ns, "g");
      badge.setAttribute("data-provider-badge", provider!);
      badge.setAttribute("aria-hidden", "true");
      badge.setAttribute("visibility", "hidden");
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", "7");
      const clip = document.createElementNS(ns, "clipPath");
      clip.setAttribute("id", clipId);
      clip.appendChild(circle.cloneNode());
      const defs = document.createElementNS(ns, "defs");
      defs.appendChild(clip);
      circle.setAttribute("r", "6.5");
      circle.setAttribute("fill", "hsl(var(--provider-icon-surface))");
      circle.setAttribute("stroke", "hsl(var(--border))");
      circle.setAttribute("stroke-width", "1");
      circle.setAttribute("data-provider-surface", "");
      const icon = document.createElementNS(ns, "image");
      icon.setAttribute("href", src);
      icon.setAttribute("x", String(cx - 4.9));
      icon.setAttribute("y", String(cy - 4.9));
      icon.setAttribute("width", "9.8");
      icon.setAttribute("height", "9.8");
      icon.setAttribute("preserveAspectRatio", "xMidYMid meet");
      icon.setAttribute("clip-path", `url(#${clipId})`);
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("referrerpolicy", "no-referrer");
      icon.setAttribute("data-provider-icon", provider!);
      icon.addEventListener("load", () => { swatch.setAttribute("visibility", "hidden"); badge.removeAttribute("visibility"); });
      icon.addEventListener("error", () => { swatch.removeAttribute("visibility"); badge.remove(); });
      badge.append(defs, circle, icon);
      card.appendChild(badge);
    }
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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-label text-muted-foreground">
      {who.map(([c, l]) => <span key={l} className="inline-flex items-center gap-1.5"><span className="inline-block size-2" style={{ background: c }} />{["Jev", "Parallel", "OpenRouter"].includes(l) && <ProviderIcon id={l.toLowerCase()} className="size-3" />}{l}</span>)}
      {run && <span className="h-3 border-l" aria-hidden />}
      {run && states.map(([c, l]) => <span key={l} className="inline-flex items-center gap-1.5"><span className={cn("inline-block size-2.5 border", c)} />{l}</span>)}
    </div>
  );
}
