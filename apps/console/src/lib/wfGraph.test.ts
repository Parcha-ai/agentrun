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
