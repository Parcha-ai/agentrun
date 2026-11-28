import { workflowGraph } from "@dsl/graph";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunGraphView, useRunGraph } from "@/components/RunGraphView";
import { ClientError } from "@/lib/client";
import type { RunGraph } from "@/lib/runGraph";
import escalated from "@/fixtures/run.escalated.graph.json";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); vi.useRealTimers(); document.body.innerHTML = ""; });

function Probe({ load, enabled = true }: { load: (s: AbortSignal) => Promise<RunGraph>; enabled?: boolean }) {
  useRunGraph(load, { everyMs: 1000, key: "r", enabled });
  return null;
}

describe("useRunGraph", () => {
  it("stops asking after a permanent refusal (a server without the route)", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => { throw new ClientError(404, "not_found", "no route"); });
    root = createRoot(document.createElement("div"));
    await act(async () => { root!.render(createElement(Probe, { load })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("keeps asking after a refusal that can pass, and asks nothing when disabled", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => { throw new ClientError(503, "unavailable", "busy"); });
    root = createRoot(document.createElement("div"));
    await act(async () => { root!.render(createElement(Probe, { load })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(load.mock.calls.length).toBeGreaterThan(2);
    const off = vi.fn(async () => ({}) as RunGraph);
    await act(async () => { root!.render(createElement(Probe, { load: off, enabled: false })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(off).not.toHaveBeenCalled();
  });
});

describe("RunGraphView", () => {
  it("opens a node's details as a drawer beside the graph: a line and the drawer's shadow at its left edge", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(createElement(RunGraphView, { data: escalated.body as unknown as RunGraph, fileUrl: (ref: string) => ref, initial: { path: "/root/steps/0" } })));
    const drawer = host.querySelector<HTMLElement>("[data-node-drawer]")!;
    expect(drawer.querySelector('aside[aria-label="Node details"]')).toBeTruthy();
    // Beside the graph from lg, under it below: the shadow is the breakpoint's, on a positioned box.
    for (const c of ["relative", "lg:border-l", "lg:shadow-drawer"]) expect(drawer.className.split(" "), c).toContain(c);
    expect(drawer.className).not.toMatch(/(^| )shadow-(float|drawer)( |$)/);
  });
  it("draws a run whose graph the server withheld (a saved secret split across its words): no nodes, and says so", () => {
    const data = {
      run: { id: "r", agent: "a", revision: "1", status: "completed", paused: false, startedAt: "2026-11-24T00:00:00Z", endedAt: "2026-11-24T00:00:09Z" },
      workflow: "[redacted]",
      graph: { nodes: [], edges: [], withheld: true },
      nodes: {}, decisions: [], effects: [], totals: { cost_usd: 0, decisions: 0, effects: 0, elapsed_ms: 9000 },
    } as unknown as RunGraph;
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(createElement(RunGraphView, { data, fileUrl: (ref: string) => ref })));
    expect(host.textContent).toContain("Decisions");
    expect(host.querySelector('[role="status"]')?.textContent ?? "").toMatch(/graph is withheld/);
  });
  it("draws a run whose facts the server withheld (a saved secret split across its agent and revision), and says so; totals withheld as \"[redacted]\" draw no counts", () => {
    const workflow = { v: 2, root: { node: "code", label: "one", code: "(s) => s" } };
    const data = {
      run: { id: "r", agent: "[redacted]", revision: "[redacted]", status: "completed", paused: false, startedAt: "2026-11-24T00:00:00Z", endedAt: "2026-11-24T00:00:09Z", withheld: true },
      workflow, graph: workflowGraph(workflow),
      nodes: { "/root": { status: "done" } }, decisions: [], effects: [], totals: "[redacted]",
    } as unknown as RunGraph;
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(createElement(RunGraphView, { data, fileUrl: (ref: string) => ref })));
    expect(host.textContent).toContain("Decisions");
    expect([...host.querySelectorAll('[role="status"]')].map((node) => node.textContent).join(" ")).toMatch(/agent and revision are withheld/);
  });
  it("draws a run whose node states the server withheld as \"[redacted]\" (a saved secret split across them), and says so", () => {
    const workflow = { v: 2, root: { node: "code", label: "one", code: "(s) => s" } };
    const data = {
      run: { id: "r", agent: "a", revision: "1", status: "completed", paused: false, startedAt: "2026-11-24T00:00:00Z", endedAt: "2026-11-24T00:00:09Z" },
      workflow, graph: workflowGraph(workflow),
      nodes: "[redacted]", decisions: [], effects: [], totals: { cost_usd: 0, decisions: 0, effects: 0, elapsed_ms: 9000 },
    } as unknown as RunGraph;
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(createElement(RunGraphView, { data, fileUrl: (ref: string) => ref })));
    expect(host.textContent).toContain("Decisions");
    expect([...host.querySelectorAll('[role="status"]')].map((node) => node.textContent).join(" ")).toMatch(/node states are withheld/);
  });
});
