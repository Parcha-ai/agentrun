import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Steps, WorkflowReplay } from "./WorkflowReplay";
import { ClientError, type Client } from "@/lib/client";
import { changeLine, replaySteps } from "@/lib/workflowReplay";
import type { Promotion, WorkflowRevision, WorkflowRevisions } from "@/lib/v2";

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
    const host = mount(createElement(WorkflowReplay, { v2, agentId: "a", workflows: [{ name: "old", status: "retired" }, { name: "sorter", status: "serving" }] }));
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
    const host = mount(createElement(WorkflowReplay, { v2, agentId: "a", workflows: [{ name: "sorter", status: "serving" }] }));
    await flush();
    expect(host.textContent).toContain("Try again");
    fail = false;
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!.click());
    await flush();
    expect(line(host)).toBe('Added 1 node ("check")');
  });
});

describe("the workflow card: standing", () => {
  const two = (instructions: string) => flow([step("classify", instructions), step("check", "Check the total.")]);
  const REVS2: WorkflowRevision[] = [rev(1, two("Sort the invoice.")), rev(2, two("Sort the invoice by vendor."))];
  const CHECK = { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1 as const, n: 20, agreed: 17, alone: 18, of: [] as string[], outcomes: { answered: 18, handed_back: 2, failed: 0, skipped_write: 0 } };
  const record = (over: Partial<Promotion>): Promotion => ({ workflow: "sorter", digest: "1".repeat(16), at: "2026-11-02T10:00:00Z", decided: "promote", reason: "as good as the agent on the inputs of its own runs", check: CHECK, ...over } as Promotion);

  it("says where each revision stands, with its check in one line; scrubbing moves it", () => {
    const promotions = [record({}), record({ digest: "2".repeat(16), at: "2026-11-03T10:00:00Z", decided: "promote", check: undefined, reason: "approved by its owner" })];
    const host = mount(createElement(Steps, { data: read(REVS2), promotions, serving: "2".repeat(16) }));
    const standing = () => host.querySelector('[data-testid="standing"]')?.textContent;
    expect(standing()).toContain("Serving");
    expect(standing()).toContain("approved by its owner");
    act(() => (host.querySelector('button[aria-label="Previous revision"]') as HTMLButtonElement).click());
    expect(standing()).toContain("Served");
    expect(standing()).toContain("Checked on 20 inputs of the agent's own runs: 18 answered alone (90%, 70% needed), 17 of those said what the agent said (94%, 80% needed), 2 handed back");
  });

  // One promoted on its check says how many inputs it was decided on, in green; one held because its check had nothing
  // to run on says no count, and its reason.
  it("says what a standing was decided on: checked on n inputs, or the reason when the check ran on none", () => {
    const checked = mount(createElement(Steps, { data: read([REVS2[0]!]), promotions: [record({ check: { ...CHECK, n: 18, alone: 17 } })], serving: "1".repeat(16) }));
    const chip = (host: HTMLElement) => host.querySelector('[data-testid="standing"] span')!;
    expect(chip(checked).textContent).toBe("Serving · checked on 18 inputs · 17 alone");
    expect(chip(checked).className).toMatch(/success/);
    const none = mount(createElement(Steps, { data: read([REVS2[0]!]), promotions: [record({ decided: "hold", check: { ...CHECK, n: 0, agreed: 0, alone: 0, stopped: true }, reason: "nothing to check it on: it stops" })], serving: null }));
    expect(chip(none).textContent).toBe("Held");
    expect(chip(none).className).not.toMatch(/success/);
    expect(none.querySelector('[data-testid="standing"]')?.textContent).toContain("nothing to check it on: it stops");
  });

  it("an older promoted revision says it served, not that it serves", () => {
    const promotions = [record({}), record({ digest: "2".repeat(16), at: "2026-11-03T10:00:00Z", check: undefined, reason: "approved by its owner" })];
    const host = mount(createElement(Steps, { data: read(REVS2), promotions, serving: "2".repeat(16) }));
    act(() => (host.querySelector('button[aria-label="Previous revision"]') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("Served");
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("Checked on 20 inputs");
  });

  it("champion/challenger: the newest revision replaying or held says so, and the one before it is the one serving", () => {
    const second = "2".repeat(16);
    for (const decided of ["replaying", "hold"] as const) {
      const promotions = [record({}), record({ digest: second, at: "2026-11-03T10:00:00Z", decided, check: undefined, reason: decided === "hold" ? "worse than the agent" : "being checked" })];
      const host = mount(createElement(Steps, { data: read(REVS2), promotions, serving: "1".repeat(16) }));
      const standing = () => host.querySelector('[data-testid="standing"]')?.textContent;
      expect(standing()).toContain(decided === "hold" ? "Held" : "Replaying");
      act(() => (host.querySelector('button[aria-label="Previous revision"]') as HTMLButtonElement).click());
      expect(standing()).toContain("Serving");
    }
  });

  it("a held revision says Held and its reason", () => {
    const host = mount(createElement(Steps, { data: read([REVS2[0]!]), promotions: [record({ decided: "hold", reason: "worse than the agent", check: undefined })] }));
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("Held");
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("worse than the agent");
  });

  // Review on #2654: the money rule stops a serving revision from running first without a promotion record; the cost
  // read's needs_revision says so, and the card follows it.
  it("the champion the money rule stopped says Stopped, not Serving", () => {
    const host = mount(createElement(Steps, { data: read([REVS2[0]!]), promotions: [record({})], serving: "1".repeat(16), stopped: "1".repeat(16) }));
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("Stopped");
    expect(host.querySelector('[data-testid="standing"]')?.textContent).not.toContain("Serving");
  });

  it("a revision with no record yet says it is checked before it serves", () => {
    const host = mount(createElement(Steps, { data: read([REVS[0]!]) }));
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("Not decided");
    expect(host.querySelector('[data-testid="standing"]')?.textContent).toContain("is checked on the inputs of the agent's own runs before it serves");
  });
});
