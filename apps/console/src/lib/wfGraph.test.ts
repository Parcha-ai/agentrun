import { workflowGraph } from "@dsl/graph";
import { describe, expect, it } from "vitest";
import { BATCH_MID, batchRunAt } from "@/fixtures/dwf/runs";
import { kybWorkflow } from "@/fixtures/dwf/workflows";
import { runMarks } from "./runGraph";
import { drawWorkflowGraph, hitOf } from "./wfGraph";
import { nodeMeta } from "./workflowDoc";

const svg = () => document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;

describe("drawWorkflowGraph", () => {
  it("draws a card per node with its path, and a decision's provider chip and badges", () => {
    const g = workflowGraph(kybWorkflow);
    const s = svg();
    const meta = Object.fromEntries(g.nodes.map((n) => [n.path, nodeMeta(kybWorkflow, n.path)]));
    const size = drawWorkflowGraph(s, g, { meta });
    expect(size.w).toBeGreaterThan(0);
    const reg = s.querySelector('g[data-path="/root/steps/1/branches/0"]')!;
    expect(reg.getAttribute("class")).toContain("who-parallel");
    expect([...reg.querySelectorAll(".chip")].map((t) => t.textContent)).toEqual(["parallel"]);
    expect([...reg.querySelectorAll(".badge")].map((t) => t.textContent)).toEqual(["WEB"]);
    expect([...s.querySelectorAll('g[data-path="/root/steps/1/branches/1"] .badge')].map((t) => t.textContent)).toEqual(["IMG"]);
  });
  it("draws a map's items as cells a click names, each in its state", () => {
    const run = batchRunAt(BATCH_MID);
    const s = svg();
    drawWorkflowGraph(s, run.graph, runMarks(run, null));
    const cells = s.querySelectorAll(".rcell .cell");
    expect(cells).toHaveLength(20);
    expect(s.querySelectorAll(".rcell.failed")).toHaveLength(2);
    expect(s.querySelectorAll(".rcell.failed.tone-bad")).toHaveLength(2);
    expect(s.querySelectorAll(".rcell.review")).toHaveLength(1);
    expect(s.querySelector('.rcell[data-item="0"] .cell-name')?.textContent).toBeTruthy();
    expect(hitOf(cells[7])).toEqual({ path: "/root/steps/0", item: 7 });
    expect(hitOf(s.querySelector('g[data-path="/root/steps/1"] .box'))).toEqual({ path: "/root/steps/1", item: null });
  });
  it("names a cell's outcome by the item's route branch, in its tone, with the probability behind it", () => {
    const run = batchRunAt(BATCH_MID);
    const map = run.graph.nodes.find((n) => n.kind === "map")!.path;
    const route = run.graph.nodes.find((n) => n.path.startsWith(`${map}/body`) && n.kind !== "chain")!.path;
    const done = run.nodes[map].items!.find((it) => it.status === "done")!;
    done.branches = { [route]: "reject" };
    const s = svg();
    drawWorkflowGraph(s, run.graph, runMarks(run, null));
    const cell = s.querySelector(`.rcell[data-item="${done.index}"]`)!;
    expect(cell.getAttribute("class")).toContain("tone-bad");
    expect(cell.querySelector(".cell-out")?.textContent).toBe("reject");
  });
  it("puts data in text nodes only", () => {
    const w = { v: 2, root: { node: "code", label: '<img src=x onerror="alert(1)">', code: "(s) => s" } };
    const s = svg();
    drawWorkflowGraph(s, workflowGraph(w));
    expect(s.querySelector("img")).toBeNull();
    expect(s.textContent).toContain("<img");
  });
});

// A workflow run's model node names the model it ran on, and its tier when it named one, on its card's kind line
// (runMarks reads the run's nodes[path].model and .tier); a call node does not.
describe("drawWorkflowGraph, a run's model nodes and their models", () => {
  it("a model node's card reads its kind, tier and model; one of no tier its kind and model; a call node as before", async () => {
    const { runMarks } = await import("./runGraph");
    const flow = { v: 2, name: "t", root: { node: "chain", steps: [
      { node: "extract", label: "quick look", tier: "fast", instructions: "Look.", out: "Out", as: "a" },
      { node: "extract", label: "final answer", instructions: "Answer.", out: "Out", as: "b" },
      { node: "call", label: "fetch the page", via: "tool", tool: "web_fetch", args: {}, out: "Out", as: "c" },
    ] } };
    const graph = workflowGraph(flow);
    const run = {
      run: { id: "r", agent: "a", revision: "1", status: "completed", paused: false, startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-01T00:00:02Z" },
      workflow: flow, graph, decisions: [], effects: [], totals: { cost_usd: null, decisions: 0, effects: 0, elapsed_ms: 2000 },
      nodes: { "/root": { status: "done" }, "/root/steps/0": { status: "done", model: "gpt-5-mini", tier: "fast" }, "/root/steps/1": { status: "done", model: "gpt-5-4-mini" }, "/root/steps/2": { status: "done" } },
    } as never;
    const s = svg();
    drawWorkflowGraph(s, graph, runMarks(run, null));
    const kind = (p: string) => s.querySelector(`g[data-path="${p}"] .kind`)?.textContent;
    expect(kind("/root/steps/0")).toBe("extract · fast · gpt-5-mini");
    expect(kind("/root/steps/1")).toBe("extract · gpt-5-4-mini");
    expect(kind("/root/steps/2")).toBe("call · web_fetch");
    expect(s.querySelector('g[data-path="/root/steps/0"] title')?.textContent).toContain("ran on gpt-5-mini (the fast tier)");
  });
});
