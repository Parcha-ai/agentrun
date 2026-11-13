import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnFromCsv } from "./LearnFromCsv";
import type { Client } from "@/lib/client";
import type { LearningBatch } from "@/lib/v2";

// Learn from a CSV: the progress card reads the server's batch (it survives a reload), polls while it runs, tells the tab once
// when it ends, and a new batch is started from a file with the columns picked.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); });

const row = (n: number, state: string, right?: boolean) => ({ n, state, reference: `ref ${n}`, answer: state === "done" ? `ans ${n}` : null, right: right ?? null, path: state === "done" ? "agent" : null, total_usd: state === "done" ? 0.01 : null });
const batch = (over: Record<string, unknown> = {}) => ({
  id: "lb_1", status: "running", stopped: null, total: 3, finished: 1, right: 1, wrong: 0, failed: 0, current: 2, cost_usd: 0.01, max_cost_usd: 2,
  lessons: { notes: ["Check units"], skills: [], workflows: [] }, revisions: [], paths: { agent: 1, handed_back: 0, workflow: 0 },
  rows: [row(1, "done", true), row(2, "running"), row(3, "pending")], ...over,
}) as unknown as LearningBatch;

function fake(reads: LearningBatch[]) {
  let i = 0;
  const v2 = {
    learningBatches: vi.fn(async () => ({ batches: reads.length ? [{ id: "lb_1" }] : [] })),
    learningBatch: vi.fn(async () => reads[Math.min(i++, reads.length - 1)]!),
    startLearningBatch: vi.fn(async () => batch()),
    cancelLearningBatch: vi.fn(async () => batch({ status: "cancelled", finished: 1 })),
  };
  return v2;
}
async function show(v2: ReturnType<typeof fake>, onFinished = () => {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(LearnFromCsv, { v2: v2 as unknown as Client, agentId: "ag", onFinished, pollMs: 20 })); });
  return host;
}
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("LearnFromCsv", () => {
  it("a first read that fails is read again, and a person can read again at once: the feature is never hidden for the visit", async () => {
    const v2 = fake([]);
    let fails = 1;
    v2.learningBatches.mockImplementation(async () => { if (fails-- > 0) throw new Error("network down"); return { batches: [] }; });
    const host = await show(v2);
    expect(host.textContent).toMatch(/not available right now: network down/);
    await wait(150);
    expect(host.textContent).toContain("Learn from a CSV");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Learn from a CSV")).toBe(true);
  });
  it("the unavailable view has Read again", async () => {
    const v2 = fake([]);
    v2.learningBatches.mockImplementation(async () => { throw new Error("down"); });
    const host = await show(v2);
    const again = [...host.querySelectorAll("button")].find((b) => b.textContent === "Read again");
    expect(again).toBeTruthy();
    v2.learningBatches.mockImplementation(async () => ({ batches: [] }));
    await act(async () => { again!.click(); });
    await wait(10);
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Learn from a CSV")).toBe(true);
  });
  it("shows a running batch: rows done, right and wrong, cost, lessons and each row", async () => {
    const host = await show(fake([batch()]));
    const t = host.textContent ?? "";
    expect(t).toContain("1 of 3 rows");
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
    expect(t).toContain("Check units");
    expect(t).toContain("ref 2");
    expect(t).toMatch(/Cancel/);
  });
  it("polls while it runs and tells the tab once when it ends", async () => {
    const done = batch({ status: "completed", finished: 3, current: null, rows: [row(1, "done", true), row(2, "done", false), row(3, "done", true)], right: 2, wrong: 1 });
    const v2 = fake([batch(), done]);
    const onFinished = vi.fn();
    const host = await show(v2, onFinished);
    await wait(120);
    expect(host.textContent).toContain("3 of 3 rows");
    expect(host.textContent).toContain("Every row ran");
    expect(onFinished).toHaveBeenCalledTimes(1);
    await wait(80);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
  it("reads an ended batch after a reload without telling the tab", async () => {
    const onFinished = vi.fn();
    const host = await show(fake([batch({ status: "stopped", stopped: "cap", finished: 1 })]), onFinished);
    expect(host.textContent).toContain("what is left of the cap");
    expect(onFinished).not.toHaveBeenCalled();
  });
  it("cancels a running batch", async () => {
    const v2 = fake([batch(), batch({ status: "cancelled", finished: 1 })]);
    const host = await show(v2);
    const cancel = [...host.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => { cancel.click(); });
    expect(v2.cancelLearningBatch).toHaveBeenCalledWith("ag", "lb_1");
    expect(host.textContent).toContain("Cancelled after 1 of 3 rows");
  });
  it("starts a batch from a file: the last column is the answer, the rest are given", async () => {
    const v2 = fake([]);
    const host = await show(v2);
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Learn from a CSV")!.click(); });
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["q,a\nwhat is 2+2,4\nwhat is 3+3,6\n"], "rows.csv", { type: "text/csv" });
    file.text = async () => "q,a\nwhat is 2+2,4\nwhat is 3+3,6\n";
    Object.defineProperty(input, "files", { value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((r) => setTimeout(r, 10)); });
    expect(host.textContent).toContain("rows.csv: 2 rows, 2 columns");
    const learn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Learn")!;
    await act(async () => { learn.click(); });
    expect(v2.startLearningBatch).toHaveBeenCalledWith("ag", { inputs: ["q"], answer: "a", rows: [{ q: "what is 2+2", a: "4" }, { q: "what is 3+3", a: "6" }], max_cost_usd: 5 });
  });
});
