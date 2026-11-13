import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Steps, WorkflowReplay } from "./WorkflowReplay";
import { ClientError, type Client } from "@/lib/client";
import { changeLine, replaySteps } from "@/lib/workflowReplay";
import type { LearningLoop, Promotion, WorkflowRevision, WorkflowRevisions } from "@/lib/v2";

// The learned-workflow replay (GET /v2/agents/{id}/learning/workflows/{name}/revisions): an invented invoice-sorter agent's
// workflow in three revisions: its first (one step), the run's instruction rewritten (EDITED), and a check step added (NEW).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); });

const step = (label: string, instructions: string) => ({ node: "extract", label, instructions, out: "Answer", as: label });
const flow = (steps: unknown[]) => JSON.stringify({ v: 2, name: "sorter", schemas: { Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } }, root: { node: "chain", steps } });
const rev = (n: number, text: string | null, by: WorkflowRevision["by"] = { run: `run_${n}` }): WorkflowRevision => ({ commit: String(n).repeat(40), at: new Date(Date.UTC(2026, 10, n, 14, 10)).toISOString(), by, reason: `reason ${n}`, text, digest: text === null ? null : String(n).repeat(16) });
const REVS: WorkflowRevision[] = [
  rev(1, flow([step("classify", "Sort the invoice.")])),
  rev(2, flow([step("classify", "Sort the invoice by vendor.")])),
  rev(3, flow([step("classify", "Sort the invoice by vendor."), step("check", "Check the total.")]), { user: true }),
];
const read = (revisions: WorkflowRevision[], extra: Partial<WorkflowRevisions> = {}): WorkflowRevisions => ({ name: "sorter", revisions, total: revisions.length, truncated: false, ...extra });

function mount(element: ReactElement) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}
const line = (host: HTMLElement) => host.querySelector('[data-testid="replay-line"]')?.textContent;
const tags = (host: HTMLElement) => [...host.querySelectorAll("svg .tag")].map((t) => `${t.closest("g")?.getAttribute("data-path")}:${t.textContent}`);

describe("the replay's steps", () => {
  it("marks a node NEW where it first appears and EDITED where its prompt changed, each against the revision before", () => {
    const { steps, unreadable } = replaySteps(REVS);
    expect(unreadable).toBe(0);
    expect(steps.map((s) => s.line)).toEqual(['First version: 1 node', 'Edited "classify"', 'Added 1 node ("check")']);
    expect(steps[0]!.marks.diff).toMatchObject({ added: ["/root", "/root/steps/0"], edited: [] });
    expect(steps[1]!.marks.diff).toMatchObject({ added: [], edited: ["/root/steps/0"] });
    expect(steps[2]!.marks.diff).toMatchObject({ added: ["/root/steps/1"], edited: [] });
    expect(steps.map((s) => s.run)).toEqual(["run_1", "run_2", null]);
  });
  it("leaves out a revision that does not read as a workflow, and diffs the next against the last that did", () => {
    const { steps, unreadable } = replaySteps([REVS[0]!, rev(5, "not json"), rev(6, null), REVS[1]!]);
    expect(unreadable).toBe(2);
    expect(steps.map((s) => s.line)).toEqual(["First version: 1 node", 'Edited "classify"']);
  });
  it("says a revision that changed no node so, and names at most three labels", () => {
    expect(replaySteps([REVS[0]!, rev(2, flow([step("classify", "Sort the invoice.")]).replace("sorter", "renamed"))]).steps[1]!.line).toBe("No node changed");
    expect(changeLine(["a", "b", "c", "d", "e"], [], [], 0, 0)).toBe('Added 5 nodes ("a", "b", "c" and 2 more)');
    expect(changeLine([], ["x"], ["y"], 0, 0)).toBe('Edited "x", removed 1 node ("y")');
  });
});

describe("the replay", () => {
  it("opens on the newest revision with its date, its author and its NEW node, and steps back to the EDITED one", () => {
    const host = mount(createElement(Steps, { data: read(REVS) }));
    expect(host.textContent).toContain("Revision 3 of 3");
    expect(host.textContent).toContain("Nov 3");
    expect(host.textContent).toContain("a person");
    expect(line(host)).toBe('Added 1 node ("check")');
    expect(tags(host)).toEqual(["/root/steps/1:NEW"]);
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.getAttribute("aria-valuetext")).toMatch(/^Revision 3 of 3, Nov 3/);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Previous revision"]')!.click());
    expect(line(host)).toBe('Edited "classify"');
    expect(tags(host)).toEqual(["/root/steps/0:EDITED"]);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("#/runs/run_2");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Previous revision"]')!.disabled).toBe(false);
  });
  it("plays from the first revision to the newest and stops there, and Pause stops it", () => {
    const host = mount(createElement(Steps, { data: read(REVS), stepMs: 100 }));
    const play = () => host.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    act(() => play().click());
    expect(line(host)).toBe("First version: 1 node");
    expect(play().getAttribute("aria-label")).toBe("Pause the replay");
    act(() => { vi.advanceTimersByTime(100); });
    expect(line(host)).toBe('Edited "classify"');
    act(() => play().click());
    act(() => { vi.advanceTimersByTime(500); });
    expect(line(host)).toBe('Edited "classify"');
    act(() => play().click());
    act(() => { vi.advanceTimersByTime(300); });
    expect(line(host)).toBe('Added 1 node ("check")');
    expect(play().getAttribute("aria-pressed")).toBe("false");
  });
  it("shows a lone revision as a graph with no controls", () => {
    const host = mount(createElement(Steps, { data: read([REVS[0]!]) }));
    expect(host.querySelector('input[type="range"]')).toBeNull();
    expect(host.textContent).toContain("One revision");
    expect(tags(host).every((t) => t.endsWith(":NEW"))).toBe(true);
  });
  it("says when it shows only the latest revisions, and when none reads", () => {
    expect(mount(createElement(Steps, { data: read(REVS, { total: 90, truncated: true }) })).textContent).toContain("The latest 3 of 90 revisions. Older changes are past the log this server keeps.");
    act(() => root!.unmount());
    expect(mount(createElement(Steps, { data: read([rev(1, "{}")]) })).textContent).toContain("can't be read as a workflow: 1 revision did not read");
  });
});

