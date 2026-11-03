import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LiveRun } from "./LiveRun";
import type { Run, TimelinePage } from "@/lib/v2";

// An imported run opened while the import at setup has still to write its transcript: the page says so, keeps reading,
// and shows the transcript once a page has it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const run: Run = {
  run_id: "r1", agent_id: "imp-1", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "Fix the header.",
  created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: null, archived_at: null,
};
const page = (extra: Partial<TimelinePage>): TimelinePage => ({ run_id: "r1", status: "completed", state: "idle", rows: [], drop: [], reset: true, unchanged: false, final: false, has_more: false, next_after: 0, ...extra });
const row = { id: "u1", seq: 1, kind: "user_message" as const, summary: "Fix the header.", text: "Fix the header.", timestamp: "2026-10-30T06:00:00Z", tool_name: null };

describe("LiveRun, an imported run whose transcript is still to come", () => {
  it("says its transcript is being imported, then shows it once it lands", async () => {
    let reads = 0;
    const v2 = {
      getRun: async () => run,
      listFiles: async () => ({ run_id: "r1", files: [], complete: true, truncated: false }),
      // Two reads before the transcript lands, then the transcript.
      getTimeline: async () => (++reads <= 2 ? page({ transcript: "importing", unchanged: reads > 1, poll_after_ms: 50 }) : page({ rows: [row], final: true, next_after: 1 })),
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(LiveRun, { v2: v2 as never, runId: "r1", caps: null, agentName: () => "project" })));
    const until = async (ok: () => boolean) => { const end = Date.now() + 4000; while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); return ok(); };
    expect(await until(() => /transcript is still being imported/.test(host.textContent ?? ""))).toBe(true);
    expect(await until(() => reads >= 3 && !/still being imported/.test(host.textContent ?? ""))).toBe(true);
    // A completed run opens on its report: on the Timeline tab, the transcript's row says what the title says, again.
    const said = () => (host.textContent ?? "").split("Fix the header.").length - 1;
    const tab = [...host.querySelectorAll("button[role=tab]")].find((b) => b.textContent === "Timeline") as HTMLButtonElement;
    await act(async () => { tab.click(); });
    expect(await until(() => said() >= 2)).toBe(true);
  });
});
