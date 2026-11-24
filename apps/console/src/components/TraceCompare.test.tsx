import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { route } from "@/App";
import { Race } from "@/components/Race";
import { RunTrace } from "@/components/RunTrace";
import { TRACE, TRACE_CLI, TRACE_END, TRACE_START, TRACE_USD } from "@/components/RunTrace.sample";
import { TraceCompare } from "@/components/TraceCompare";
import type { Client } from "@/lib/client";
import type { Run, RunTrace as Trace } from "@/lib/v2";

// The compare page (#/compare?runs=…): two to four runs' Dev tools figures side by side, and the two places that open it:
// a race's toolbar and a run's Dev tools tab.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; location.hash = ""; });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const run = (id: string, more: Partial<Run> = {}): Run => ({ sha: null, updated_at: new Date(TRACE_END).toISOString(), poll_after_ms: 0, place: { mode: "runner" }, run_id: id, agent_id: "supplier-screening", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: `Screen ${id}`,
  created_at: new Date(TRACE_START).toISOString(), ended_at: new Date(TRACE_END).toISOString(), result: null, error: null, cost: { usd: TRACE_USD, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, labels: {}, ...more }) as Run;
const RUNS: Record<string, { run: Run; trace: Trace }> = {
  run_a: { run: run("run_a"), trace: TRACE },
  run_b: { run: run("run_b", { cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null } }), trace: TRACE_CLI },
  run_c: { run: run("run_c", { status: "working", state: "working", ended_at: null }), trace: TRACE },
};
const v2 = () => ({ getRun: vi.fn(async (id: string) => { if (!RUNS[id]) throw new Error(`no run ${id}`); return RUNS[id].run; }), runTrace: vi.fn(async (id: string) => RUNS[id]!.trace) });
async function shown(ids: string[], client = v2()) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(TraceCompare, { v2: client, ids, now: TRACE_END })));
  await settle();
  return { host, client };
}
const table = (host: Element, section: string) => [...host.querySelectorAll(`section[aria-label='${section}'] tbody tr`)].map((tr) => [...tr.children].map((cell) => cell.textContent));

describe("the compare page", () => {
  it("is the page of an address that names its runs", () => {
    expect(route("#/compare?runs=run_a,run_b")).toEqual({ section: "runs", compare: ["run_a", "run_b"] });
    expect(route("#/compare")).toEqual({ section: "runs", compare: [] });
  });
  it("reads each run and its trace once, and says two runs' figures with the second against the first", async () => {
    const { host, client } = await shown(["run_a", "run_b"]);
    expect([client.getRun.mock.calls.map((c) => c[0]), client.runTrace.mock.calls.map((c) => c[0])]).toEqual([["run_a", "run_b"], ["run_a", "run_b"]]);
    const heads = [...host.querySelectorAll("section[aria-label='The runs in figures'] thead th")];
    expect(heads.map((th) => th.textContent)).toEqual(["Figure", "FirstScreen run_aCompleted", "SecondScreen run_bCompleted", "Second against first"]);
    // A run's name is a link to its own page.
    expect(heads[1]!.querySelector("a")!.getAttribute("href")).toBe("#/runs/run_a");
    const figures = table(host, "The runs in figures");
    expect(figures.map((row) => row[0])).toEqual(["Model requests", "Tool calls", "Failed", "Tokens", "Input read from cache", "Cost", "Time", "A model answering", "A tool running"]);
    // The CLI run's record keeps no model request and its cost is not one figure: unknown, with no difference said.
    expect(figures[0]).toEqual(["Model requests", "8", "–Not known", "–Not said"]);
    expect(figures[5]).toEqual(["Cost", "$0.6336", "–Not known", "–Not said"]);
    // Nor the time a model took answering, which that record does not keep: never 0 with −100% beside it.
    expect(figures[7]).toEqual(["A model answering", figures[7]![1], "–Not known", "–Not said"]);
    expect(figures[1]![1]).toBe("16");
    expect(figures[1]![3]).toMatch(/^[+−]\d+ \([+−]\d+%\)$|^Same$/);
    expect(host.querySelector("section[aria-label='By tool']")).toBeTruthy();
    expect(table(host, "By model")[0]![1]).toMatch(/^8 · [\d,]+ · \$0\.6132$/);
    // The CLI run may have used that model: its record keeps no request, so it is not said to be unused.
    expect(table(host, "By model")[0]![2]).toBe("Not recorded");
  });
  it("with three runs has a column a run and no difference, and says which are still going", async () => {
    const { host } = await shown(["run_a", "run_b", "run_c"]);
    expect([...host.querySelectorAll("section[aria-label='The runs in figures'] thead th")].map((th) => th.textContent!.slice(0, 5))).toEqual(["Figur", "Run 1", "Run 2", "Run 3"]);
    expect(host.querySelector("[data-difference]")).toBeNull();
    expect(host.querySelector("[role=status]")!.textContent).toBe("One of these runs is still going: its figures are as they stood when this page opened. Open the page again for newer ones.");
  });
  it("says a run's trace is its first spans only, its figures as at least, and no difference of them", async () => {
    RUNS.run_long = { run: run("run_long"), trace: { ...TRACE, spans: TRACE.spans.slice(0, 10), dropped: 14 } };
    const { host } = await shown(["run_a", "run_long"]);
    delete RUNS.run_long;
    expect(host.querySelector("[data-partial]")!.textContent).toBe("The second run's trace holds its first 10 requests and calls; 14 later ones are not counted. Its figures from the trace are at least what is shown, and no difference is said of them. Its cost is the run's own, not summed from the trace.");
    const figures = table(host, "The runs in figures");
    expect(figures[1]![2]).toMatch(/^at least \d+$/);
    expect(figures.filter((row) => row[0] !== "Cost").every((row) => row[3] === "–Not said")).toBe(true);
    // The run's cost is its own, whole: a difference of it is said.
    expect(figures[5]).toEqual(["Cost", "$0.6336", "$0.6336", "Same"]);
    // A tool the part read has no call of is not said to be uncalled.
    expect(table(host, "By tool").flatMap((row) => row.slice(2)).filter((cell) => cell === "Not called")).toEqual([]);
  });
  it("says what a comparison takes where the address names fewer than two runs, and reads none", async () => {
    const { host, client } = await shown(["run_a"]);
    expect(host.querySelector("[role=status]")!.textContent).toMatch(/^This address names one run\. A comparison takes two to four/);
    expect(client.getRun).not.toHaveBeenCalled();
  });
  it("a run that can't be read says so, with a way to try again", async () => {
    const { host, client } = await shown(["run_a", "run_gone"]);
    expect(host.querySelector("table")).toBeNull();
    const again = [...host.querySelectorAll("button")].find((b) => /again/i.test(b.textContent ?? ""));
    expect(again).toBeTruthy();
    RUNS.run_gone = RUNS.run_b!;
    await act(async () => { again!.click(); });
    await settle();
    delete RUNS.run_gone;
    expect(client.getRun.mock.calls.length).toBe(4);
    expect(host.querySelector("section[aria-label='The runs in figures']")).toBeTruthy();
  });
});