describe("the replay of an agent's learned workflows", () => {
  const client = (answer: () => Promise<WorkflowRevisions>) => ({ learnedWorkflowRevisions: vi.fn(answer) }) as unknown as Client & { learnedWorkflowRevisions: ReturnType<typeof vi.fn> };
  const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
  it("reads the first active workflow and draws it; draws nothing when none is active", async () => {
    const v2 = client(async () => read(REVS));
    const none = mount(createElement(WorkflowReplay, { v2, agentId: "a", workflows: [{ name: "old", status: "retired" }, { name: "held", status: "pending" }] }));
    await flush();
    expect(none.textContent).toBe("");
    expect(v2.learnedWorkflowRevisions).not.toHaveBeenCalled();
    act(() => root!.unmount());
    const host = mount(createElement(WorkflowReplay, { v2, agentId: "a", workflows: [{ name: "old", status: "retired" }, { name: "sorter", status: "active" }] }));
    await flush();
    expect(v2.learnedWorkflowRevisions).toHaveBeenCalledWith("a", "sorter", 50);
    expect(host.textContent).toContain("Learned workflow");
    expect(host.querySelector('[aria-label="Learned workflow"] h2')?.textContent).toContain("sorter");
    expect(line(host)).toBe('Added 1 node ("check")');
    expect(host.querySelector('[role="combobox"], button[aria-haspopup="listbox"]')).toBeNull();
  });
  it("names a failed read and reads again on Try again", async () => {
    let fail = true;
    const v2 = client(async () => { if (fail) throw new ClientError(503, "unavailable", "The folder is busy.", true); return read(REVS); });
    const host = mount(createElement(WorkflowReplay, { v2, agentId: "a", workflows: [{ name: "sorter", status: "active" }] }));
    await flush();
    expect(host.textContent).toContain("Try again");
    fail = false;
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!.click());
    await flush();
    expect(line(host)).toBe('Added 1 node ("check")');
  });
});

