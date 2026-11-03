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
