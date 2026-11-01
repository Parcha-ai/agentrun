import { workflowGraph } from "@dsl/graph";
import { describe, expect, it } from "vitest";
import { BATCH_MID, batchPausedRun, batchRunAt, kybRun } from "@/fixtures/dwf/runs";
import { itemCounts, itemLabel, itemOutcome, itemStates, type RunGraph, runMarks, toneOf, usd, verdictOf } from "./runGraph";

const MAP = "/root/steps/0";

describe("item outcomes", () => {
  it("reads an item's outcome from its last route's branch, with its tone; a failed item is bad whatever it took", () => {
    const g = batchRunAt(BATCH_MID);
    const items = g.nodes[MAP].items!;
    const done = items.find((it) => it.status === "done")!;
    done.branches = { [`${MAP}/body/steps/2`]: "pass" };
    expect(itemOutcome(g, MAP, done)).toMatchObject({ outcome: "pass", tone: "good" });
    const failed = items.find((it) => it.status === "failed")!;
    failed.branches = { [`${MAP}/body/steps/2`]: "pass" };
    expect(itemOutcome(g, MAP, failed).tone).toBe("bad");
    expect([toneOf("human_review"), toneOf("approve"), toneOf("decline"), toneOf("maybe")]).toEqual(["warn", "good", "bad", undefined]);
  });
  it("draws a picked item's own path: its branch taken, the others not run", () => {
    const workflow = { v: 2, root: { node: "map", label: "each", itemsPath: "docs", as: "rows", body: { node: "chain", steps: [
      { node: "code", label: "score", code: "(s) => s" },
      { node: "route", label: "triage", valuePath: "x", branches: { pass: { body: { node: "code", label: "ok", code: "(s) => s" } }, fail: { body: { node: "code", label: "no", code: "(s) => s" } } } },
    ] } } };
    const graph = workflowGraph(workflow);
    const route = "/root/body/steps/1";
    const g: RunGraph = {
      run: { id: "r", agent: "a", revision: "1", status: "completed", paused: false, startedAt: "2026-10-30T00:00:00Z", endedAt: "2026-10-30T00:00:09Z" },
      workflow, graph, decisions: [], effects: [], totals: { cost_usd: 0, decisions: 0, effects: 0, elapsed_ms: 9000 },
      nodes: { "/root": { status: "done", items: [{ index: 0, status: "done", executionPath: "/root/items/0", branches: { [route]: "fail" } }, { index: 1, status: "done", executionPath: "/root/items/1", branches: { [route]: "pass" } }] } },
    };
    const m = runMarks(g, { path: "/root", item: 0 });
    expect(m.taken).toContain(`${route}/branches/fail/body`);
    expect(m.taken).not.toContain(`${route}/branches/pass/body`);
    expect(m.status![`${route}/branches/pass/body`]).toBe("not-run");
    expect(m.items!["/root"].map((x) => [x.outcome, x.tone])).toEqual([["fail", "bad"], ["pass", "good"]]);
  });
});

describe("runMarks", () => {
  it("holds a paused run's working nodes and items", () => {
    const m = runMarks(batchPausedRun(), null);
    expect(Object.values(m.status!)).not.toContain("working");
    expect(m.items![MAP].some((it) => it.status === "held")).toBe(true);
    expect(m.items![MAP].some((it) => it.status === "working")).toBe(false);
  });
  it("holds a selected in-flight item's body too, not only the rest of the graph", () => {
    const g = batchPausedRun();
    const working = g.nodes[MAP].items!.find((it) => it.status === "working")!;
    const m = runMarks(g, { path: MAP, item: working.index });
    expect(Object.values(m.status!)).not.toContain("working");
  });
  it("marks the route's taken branch, item cells and a verdict outside a map", () => {
    const m = runMarks(kybRun(), null);
    expect(m.taken).toEqual(["/root/steps/3/branches/review/body"]);
    expect(m.status!["/root/steps/3/branches/approve/body"]).toBe("not-run");
    expect(m.verdict!["/root/steps/3"]).toBe("review (unsure)");
    expect(m.verdict!["/root/steps/2"]).toBe("dates_consistent 0.38");
    expect(m.meta!["/root/steps/1/branches/0"]).toMatchObject({ provider: "parallel", web: true });
  });
  it("draws each map item in its state, and the body in one item's states when it is picked", () => {
    const g = batchRunAt(BATCH_MID);
    const m = runMarks(g, null);
    expect(m.items![MAP]).toHaveLength(20);
    expect(m.verdict![`${MAP}/body/steps/1`]).toBeUndefined();
    const picked = runMarks(g, { path: MAP, item: 5 });
    expect(picked.status![`${MAP}/body/steps/1`]).toBe("done");
    expect(picked.verdict![`${MAP}/body/steps/1`]).toBe("altered 0.86");
  });
});

describe("itemStates", () => {
  it("says where a working item is up to, and what a failed item never ran", () => {
    const g = batchRunAt(BATCH_MID);
    const working = g.nodes[MAP].items!.find((x) => x.status === "working")!;
    const s = itemStates(g, MAP, working.index);
    expect(Object.values(s).filter((x) => x === "working")).toHaveLength(1);
    const failed = itemStates(g, MAP, 3);
    expect(failed[`${MAP}/body/steps/0`]).toBe("failed");
    expect(failed[`${MAP}/body/steps/1`]).toBe("not-run");
  });
});

describe("the batch fixture", () => {
  it("is mid-flight: some done, some failed or in review, some working, some waiting", () => {
    const c = itemCounts(batchRunAt(BATCH_MID).nodes[MAP].items);
    expect(c.total).toBe(20);
    expect(c.done).toBeGreaterThan(4);
    expect(c.failed).toBe(2);
    expect(c.review).toBe(1);
    expect(c.working).toBeGreaterThan(0);
    expect(c.pending).toBeGreaterThan(0);
  });
  it("never shows an unknown cost as zero", () => {
    const g = batchRunAt(BATCH_MID);
    const unknown = g.decisions.find((d) => d.status === "cancelled")!;
    expect(unknown.cost_usd).toBeNull();
    expect(g.totals.cost_usd).toBeNull();
    expect(usd(null)).toBe("Unknown");
    expect(verdictOf(unknown)).toBe("interrupted");
  });
});

describe("itemLabel", () => {
  it("names an item by the server's label, else by what its first tool call was given", () => {
    const g = batchRunAt(BATCH_MID);
    expect(itemLabel(g, MAP, 0)).toBe("coi-bramblewood.pdf");
    for (const it of g.nodes[MAP].items!) delete it.label;
    expect(itemLabel(g, MAP, 0)).toBe("coi-bramblewood.pdf");
    expect(itemLabel(g, MAP, 19)).toBeUndefined();
  });
});
