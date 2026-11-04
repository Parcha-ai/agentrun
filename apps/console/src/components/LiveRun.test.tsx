import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveRun } from "./LiveRun";
import type { Capabilities } from "@/lib/client";
import type { Run, TimelinePage } from "@/lib/v2";

// Archive's answer can describe the run as it was before a newer read landed: the page keeps the newer state and takes
// only archived_at from the answer, then reads the run again.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.useRealTimers(); });

const at = (status: Run["status"], archived: boolean): Run => ({
  run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status, state: status === "working" ? "working" : "idle", title: "What is two and two?",
  created_at: "2026-10-30T06:00:00Z", ended_at: status === "working" ? null : "2026-10-30T06:00:03Z", result: null, error: null, cost: null, archived_at: archived ? "2026-11-01T07:00:00Z" : null,
});
const final = (status: Run["status"]): TimelinePage => ({ run_id: "r1", status, state: "idle", rows: [], drop: [], reset: true, unchanged: false, final: true, has_more: false, next_after: 1 });

it.each(["agentic", "workflow"] as const)("hides disabled file and graph routes for a %s run", async (kind) => {
  const listFiles = vi.fn().mockRejectedValue(new Error("file route unsupported"));
  const getRunGraph = vi.fn().mockRejectedValue(new Error("graph route unsupported"));
  const v2 = { getRun: async () => ({ ...at("completed", false), kind }), getTimeline: async () => final("completed"), listRevisions: async () => ({ revisions: [], next_cursor: null }), listFiles, getRunGraph };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const caps: Capabilities = { harnesses: [], features: { runs: { stop: false, cancel: false, kill: false, list: true, kinds: [kind], graph: false, pause_workflow_runs: false }, files: { read: false, upload: false, range: false, during_run: false }, messages: { steer: false, answer: false, follow_up: false, steer_workflow_runs: false } } };
  await act(async () => { root!.render(createElement(LiveRun, { v2: v2 as never, runId: "r1", caps, agentName: () => "Calc" })); });
  expect(listFiles).not.toHaveBeenCalled();
  expect(getRunGraph).not.toHaveBeenCalled();
  expect([...host.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent?.startsWith("Files"))).toBe(false);
  expect([...host.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent === "Graph")).toBe(false);
});

it("does not claim missing history or files before their initial reads arrive", async () => {
  let complete!: (value: { run_id: string; files: []; complete: boolean; truncated: boolean }) => void;
  const pending = new Promise<{ run_id: string; files: []; complete: boolean; truncated: boolean }>((resolve) => { complete = resolve; });
  let timeline!: (page: TimelinePage) => void;
  const pendingTimeline = new Promise<TimelinePage>((resolve) => { timeline = resolve; });
  const v2 = { getRun: async () => at("completed", false), getTimeline: async () => pendingTimeline, listRevisions: async () => ({ revisions: [], next_cursor: null }), listFiles: async () => pending };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(LiveRun, { v2: v2 as never, runId: "r1", caps: null, agentName: () => "Calc" })); });
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "Timeline")!.click(); });
  expect(host.textContent).toContain("Reading the timeline");
  expect(host.textContent).not.toContain("This run recorded no steps.");
  await act(async () => { timeline(final("completed")); });
  expect(host.textContent).toContain("This run recorded no steps.");
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith("Files"))!.click(); });
  expect(host.textContent).toContain("Reading the files...");
  expect(host.textContent).not.toContain("This run wrote no files.");
  await act(async () => { complete({ run_id: "r1", files: [], complete: true, truncated: false }); });
  expect(host.textContent).not.toContain("Reading the files...");
  expect(host.textContent).toContain("This run wrote no files.");
});

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


describe("LiveRun after a disconnect", () => {
  it("keeps the last rows and reconnects from the accepted cursor", async () => {
    vi.useFakeTimers();
    const row = { id: "m1", seq: 1, kind: "user_message", summary: "Original task", text: null, timestamp: at("working", false).created_at, tool_name: null };
    const cursors: (number | undefined)[] = [];
    let reads = 0;
    const v2 = {
      getRun: async () => at(reads > 2 ? "completed" : "working", false),
      listFiles: async () => ({ run_id: "r1", files: [], complete: false, truncated: true }),
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
      getTimeline: async (_id: string, opts: { after?: number }) => {
        cursors.push(opts.after);
        if (++reads === 2) throw new TypeError("Connection lost");
        return { ...final(reads > 2 ? "completed" : "working"), rows: [row], state: reads > 2 ? "idle" : "working", final: reads > 2, next_after: 17, reset: reads === 1 };
      },
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(LiveRun, { v2: v2 as never, runId: "r1", caps: null, agentName: () => "Calc" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(host.textContent).toContain("Connection lost");
    const reconnect = [...host.querySelectorAll("button")].find((b) => b.textContent === "Reconnect") as HTMLButtonElement;
    expect(reconnect).toBeTruthy();
    await act(async () => { reconnect.click(); });
    expect(cursors).toEqual([undefined, 17, 17]);
    expect(host.textContent?.match(/Original task/g)).toHaveLength(1);
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Files"))!.click(); });
    expect(host.textContent).toContain("Partial file list");
    expect(host.textContent).not.toContain("This run wrote no files.");
  });
});
