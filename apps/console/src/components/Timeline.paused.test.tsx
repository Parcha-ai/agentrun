import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import { rowFailed, rowPaused } from "@/lib/timeline";
import type { TimelineRow } from "@/lib/v2";

// A request the run's spend cap couldn't cover is not sent, and the run pauses (budget). The server marks the pause with
// a row of its own: kind "phase", origin "server", id "<refusal row id>:note", `paused: true`, summary and text "Paused at
// the run's cap". The same row, under the same id, is served while paused, after a raise, on a re-read and after a
// restart. While paused a waiting row follows it ("Waiting for you to raise the cap", no `paused`); after a raise that
// row is gone and the pause row stays. The console reads it as any server row (AgentRun, the served summary, muted) with
// a pause icon, and nothing red. A request that failed at the cap is kind "error" with no `paused`: an error, in red.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

// The banner's sentence (serve's cap refusal, pending.said), verbatim: the row never repeats it.
const WORDS = "Not sent: the next step needs at least $0.11, and this run's cap is $0.05. Raise the cap to at least $0.11 to continue.";
const WAITING = "Waiting for you to raise the cap";
const row = (over: Partial<TimelineRow> & Record<string, unknown>): TimelineRow => ({ id: "e1", seq: 2, kind: "error", summary: WORDS, text: null, timestamp: "2026-11-05T17:09:00Z", tool_name: null, ...over } as TimelineRow);
/** The pause row, as served. */
const PAUSED_SAYS = "Paused at the run's cap";
const pausedRow = (over: Record<string, unknown> = {}): TimelineRow => row({ id: "e1:note", seq: 2, kind: "phase", origin: "server", paused: true, summary: PAUSED_SAYS, text: PAUSED_SAYS, ...over });
const waitingRow = (): TimelineRow => row({ id: "e1:paused", seq: 3, kind: "waiting", summary: WAITING, text: WAITING });
const red = (el: Element) => [el, ...el.querySelectorAll("*")].some((e) => /\b(text|border|bg)-destructive/.test(e.getAttribute("class") ?? ""));

// The waiting row's chip says what the run waits on, from the run's own pending.kind (rows carry no kind of their own:
// serve's TimelineRow has none), as the run header's status chip does: a cap pause "Paused at cap", an approval
// "Approval required", anything else "Input required". Only the run's current wait, its newest waiting row.
describe("the waiting row's chip, by what the run waits on", () => {
  const waiting = (id: string, seq: number, summary: string): TimelineRow => row({ id, seq, kind: "waiting", summary });
  const chips = (rows: TimelineRow[], waitingOn?: string) => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Timeline, { rows, live: false, ...(waitingOn ? { waitingOn } : {}) } as never)));
    return [...host.querySelectorAll("li")].map((li) => (li.textContent ?? "").match(/Paused at cap|Approval required|Input required/)?.[0] ?? null);
  };
  it("a cap pause reads Paused at cap", () => {
    expect(chips([waiting("w1", 3, WAITING)], "budget")).toEqual(["Paused at cap"]);
  });
  it("an approval relabels no waiting row: its own row carries Approval required, and an answered question keeps its chip", () => {
    // An approval waits on a tool_approval_requested row (its own chip), never a `waiting` one: a question asked and
    // answered before it is history, not the approval.
    const approvalRow = row({ id: "a1", seq: 4, kind: "tool_approval_requested", summary: "Waiting for your approval: web_fetch", tool_name: "web_fetch" } as never);
    expect(chips([waiting("w0", 3, "Asked you: which?"), approvalRow], "approval")).toEqual(["Input required", "Approval required"]);
  });
  it("a question, or a run not waiting now, reads Input required, and an earlier wait keeps its own", () => {
    expect(chips([waiting("w1", 3, "Asked you: which?")], "question")).toEqual(["Input required"]);
    expect(chips([waiting("w0", 2, "Asked you: which?"), waiting("w1", 3, WAITING)], "budget")).toEqual(["Input required", "Paused at cap"]);
    expect(chips([waiting("w1", 3, WAITING)])).toEqual(["Input required"]);
  });
});

describe("the run page passes the run's pending.kind to its timeline", () => {
  it("a run paused at its cap: its waiting row reads Paused at cap", async () => {
    const { RunDetail } = await import("./RunDetail");
    const { messageFeatures, runFixture } = await import("@/fixtures");
    const f = runFixture("run.completed.idle.1");
    const run = { ...f.run, kind: "agentic", status: "input_required", state: "waiting", result: null, pending: { kind: "budget", cap_usd: 0.05, said: WORDS, at: "2026-11-05T17:09:00Z" } };
    const rows = [pausedRow(), waitingRow()];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(RunDetail, { run, agentName: "capped", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, tab: "timeline" } as never)));
    const waitingLi = [...host.querySelectorAll("ol > li")].find((li) => (li.textContent ?? "").includes(WAITING))!;
    expect(waitingLi.textContent).toContain("Paused at cap");
    // The waiting row's words are the server's, as served.
    expect(waitingLi.textContent).toContain(WAITING);
    expect(waitingLi.textContent).not.toContain("Input required");
  });
});

