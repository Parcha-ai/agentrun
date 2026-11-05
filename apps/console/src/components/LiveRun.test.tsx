import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LiveRun } from "./LiveRun";
import type { Run, TimelinePage } from "@/lib/v2";

// Archive's answer can describe the run as it was before a newer read landed: the page keeps the newer state and takes
// only archived_at from the answer, then reads the run again.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const at = (status: Run["status"], archived: boolean): Run => ({
  run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status, state: status === "working" ? "working" : "idle", title: "What is two and two?",
  created_at: "2026-10-30T06:00:00Z", ended_at: status === "working" ? null : "2026-10-30T06:00:03Z", result: null, error: null, cost: null, archived_at: archived ? "2026-11-01T07:00:00Z" : null,
});
const final = (status: Run["status"]): TimelinePage => ({ run_id: "r1", status, state: "idle", rows: [], drop: [], reset: true, unchanged: false, final: true, has_more: false, next_after: 1 });

describe("LiveRun's Archive", () => {
  it("an answer that says the run still works never puts back a state the page has read since; the run is read again", async () => {
    let reads = 0, archived = false;
    const v2 = {
      // The first read: still working. Every read after it: completed, and archived once the write was taken.
      getRun: async () => (++reads === 1 ? at("working", false) : at("completed", archived)),
      listFiles: async () => ({ run_id: "r1", files: [], complete: true, truncated: false }),
      getTimeline: async () => final("completed"),
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
      // The archive's answer was made before the run ended.
      archiveRun: async () => { archived = true; return at("working", true); },
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(LiveRun, { v2: v2 as never, runId: "r1", caps: null, agentName: () => "Calc" })));
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()));
    await settle();
    expect(host.textContent).toContain("Completed");
    await act(async () => { button(/^Archive$/)!.click(); });
    await settle();
    expect(button(/^Unarchive$/)).toBeTruthy();
    expect(host.textContent).toContain("Completed");
    expect(host.textContent).not.toContain("Working");
    expect(reads).toBeGreaterThan(2);
  });
});