describe("what opens the compare page", () => {
  it("a race with two lanes or more links to its lanes' figures, in the lanes' order", async () => {
    const lane = (id: string, n: string) => run(id, { labels: { race: "bench-1", lane: n } });
    const client = { listRuns: vi.fn(async () => ({ runs: [lane("run_b", "2"), lane("run_a", "1")], next_cursor: null })), getRun: vi.fn(async (id: string) => lane(id, "1")), runTimeline: vi.fn(() => new Promise(() => {})), timeline: vi.fn(() => new Promise(() => {})) } as unknown as Client;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Race, { v2: client, label: "bench-1", rereadMs: 60_000 })));
    await settle();
    const link = [...host.querySelectorAll("a")].find((a) => a.textContent === "Compare in figures");
    expect(link?.getAttribute("href")).toBe("#/compare?runs=run_a,run_b");
  });
  it("a run's Dev tools tab asks for the other run, by its id or its page's address, and opens the two with this run first", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(RunTrace, { run: RUNS.run_a!.run, read: async () => TRACE, version: "1", live: false, now: TRACE_END })));
    await settle();
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Compare")!.click(); });
    await settle();
    const dialog = document.querySelector("[role=dialog]")!;
    const input = dialog.querySelector("input")!;
    const type = async (value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); };
    const go = async () => { await act(async () => { [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Compare")!.click(); }); await settle(); };
    // Nothing pasted, then this run itself: each is refused in words, and the page stays.
    await go();
    expect(dialog.textContent).toContain("Paste the other run's id, or its page's address.");
    await type("run_a");
    await go();
    expect(document.querySelector("[role=dialog]")!.textContent).toContain("That is this run. Name another one.");
    expect(location.hash).toBe("");
    // An address with a broken escape is refused in words too, never left with no answer.
    await type("https://console.example/#/runs/%");
    await go();
    expect(document.querySelector("[role=dialog]")!.textContent).toContain("That is not a run's id or its page's address.");
    await type("https://console.example/#/runs/run_b");
    await go();
    expect(location.hash).toBe("#/compare?runs=run_a,run_b");
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});
