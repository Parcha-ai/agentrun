import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import { rowFailed } from "@/lib/timeline";
import type { TimelineRow } from "@/lib/v2";

// A request the run's spend cap couldn't cover is not sent, and the run pauses (budget). Its timeline row keeps kind
// "error" and says `paused: true` (tl-jobs' serve/cap-words: pi-durable-agent TimelineEvent.paused, serve's
// TimelineRow.paused): it reads as a pause, labelled "Paused", in the warning tone, with the server's words, and no red.
// A raise doesn't turn it back into an error: the row says what happened then.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const WORDS = "Not sent: this run's cap of $0.05 can't cover one faux-1 request (at least $0.11). Raise the cap to at least $0.11 to run it.";
const row = (over: Partial<TimelineRow> & Record<string, unknown>): TimelineRow => ({ id: "e1", seq: 2, kind: "error", summary: WORDS, text: null, timestamp: "2026-11-05T17:09:00Z", tool_name: null, ...over } as TimelineRow);
const draw = (r: TimelineRow, live = false) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Timeline, { rows: [r], live })));
  return host.querySelector("li") as HTMLElement;
};
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
    expect(chips([waiting("w1", 3, "Paused at the run's $0.05 cap: Not sent")], "budget")).toEqual(["Paused at cap"]);
  });
  it("an approval reads Approval required", () => {
    expect(chips([waiting("w1", 3, "Waiting for your approval")], "approval")).toEqual(["Approval required"]);
  });
  it("a question, or a run not waiting now, reads Input required, and an earlier wait keeps its own", () => {
    expect(chips([waiting("w1", 3, "Asked you: which?")], "question")).toEqual(["Input required"]);
    expect(chips([waiting("w0", 2, "Asked you: which?"), waiting("w1", 3, "Paused at the run's cap")], "budget")).toEqual(["Input required", "Paused at cap"]);
    expect(chips([waiting("w1", 3, "Paused at the run's cap")])).toEqual(["Input required"]);
  });
});

describe("the run page passes the run's pending.kind to its timeline", () => {
  it("a run paused at its cap: its waiting row reads Paused at cap", async () => {
    const { RunDetail } = await import("./RunDetail");
    const { messageFeatures, runFixture } = await import("@/fixtures");
    const f = runFixture("run.completed.idle.1");
    const run = { ...f.run, kind: "agentic", status: "input_required", state: "waiting", result: null, pending: { kind: "budget", cap_usd: 0.05, said: WORDS, at: "2026-11-05T17:09:00Z" } };
    const rows = [row({ id: "e1", seq: 2, paused: true }), row({ id: "w1", seq: 3, kind: "waiting", summary: `Paused at the run's $0.05 cap: ${WORDS}` })];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(RunDetail, { run, agentName: "capped", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, tab: "timeline" } as never)));
    const waitingLi = [...host.querySelectorAll("ol > li")].find((li) => (li.textContent ?? "").includes("Waiting for you"))!;
    expect(waitingLi.textContent).toContain("Paused at cap");
    expect(waitingLi.textContent).not.toContain("Input required");
  });
});

describe("the timeline, a request the spend cap held back", () => {
  it("reads as a quiet pause marker: \"Paused at its spend cap\", the warning tone, nothing red, and the banner's sentence not said again", () => {
    const li = draw(row({ paused: true }));
    expect(li.textContent).toContain("Paused at its spend cap");
    expect(li.textContent).not.toContain(WORDS);
    expect(li.textContent).not.toMatch(/Error/);
    expect(red(li)).toBe(false);
    expect(li.querySelector(".border-warning\\/60")).not.toBeNull();
  });

  it("keeps the server's words a click away, on expand", async () => {
    const li = draw(row({ paused: true }));
    await act(async () => { li.querySelector("button")!.click(); });
    expect(li.textContent).toContain(WORDS);
  });

  it("is no failure to the rest of the page (a failure's count, its repeats)", () => {
    expect(rowFailed(row({ paused: true }))).toBe(false);
    expect(rowFailed(row({}))).toBe(true);
  });

  it("stays a pause once the run goes on after a raise", () => {
    const li = draw(row({ paused: true }), true);
    expect(li.textContent).toContain("Paused at its spend cap");
    expect(red(li)).toBe(false);
  });

  it("an error the server doesn't mark paused is still an error, in red", () => {
    const li = draw(row({ summary: "Model request failed: 529 overloaded" }));
    expect(li.textContent).toMatch(/Error/);
    expect(red(li)).toBe(true);
  });
});
