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
const draw = (rows: TimelineRow[]) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Timeline, { rows, live: false })));
  return [...host.querySelectorAll("li")] as HTMLElement[];
};

describe("a browser call's charge, on its own row", () => {
  it("reads its label and what it cost", () => {
    const [li] = draw([call({ usd: 0.0018, requests: 0 })]);
    expect(li.textContent).toMatch(/· \$0\.0018/);
  });

  it("with a charge that has no price, what is known so far", () => {
    const [li] = draw([call({ usd: null, requests: 0, so_far_usd: 0.001, unpriced: 1 })]);
    expect(li.textContent).toContain("· so far $0.001, 1 not priced");
  });

  it("a call with no charge says no cost", () => {
    const [li] = draw([call(undefined)]);
    expect(li.textContent).not.toMatch(/·\s*(\$|so far)/);
  });

  it("a charge booked later replaces the row's usage, never adds a row", () => {
    const page = (rows: TimelineRow[], reset = false): TimelinePage => ({ run_id: "r", status: "completed", state: "idle", rows, drop: [], reset, unchanged: false, final: true, has_more: false, next_after: 9 });
    const held = applyPage([], page([call({ usd: 0.0012, requests: 0 })], true));
    const after = applyPage(held, page([call({ usd: 0.0018, requests: 0 })]));
    expect(after).toHaveLength(1);
    const lis = draw(after);
    expect(lis).toHaveLength(1);
    expect(lis[0].textContent).toMatch(/· \$0\.0018/);
    expect(lis[0].textContent).not.toMatch(/0\.0012/);
  });
});