describe("the timeline, the pause row the server writes for a request the spend cap held back", () => {
  const draws = (rows: TimelineRow[], live = false) => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Timeline, { rows, live })));
    return [...host.querySelectorAll("ol > li")] as HTMLElement[];
  };
  const warning = (el: Element) => [el, ...el.querySelectorAll("*")].some((e) => /\b(text|border|bg)-warning/.test(e.getAttribute("class") ?? ""));
  /** The row's title line: the served summary, as the timeline shows a row's words. */
  const titleOf = (li: Element) => [...li.querySelectorAll("span.block")].find((e) => /text-\[15px\]/.test(e.getAttribute("class") ?? ""));

  it("reads as a server row: AgentRun, the served summary as its title, muted, with a pause icon, no warning border and nothing red", () => {
    const [li] = draws([pausedRow()]);
    expect(li.textContent).toContain("AgentRun");
    expect(titleOf(li)?.textContent).toBe(PAUSED_SAYS);
    expect(titleOf(li)?.className).toContain("text-muted-foreground");
    expect(li.querySelector(".lucide-circle-pause")).not.toBeNull();
    expect(warning(li)).toBe(false);
    expect(red(li)).toBe(false);
    expect(li.textContent).not.toMatch(/Error/);
    // The console adds no words of its own: not the old "Paused at its spend cap", not the banner's sentence.
    expect(li.textContent).not.toContain("Paused at its spend cap");
    expect(li.textContent).not.toContain(WORDS);
  });

  it("is no failure to the rest of the page (a failure's count, its repeats); it is the pause", () => {
    expect(rowFailed(pausedRow())).toBe(false);
    expect(rowPaused(pausedRow())).toBe(true);
    expect(rowPaused(row({ kind: "phase", origin: "server", id: "x:note", summary: "Spent $0.01 so far" }))).toBe(false);
  });

  it("while paused, the waiting row follows it and carries the cap's chip", () => {
    const lis = draws([pausedRow(), waitingRow()]);
    expect(lis).toHaveLength(2);
    expect(lis[1].textContent).toContain(WAITING);
  });

  it("after a raise: the same row, the same look, and no waiting row; the raise's message follows it", () => {
    const raised = row({ id: "u2", seq: 3, kind: "user_message", summary: "The cap was raised to $2; continue the task.", text: "The cap was raised to $2; continue the task." });
    const lis = draws([pausedRow(), raised], true);
    expect(lis[0].textContent).toContain(PAUSED_SAYS);
    expect(lis[0].querySelector(".lucide-circle-pause")).not.toBeNull();
    expect(warning(lis[0])).toBe(false);
    expect(red(lis[0])).toBe(false);
    expect(lis.some((li) => (li.textContent ?? "").includes("Waiting for you"))).toBe(false);
    expect(lis.some((li) => (li.textContent ?? "").includes("Paused at cap"))).toBe(false);
  });

  it("says its words once: no chevron and no expand, since its text is its title", async () => {
    const [li] = draws([pausedRow()]);
    expect(li.querySelector(".lucide-chevron-right")).toBeNull();
    const button = li.querySelector("button")!;
    expect(button.disabled).toBe(true);
    await act(async () => { button.click(); });
    expect(li.querySelector("pre")).toBeNull();
    expect((li.textContent ?? "").split(PAUSED_SAYS).length - 1).toBe(1);
  });

  it("a server phase row whose text says more than its title still opens it", async () => {
    const more = row({ id: "p1:note", kind: "phase", origin: "server", summary: "Spent $0.01 so far", text: "Spent $0.01 so far: 2 model requests, 1 paid tool call." });
    const [li] = draws([more]);
    expect(li.querySelector(".lucide-chevron-right")).not.toBeNull();
    await act(async () => { li.querySelector("button")!.click(); });
    expect(li.querySelector("pre")?.textContent).toBe("Spent $0.01 so far: 2 model requests, 1 paid tool call.");
  });

  it("a request that failed at the cap (kind error, no paused) is an error, in red, with no pause icon", () => {
    const failedAtCap = row({ summary: "Not sent: the next step needs at least $0.11, and this run's cap is $0.05." });
    const [li] = draws([failedAtCap]);
    expect(li.textContent).toMatch(/Error/);
    expect(red(li)).toBe(true);
    expect(li.querySelector(".lucide-circle-pause")).toBeNull();
    expect(rowFailed(failedAtCap)).toBe(true);
    expect(rowPaused(failedAtCap)).toBe(false);
  });

  it("an error the server doesn't mark paused is still an error, in red", () => {
    const [li] = draws([row({ summary: "Model request failed: 529 overloaded" })]);
    expect(li.textContent).toMatch(/Error/);
    expect(red(li)).toBe(true);
  });
});
