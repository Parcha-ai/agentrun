import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Steps, WorkflowReplay } from "./WorkflowReplay";
import { ClientError, type Client } from "@/lib/client";
import { changeLine, replaySteps } from "@/lib/workflowReplay";
import type { WorkflowRevision, WorkflowRevisions } from "@/lib/v2";

// The learned-workflow replay (GET /v2/agents/{id}/learning/workflows/{name}/revisions): an invented invoice-sorter agent's
// workflow in three revisions: its first (one step), the run's instruction rewritten (EDITED), and a check step added (NEW).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); });

const step = (label: string, instructions: string) => ({ node: "extract", label, instructions, out: "Answer", as: label });
const flow = (steps: unknown[]) => JSON.stringify({ v: 2, name: "sorter", schemas: { Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } }, root: { node: "chain", steps } });
const rev = (n: number, text: string | null, by: WorkflowRevision["by"] = { run: `run_${n}` }): WorkflowRevision => ({ commit: String(n).repeat(40), at: new Date(Date.UTC(2026, 10, n, 14, 10)).toISOString(), by, reason: `reason ${n}`, text });
const REVS: WorkflowRevision[] = [
  rev(1, flow([step("classify", "Sort the invoice.")])),
  rev(2, flow([step("classify", "Sort the invoice by vendor.")])),
  rev(3, flow([step("classify", "Sort the invoice by vendor."), step("check", "Check the total.")]), { user: true }),
];
const read = (revisions: WorkflowRevision[], extra: Partial<WorkflowRevisions> = {}): WorkflowRevisions => ({ name: "sorter", revisions, total: revisions.length, truncated: false, ...extra });

function mount(node: Parameters<typeof createElement>[0], props: Record<string, unknown>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(node as never, props)));
  return host;
}
const line = (host: HTMLElement) => host.querySelector('[data-testid="replay-line"]')?.textContent;
const tags = (host: HTMLElement) => [...host.querySelectorAll("svg .tag")].map((t) => `${t.closest("g")?.getAttribute("data-path")}:${t.textContent}`);

describe("the replay's steps", () => {
  it("marks a node NEW where it first appears and EDITED where its prompt changed, each against the revision before", () => {
    const { steps, unreadable } = replaySteps(REVS);
    expect(unreadable).toBe(0);
    expect(steps.map((s) => s.line)).toEqual(['First version: 1 step', 'Edited "classify"', 'Added 1 step ("check")']);
    expect(steps[0]!.marks.diff).toMatchObject({ added: ["/root", "/root/steps/0"], edited: [] });
    expect(steps[1]!.marks.diff).toMatchObject({ added: [], edited: ["/root/steps/0"] });
    expect(steps[2]!.marks.diff).toMatchObject({ added: ["/root/steps/1"], edited: [] });
    expect(steps.map((s) => s.run)).toEqual(["run_1", "run_2", null]);
  });
  it("leaves out a revision that does not read as a workflow, and diffs the next against the last that did", () => {
    const { steps, unreadable } = replaySteps([REVS[0]!, rev(5, "not json"), rev(6, null), REVS[1]!]);
    expect(unreadable).toBe(2);
    expect(steps.map((s) => s.line)).toEqual(["First version: 1 step", 'Edited "classify"']);
  });
  it("says a revision that changed no node so, and names at most three labels", () => {
    expect(replaySteps([REVS[0]!, rev(2, flow([step("classify", "Sort the invoice.")]).replace("sorter", "renamed"))]).steps[1]!.line).toBe("No step changed");
    expect(changeLine(["a", "b", "c", "d", "e"], [], [], 0, 0)).toBe('Added 5 steps ("a", "b", "c" and 2 more)');
    expect(changeLine([], ["x"], ["y"], 0, 0)).toBe('Edited "x", removed 1 step ("y")');
  });
});

describe("the replay", () => {
  it("opens on the newest revision with its date, its author and its NEW node, and steps back to the EDITED one", () => {
    const host = mount(Steps, { data: read(REVS) });
    expect(host.textContent).toContain("Revision 3 of 3");
    expect(host.textContent).toContain("Nov 3");
    expect(host.textContent).toContain("a person");
    expect(line(host)).toBe('Added 1 step ("check")');
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
    const host = mount(Steps, { data: read(REVS), stepMs: 100 });
    const play = () => host.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    act(() => play().click());
    expect(line(host)).toBe("First version: 1 step");
    expect(play().getAttribute("aria-label")).toBe("Pause the replay");
    act(() => { vi.advanceTimersByTime(100); });
    expect(line(host)).toBe('Edited "classify"');
    act(() => play().click());
    act(() => { vi.advanceTimersByTime(500); });
    expect(line(host)).toBe('Edited "classify"');
    act(() => play().click());
    act(() => { vi.advanceTimersByTime(300); });
    expect(line(host)).toBe('Added 1 step ("check")');
    expect(play().getAttribute("aria-pressed")).toBe("false");
  });
  it("shows a lone revision as a graph with no controls", () => {
    const host = mount(Steps, { data: read([REVS[0]!]) });
    expect(host.querySelector('input[type="range"]')).toBeNull();
    expect(host.textContent).toContain("One revision");
    expect(tags(host).every((t) => t.endsWith(":NEW"))).toBe(true);
  });
  it("says when it shows only the latest revisions, and when none reads", () => {
    expect(mount(Steps, { data: read(REVS, { total: 90, truncated: true }) }).textContent).toContain("The latest 3 of 90 revisions. Older changes are past the log this server keeps.");
    act(() => root!.unmount());
    expect(mount(Steps, { data: read([rev(1, "{}")]) }).textContent).toContain("can't be read as a workflow: 1 revision did not read");
  });
});

describe("the replay of an agent's learned workflows", () => {
  const client = (answer: () => Promise<WorkflowRevisions>) => ({ learnedWorkflowRevisions: vi.fn(answer) }) as unknown as Client & { learnedWorkflowRevisions: ReturnType<typeof vi.fn> };
  const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
  it("reads the first active workflow and draws it; draws nothing when none is active", async () => {
    const v2 = client(async () => read(REVS));
    const none = mount(WorkflowReplay, { v2, agentId: "a", workflows: [{ name: "old", status: "retired" }, { name: "held", status: "pending" }] });
    await flush();
    expect(none.textContent).toBe("");
    expect(v2.learnedWorkflowRevisions).not.toHaveBeenCalled();
    act(() => root!.unmount());
    const host = mount(WorkflowReplay, { v2, agentId: "a", workflows: [{ name: "old", status: "retired" }, { name: "sorter", status: "active" }] });
    await flush();
    expect(v2.learnedWorkflowRevisions).toHaveBeenCalledWith("a", "sorter", 50);
    expect(host.textContent).toContain("How the workflow changed");
    expect(line(host)).toBe('Added 1 step ("check")');
    expect(host.querySelector('[role="combobox"], button[aria-haspopup="listbox"]')).toBeNull();
  });
  it("names a failed read and reads again on Try again", async () => {
    let fail = true;
    const v2 = client(async () => { if (fail) throw new ClientError(503, "unavailable", "The folder is busy.", true); return read(REVS); });
    const host = mount(WorkflowReplay, { v2, agentId: "a", workflows: [{ name: "sorter", status: "active" }] });
    await flush();
    expect(host.textContent).toContain("Try again");
    fail = false;
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!.click());
    await flush();
    expect(line(host)).toBe('Added 1 step ("check")');
  });
});
