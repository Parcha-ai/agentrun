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
