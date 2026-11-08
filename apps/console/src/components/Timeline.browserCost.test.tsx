import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import { applyPage } from "@/lib/timeline";
import type { TimelinePage, TimelineRow } from "@/lib/v2";

// A browser call's charge is on its own tool_use row, in `usage` (#1736: serve's TimelineRow.usage, "on a browser call's
// tool_use row ... the browser session time booked under that call"), with no row of its own: the row reads its label
// and "· $0.0018", or what is known so far when a charge has no price. A charge booked later is the same row re-sent
// with its new usage, which replaces the one held.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const call = (usage: Record<string, unknown> | undefined, id = "c1"): TimelineRow => ({ id, seq: 2, kind: "tool_use", summary: "snapshot", text: null, timestamp: "2026-11-05T20:00:00Z", tool_name: "snapshot", tool_status: "success", ...(usage ? { usage } : {}) } as TimelineRow);
const draw = (rows: TimelineRow[], ended?: boolean) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Timeline, { rows, live: false, ...(ended === undefined ? {} : { ended }) } as never)));
  return [...host.querySelectorAll("li")] as HTMLElement[];
};

describe("a browser call's charge, on its own row", () => {
  it("reads its label and what it cost", () => {
    const [li] = draw([call({ usd: 0.0018, requests: 0 })]);
    expect(li.textContent).toMatch(/· \$0\.0018/);
  });

  it("with a charge that has no price, on a live run: what is known so far", () => {
    const [li] = draw([call({ usd: null, requests: 0, so_far_usd: 0.001, unpriced: 1 })], false);
    expect(li.textContent).toContain("· so far $0.001, 1 not priced");
  });

  it("with a charge that has no price, on a run that has ended: what is known, never \"so far\" (as the run's cost says it)", () => {
    const [li] = draw([call({ usd: null, requests: 0, so_far_usd: 0.001, unpriced: 1 })], true);
    expect(li.textContent).toContain("· $0.001 known, 1 not priced");
    expect(li.textContent).not.toContain("so far");
  });

  it("the run page says an ended run's call row as known (runEnded of its status), a working one's as so far", async () => {
    const { RunDetail } = await import("./RunDetail");
    const { messageFeatures, runFixture } = await import("@/fixtures");
    const f = runFixture("run.completed.idle.1");
    const rows = [call({ usd: null, requests: 0, so_far_usd: 0.001, unpriced: 1 })];
    for (const [status, state, says] of [["completed", "idle", "$0.001 known, 1 not priced"], ["working", "working", "so far $0.001, 1 not priced"]] as const) {
      const run = { ...f.run, kind: "agentic", status, state, result: null };
      const host = document.body.appendChild(document.createElement("div"));
      root = createRoot(host);
      act(() => root!.render(createElement(RunDetail, { run, agentName: "browsing", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, tab: "timeline" } as never)));
      expect(host.textContent, status).toContain(says);
      act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    }
  });

  it("a call whose result row follows it (the step a person reads is the two together) still reads the call's charge", () => {
    const use = { ...call({ usd: 0.0018, requests: 0 }), tool_status: null, tool_use_id: "u1" } as TimelineRow;
    const result = { id: "r1", seq: 3, kind: "tool_result", summary: "Looked at the page structure", text: null, timestamp: "2026-11-05T20:00:01Z", tool_name: "snapshot", tool_use_id: "u1" } as TimelineRow;
    const lis = draw([use, result]);
    expect(lis).toHaveLength(1);
    expect(lis[0].textContent).toMatch(/· \$0\.0018/);
  });

  it("a call with no charge says no cost", () => {
    const [li] = draw([call(undefined)]);
    expect(li.textContent).not.toMatch(/·\s*(\$|so far)/);
  });

  it("a charge booked later replaces the row's usage, never adds a row", () => {
    const page = (rows: TimelineRow[], reset = false): TimelinePage => ({ cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, run_id: "r", status: "completed", state: "idle", rows, drop: [], reset, unchanged: false, final: true, has_more: false, next_after: 9 });
    const held = applyPage([], page([call({ usd: 0.0012, requests: 0 })], true));
    const after = applyPage(held, page([call({ usd: 0.0018, requests: 0 })]));
    expect(after).toHaveLength(1);
    const lis = draw(after);
    expect(lis).toHaveLength(1);
    expect(lis[0].textContent).toMatch(/· \$0\.0018/);
    expect(lis[0].textContent).not.toMatch(/0\.0012/);
  });
});