// A run ends before its learning does: the page reads it again until its learning settles, so the header says what it
// kept as soon as it has, with no reload.
describe("LiveRun, a run whose learning is still deciding", () => {
  it("reads the ended run again until its learning is kept, then shows Learned 1 note", async () => {
    let reads = 0;
    const learning = (n: number): Run["learning"] => (n < 3 ? { state: n < 2 ? "reflecting" : "proposed", reason: null } : { state: "merged", reason: null, used: [], learned: [{ file: "b.md", name: "Try it first", supersedes: [] }] });
    const v2 = {
      getRun: async () => ({ ...at("completed", false), learning: learning(++reads) }),
      listFiles: async () => ({ run_id: "r1", files: [], complete: true, truncated: false }),
      getTimeline: async () => final("completed"),
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(LiveRun, { v2: v2 as never, runId: "r1", caps: null, agentName: () => "Calc" })));
    const header = () => host.querySelector("header")?.textContent ?? "";
    for (let i = 0; i < 40 && !header().includes("Looking back"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(header()).toContain("Looking back");
    for (let i = 0; i < 300 && !header().includes("Learned 1 note"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(header()).toContain("Learned 1 note");
    expect(header()).not.toContain("Looking back");
    const settled = reads;
    await act(async () => { await new Promise((r) => setTimeout(r, 2300)); });
    expect(reads).toBe(settled);
  }, 15_000);
});

// The header and the timeline say the same: once the run's learning moves, its timeline is read again, so the look-back's
// step says what it kept as the header does, and what it did behind it is the server's newest.
describe("LiveRun, its header and its timeline", () => {
  it("reads the timeline again when the run's learning moves: the look-back's step and the header agree", async () => {
    let reads = 0, timelines = 0;
    const learning = (n: number): Run["learning"] => (n < 3 ? { state: n < 2 ? "reflecting" : "proposed", reason: null } : { state: "merged", reason: null, used: [], learned: [{ file: "b.md", name: "Try it first", supersedes: [] }] });
    // The run's learning row, as the server has it at each read of the timeline: it moves in place.
    const ending = (): TimelinePage["rows"] => {
      const merged = reads >= 3;
      const detail = merged ? "Learned: Try it first" : "Checking 1 new note…";
      return [
        { id: "l1", seq: 1, kind: "user_message", agent_label: "learning", summary: "Looking back on this run.", text: "Looking back on this run.", timestamp: "2026-10-30T06:00:04Z", tool_name: null },
        { id: "learning", seq: 2, kind: "learning", agent_label: "learning", summary: detail, text: detail, timestamp: "2026-10-30T06:00:05Z", tool_name: null, learning: { state: merged ? "merged" : "proposed", reason: null, detail } } as TimelinePage["rows"][number],
      ];
    };
    const v2 = {
      getRun: async () => ({ ...at("completed", false), learning: learning(++reads) }),
      listFiles: async () => ({ run_id: "r1", files: [], complete: true, truncated: false }),
      getTimeline: async () => { timelines++; return { ...final("completed"), rows: ending() }; },
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(LiveRun, { v2: v2 as never, runId: "r1", caps: null, agentName: () => "Calc" })));
    const header = () => host.querySelector("header")?.textContent ?? "";
    for (let i = 0; i < 40 && !header().includes("Looking back"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    const tab = [...host.querySelectorAll('[role="tab"]')].find((b) => b.textContent === "Timeline") as HTMLButtonElement;
    await act(async () => { tab.click(); });
    for (let i = 0; i < 300 && !header().includes("Learned 1 note"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    for (let i = 0; i < 40 && !(host.querySelector("ol")?.textContent ?? "").includes("kept 1 note"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(header()).toContain("Learned 1 note");
    const step = [...host.querySelectorAll("ol > li")].find((li) => li.textContent?.includes("Looked back"))!;
    expect(step.textContent).toContain("Looked back: kept 1 note (Try it first)");
    await act(async () => { step.querySelector("button")!.click(); });
    expect(step.querySelector("pre")!.textContent).toContain("Learned: Try it first");
    expect(step.querySelector("pre")!.textContent).not.toContain("Checking 1 new note");
    expect(timelines).toBeGreaterThan(1);
  }, 15_000);
});

// With one row per action, a call's row changes in place, and no result row follows it: the files are read again when a
// call's row stops running, as they are when an older server's result row lands.
describe("LiveRun, one row per action", () => {
  it("reads the files again when an action's row stops running, and not while it runs", async () => {
    const call = (status: "running" | "success") => ({ id: "c1", seq: 1, kind: "tool_use", summary: status === "running" ? "Wrote one.md" : "Wrote one.md: ok", text: null, timestamp: "2026-10-30T06:00:01Z", tool_name: "write", tool_use_id: "t1", tool_status: status, path: "one.md" });
    const page = (rows: unknown[], reset: boolean): TimelinePage => ({ run_id: "r1", status: "working", state: "working", rows: rows as TimelinePage["rows"], drop: [], reset, unchanged: false, final: false, has_more: false, next_after: 2 });
    const reads: Record<string, number> = {};
    for (const ends of [true, false]) {
      let files = 0, pages = 0;
      const v2 = {
        getRun: async () => at("working", false),
        listFiles: async () => { files++; return { run_id: "r1", files: [], complete: true, truncated: false }; },
        // The call runs, then (or not) ends under the same id; after that, the follow waits.
        getTimeline: () => (++pages === 1 ? Promise.resolve(page([call("running")], true)) : pages === 2 ? Promise.resolve(page([call(ends ? "success" : "running")], false)) : new Promise<TimelinePage>(() => {})),
        listRevisions: async () => ({ revisions: [], next_cursor: null }),
      };
      const host = document.body.appendChild(document.createElement("div"));
      root = createRoot(host);
      act(() => root!.render(createElement(LiveRun, { v2: v2 as never, runId: "r1", caps: null, agentName: () => "Calc" })));
      // Until the follow has asked past the call's end (its third read), then a moment for the files read to land.
      for (let i = 0; i < 150 && pages < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(pages, `ends ${ends}`).toBeGreaterThanOrEqual(3);
      reads[String(ends)] = files;
      act(() => root?.unmount()); root = undefined;
    }
    // The same reads either way, and one more when the action ended.
    expect(reads.true).toBe(reads.false! + 1);
  });
});

// A run paused at its spend cap is raised from its page: one PATCH with the server's suggested cap prefilled, then
// the run is read again, so the pause and the raise give way to the run going on.
describe("LiveRun, a run paused at its spend cap", () => {
  it("Raise the cap and continue sends the server's suggested cap once and reads the run again: the pause is gone", async () => {
    let raised = false, reads = 0;
    const raises: unknown[] = [];
    const paused: Run = { ...at("working", false), status: "input_required", state: "waiting", ended_at: null,
      cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: 0.05 },
      pending: { kind: "budget", cap_usd: 0.05, spent_usd: 0, needs_usd: 0.1024, suggested_cap_usd: 2, said: "Not sent: the cap is reached.", at: "2026-11-04T20:08:05.127Z" } };
    const v2 = {
      getRun: async () => { reads++; return raised ? { ...at("working", false), state: "working" } : paused; },
      listFiles: async () => ({ run_id: "r1", files: [], complete: true, truncated: false }),
      getTimeline: async () => ({ ...final("input_required"), state: "waiting", final: false }),
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
      raiseCap: async (id: string, usd: number) => { raises.push([id, usd]); raised = true; return { run_id: id, max_cost_usd: usd, resumed: true, message_id: "m1", status: "input_required", state: "waiting" }; },
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(LiveRun, { v2: v2 as never, runId: "r1", caps: null, agentName: () => "Calc" })));
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    await settle();
    expect(host.textContent).toContain("Paused at its $0.05 spend cap");
    expect((host.querySelector('form[aria-label="Raise the cap"] input[aria-label="New cap in dollars"]') as HTMLInputElement | null)?.value).toBe("2");
    const before = reads;
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Raise the cap and continue")!;
    await act(async () => { button.click(); });
    await settle();
    expect(raises).toEqual([["r1", 2]]);
    expect(reads).toBeGreaterThan(before);
    expect(host.textContent).not.toContain("Paused at its $0.05 spend cap");
    expect(host.querySelector('input[aria-label="New cap in dollars"]')).toBeNull();
  });
});
