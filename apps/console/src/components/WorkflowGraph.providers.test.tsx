import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowGraph } from "./WorkflowGraph";
import type { GraphMarks } from "@/lib/wfGraph";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const draw = (marks: GraphMarks) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(<WorkflowGraph graph={{ nodes: [{ path: "/root", kind: "call", label: "Look up the company" }] }} marks={marks} />));
  return host;
};

describe("workflow graph provider marks", () => {
  it("fits a circular badge and the full inset logo in the existing gutter without moving its label", () => {
    const host = draw({ meta: { "/root": { decision: false, tool: "monid.run" } } });
    const icon = host.querySelector('image[data-provider-icon="monid"]')!;
    expect(icon.getAttribute("href")).toBe("https://www.google.com/s2/favicons?domain=monid.ai&sz=64");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    const surface = host.querySelector("circle[data-provider-surface]")!;
    expect(surface.getAttribute("r")).toBe("6.5");
    expect(surface.getAttribute("fill")).toBe("hsl(var(--provider-icon-surface))");
    expect(surface.getAttribute("stroke")).toBe("hsl(var(--border))");
    expect(surface.getAttribute("stroke-width")).toBe("1");
    expect(Number(icon.getAttribute("width"))).toBeCloseTo(14 * 0.7);
    expect(Number(icon.getAttribute("height"))).toBeCloseTo(14 * 0.7);
    expect(Number(icon.getAttribute("x")) + Number(icon.getAttribute("width")) / 2).toBe(Number(surface.getAttribute("cx")));
    expect(Number(icon.getAttribute("y")) + Number(icon.getAttribute("height")) / 2).toBe(Number(surface.getAttribute("cy")));
    expect(icon.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
    const clip = host.querySelector("clipPath")!;
    expect(icon.getAttribute("clip-path")).toBe(`url(#${clip.id})`);
    expect(clip.querySelector("circle")?.getAttribute("r")).toBe("7");
    const label = host.querySelector("text.label")!;
    expect(label.textContent).toBe("Look up the company");
    expect(Number(surface.getAttribute("cx")) + Number(surface.getAttribute("r"))).toBeLessThan(Number(label.getAttribute("x")));
  });

  it("keeps the swatch until the image loads, and restores it if the image fails", () => {
    const host = draw({ ran: { "/root": { model: "anthropic/claude-sonnet" } } });
    const icon = host.querySelector("image")!;
    const swatch = host.querySelector(".swatch")!;
    const badge = host.querySelector("[data-provider-badge]")!;
    expect(swatch.getAttribute("visibility")).toBeNull();
    expect(badge.getAttribute("visibility")).toBe("hidden");
    act(() => icon.dispatchEvent(new Event("load")));
    expect(swatch.getAttribute("visibility")).toBe("hidden");
    expect(badge.getAttribute("visibility")).toBeNull();
    act(() => icon.dispatchEvent(new Event("error")));
    expect(host.querySelector("image")).toBeNull();
    expect(host.querySelector("[data-provider-badge]")).toBeNull();
    expect(swatch.getAttribute("visibility")).toBeNull();
  });

  it("uses the swatch for generic tools and never loads a URL from unknown provider text", () => {
    const host = draw({ meta: { "/root": { decision: true, provider: "https://untrusted.example/icon" } } });
    expect(host.querySelector("image")).toBeNull();
    expect(host.querySelector(".swatch")).not.toBeNull();
  });
});
