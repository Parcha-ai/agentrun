import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LiveRun } from "./LiveRun";
import { NeedsYouStrip, type NeedsYouProps } from "./NeedsYouStrip";
import { RunDetail, type RunDetailProps } from "./RunDetail";
import { messageFeatures } from "@/fixtures";
import type { PendingApproval, Run, TimelinePage, TimelineRow } from "@/lib/v2";

// A run can wait on one approval, then, once it is answered elsewhere, on the next, with its status and state the same
// throughout (input_required, waiting). The page must follow the call that waits NOW: the card names it and answers it,
// and a refusal of the earlier one is still said beside the new card.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const approval = (n: 1 | 2): PendingApproval => ({ kind: "approval", id: `ap_${n}`, tool: "web_fetch", call_id: `call_${n}`, args_preview: `{"url":"http://public.example/${n}"}`, requested_at: `2026-11-05T10:00:0${n}.000Z` });
const run = (pending: PendingApproval): Run => ({
  run_id: "r1", agent_id: "fetcher", agent_version: 1, revision: "rv1", kind: "agentic", status: "input_required", state: "waiting", title: "Fetch two pages",
  created_at: "2026-11-05T10:00:00.000Z", ended_at: null, result: null, error: null, cost: null, archived_at: null, pending,
});
const row = (n: 1 | 2, head: string): TimelineRow => ({ id: `res_${n}:approval`, seq: n * 10, kind: "tool_approval_requested", summary: `${head}: web_fetch ${approval(n).args_preview}`, text: approval(n).args_preview, timestamp: approval(n).requested_at, tool_name: "web_fetch", tool_use_id: `call_${n}`, tool_status: null });
const page = (rows: TimelineRow[], next: number): TimelinePage => ({ run_id: "r1", status: "input_required", state: "waiting", rows, drop: [], reset: false, unchanged: false, final: false, has_more: false, next_after: next });
const settle = async (ms = 0) => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement | undefined;

describe("LiveRun, the next approval with the same status", () => {
  it("reads the run again when the approval rows change: the card names the second call, and Allow answers its id", async () => {
    let phase = 1;
    let moveOn: () => void = () => {};
    const moved = new Promise<void>((r) => { moveOn = r; });
    let timelineReads = 0;
    const answered: string[] = [];
    const v2 = {
      getRun: async () => run(approval(phase as 1 | 2)),
      listFiles: async () => ({ run_id: "r1", files: [], complete: true, truncated: false }),
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
      getTimeline: async (_id: string, opts: { signal?: AbortSignal } = {}) => {
        const n = ++timelineReads;
        if (n === 1) return page([row(1, "Waiting for your approval")], 10);
        // The next read answers once the first call was answered elsewhere and the run waits on the second.
        if (n === 2) { await moved; return page([row(1, "Asked your approval"), row(2, "Waiting for your approval")], 20); }
        return new Promise<TimelinePage>((_r, reject) => opts.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      },
      answerApproval: async (_run: string, id: string) => { answered.push(id); },
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(LiveRun, { v2: v2 as never, runId: "r1", caps: null, agentName: () => "Fetcher" })));
    await settle();
    expect(host.querySelector("section[aria-label='Approval required'] pre")?.textContent).toContain("public.example/1");
    phase = 2;
    moveOn();
    await settle(50);
    const card = host.querySelector("section[aria-label='Approval required']")!;
    expect(card.querySelector("pre")?.textContent).toContain("public.example/2");
    await act(async () => { button(card, "Allow")!.click(); });
    await settle();
    expect(answered).toEqual(["ap_2"]);
  });
});

const WORDS = "This call was already allowed, in another tab or by another answer. The run shows what happened next.";

describe("a refusal of one approval while the next one waits", () => {
  it("the run page says it beside the new card", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const props = (r: Run): RunDetailProps => ({ run: r, agentName: "fetcher", messages: messageFeatures, harnessSteers: true, rows: [], files: [], actions: {}, onMessage: () => {}, tab: "timeline",
      // As the live page does: the run is read again (now waiting on the second call) before the refusal comes back.
      onApprove: async () => { root!.render(createElement(RunDetail, props(run(approval(2))))); return WORDS; } });
    act(() => root!.render(createElement(RunDetail, props(run(approval(1))))));
    await act(async () => { button(host, "Allow")!.click(); });
    await settle();
    expect(host.querySelector("section[aria-label='Approval required'] pre")?.textContent).toContain("public.example/2");
    expect([...host.querySelectorAll("[role='alert']")].map((a) => a.textContent)).toContain(`Your answer wasn't taken: ${WORDS}`);
  });

  it("Mission Control's strip says it beside the run's new card", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const base: Omit<NeedsYouProps, "asking"> = { failed: [], live: [], agentName: () => "Fetcher", now: () => Date.parse("2026-11-05T10:01:00Z"), onAnswer: async () => null, onRunAgain: async () => ({ started: [], problem: null }), onStop: async () => null,
      onApprove: async () => { root!.render(createElement(NeedsYouStrip, { ...base, asking: [run(approval(2))] })); return WORDS; } };
    act(() => root!.render(createElement(NeedsYouStrip, { ...base, asking: [run(approval(1))] })));
    await act(async () => { button(host, "Allow")!.click(); });
    await settle();
    expect(host.querySelector("section[aria-label='Approval required'] pre")?.textContent).toContain("public.example/2");
    expect([...host.querySelectorAll("[role='alert']")].some((a) => (a.textContent ?? "").includes(`your answer wasn't taken. ${WORDS}`))).toBe(true);
  });
});