describe("the workflow card: standing, guards and where it is unsure", () => {
  const guarded = (threshold: number, fit?: object) => JSON.stringify({ v: 2, name: "sorter", schemas: { Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } }, root: { node: "chain", steps: [
    { ...step("classify", "Sort the invoice."), guard: { signal: "jev", threshold, ...(fit ? { fit } : {}) } },
    { ...step("check", "Check the total."), guard: { signal: "both", threshold: 0.6 } },
  ] } });
  const REVS2: WorkflowRevision[] = [rev(1, guarded(0.7)), rev(2, guarded(0.82, { w: [1], b: 0, n: 40 }))];
  const record = (over: Partial<Promotion>): Promotion => ({ workflow: "sorter", digest: "1".repeat(16), at: "2026-11-02T10:00:00Z", decided: "promote", source: "replay", reason: "as good as the agent on its graded inputs", replay: { of: [], n: 20, agree: 19, agent_acc: 0.9, wf_acc: 0.95, delta: 0.05, handed_back: 2 }, ...over } as Promotion);
  const point = (p: number | null, correct: boolean | null, i: number) => ({ run_id: `r${i}`, p, escalated: p === null || p < 0.7, correct });
  const loop: LearningLoop = { agent: "a", compiles: [], guards: [
    { workflow: "sorter", digest: "1".repeat(16), node: "classify", signal: "jev", threshold: 0.7, runs: 5, escalated: 2, right: 2, wrong: 1, replays: 0, points: [point(0.95, true, 1), point(0.91, true, 2), point(0.75, false, 3), point(0.4, null, 4), point(null, null, 5)] },
  ] } as LearningLoop;

  it("says where each revision stands, with its replay in one line; scrubbing moves it", () => {
    const promotions = [record({}), record({ digest: "2".repeat(16), at: "2026-11-03T10:00:00Z", decided: "promote", source: "refit", refit: { from: "1".repeat(16), guards: [{ node: "classify", was: 0.7, threshold: 0.82 }] } })];
    const host = mount(createElement(Steps, { data: read(REVS2), promotions, serving: "2".repeat(16), loop }));
    const standing = () => host.querySelector('[data-testid="standing"]')?.textContent;
    expect(standing()).toContain("Serving");
    expect(standing()).toContain("Refit on 20 graded inputs: workflow 95% vs agent 90% (+5 pts), 2 handed back");
    expect(host.querySelector('[data-testid="refit"]')?.textContent).toBe("Thresholds refit from 1111111: classify 0.70 → 0.82");
    act(() => (host.querySelector('button[aria-label="Previous revision"]') as HTMLButtonElement).click());
    expect(standing()).toBe("RefitIts thresholds were refit: revision 2222222 serves in its place.");
    expect(host.querySelector('[data-testid="refit"]')).toBeNull();
  });

  it("an older promoted revision says it served, not that it serves", () => {
    const promotions = [record({}), record({ digest: "2".repeat(16), at: "2026-11-03T10:00:00Z", replay: undefined, source: "dry_run", reason: "promoted on its dry run" })];
    const host = mount(createElement(Steps, { data: read(REVS2), promotions, serving: "2".repeat(16), loop }));
    act(() => (host.querySelector('button[aria-label="Previous revision"]') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("Served");
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("Replay on 20 graded inputs");
  });

  it("champion/challenger: the newest revision replaying or held says so, and the one before it is the one serving", () => {
    const two = "2".repeat(16);
    for (const decided of ["replaying", "hold"] as const) {
      const promotions = [record({}), record({ digest: two, at: "2026-11-03T10:00:00Z", decided, replay: undefined, reason: decided === "hold" ? "worse than the agent" : "replaying on graded inputs" })];
      const host = mount(createElement(Steps, { data: read(REVS2), promotions, serving: "1".repeat(16), loop }));
      const standing = () => host.querySelector('[data-testid="standing"]')?.textContent;
      expect(standing()).toContain(decided === "hold" ? "Held" : "Replaying");
      act(() => (host.querySelector('button[aria-label="Previous revision"]') as HTMLButtonElement).click());
      expect(standing()).toContain("Serving");
    }
  });

  it("puts each step's guard on its card and lists its hand-backs and p by grade", () => {
    const host = mount(createElement(Steps, { data: read([REVS2[0]!]), promotions: [record({ decided: "hold", reason: "worse than the agent" , replay: undefined })], loop }));
    expect([...host.querySelectorAll("svg .verdict")].map((v) => v.textContent)).toEqual(["jev ≥0.70", "self+jev ≥0.60"]);
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("Held");
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("worse than the agent");
    const rows = [...host.querySelectorAll('[data-testid="guard-row"]')].map((r) => r.textContent);
    expect(rows[0]).toContain("40% handed back (2 of 5 runs) · graded 2 right, 1 wrong");
    expect(rows[1]).toContain("No run of this revision yet.");
    expect(host.querySelectorAll('[data-testid="guard-histogram"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="guard-histogram"] figcaption')?.textContent).toContain("p 0.0 to 0.1: 1 not graded");
  });

  it("a step's graded counts are every run's (the server's), and its p is said to be the newest runs' once older ones are left out", () => {
    const many: LearningLoop = { agent: "a", compiles: [], guards: [
      { workflow: "sorter", digest: "1".repeat(16), node: "classify", signal: "jev", threshold: 0.7, runs: 205, escalated: 5, right: 0, wrong: 5, replays: 0, points: Array.from({ length: 200 }, (_, i) => point(0.9, null, i)) },
    ] } as LearningLoop;
    const host = mount(createElement(Steps, { data: read([REVS2[0]!]), promotions: [record({})], loop: many }));
    const row = host.querySelector('[data-testid="guard-row"]')!.textContent;
    expect(row).toContain("2% handed back (5 of 205 runs) · graded 0 right, 5 wrong");
    expect(row).not.toContain("none graded");
    expect(row).toContain("p of the newest 200 runs");
  });

  it("a revision only replayed says so, never a hand-back rate read at the replay's record-only threshold", () => {
    const replayed: LearningLoop = { agent: "a", compiles: [], guards: [
      { workflow: "sorter", digest: "1".repeat(16), node: "classify", signal: "jev", threshold: null, runs: 0, escalated: 0, right: 0, wrong: 0, replays: 3, points: [] },
    ] } as LearningLoop;
    const host = mount(createElement(Steps, { data: read([REVS2[0]!]), promotions: [record({ decided: "replaying", replay: undefined })], loop: replayed }));
    expect(host.querySelector('[data-testid="guard-row"]')!.textContent).toContain("Replayed on 3 graded inputs; no run served yet.");
  });

  it("a revision with no record yet says it replays before it serves; one with no guard has no list", () => {
    const host = mount(createElement(Steps, { data: read([REVS[0]!]) }));
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("Not decided");
    expect(host.querySelector('[data-testid="step-guards"]')).toBeNull();
  });
});
