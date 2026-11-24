import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { elapsed, InFlight, inFlightWords } from "./InFlight";
import { LiveRun } from "./LiveRun";
import type { Run, TimelinePage } from "@/lib/v2";

// What a live run waits on (GRE-4835): each model request sent and not answered and each tool call not returned, from the
// timeline page's `in_flight`, with how long, under the run's header, while it is live.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const SENT = "2026-11-23T22:48:36.000Z";
const model = { kind: "model" as const, name: "inkling-2-mini", started_at: SENT, input_tokens_max: 17355 };
const fetching = { kind: "tool" as const, name: "web_fetch", started_at: "2026-11-23T22:50:08.000Z", tool_use_id: "call_1" };

describe("InFlight", () => {
  it("says each as a clock reads how long it has waited", () => {
    const at = Date.parse(SENT);
    expect(elapsed(SENT, at + 7_000)).toBe("0:07");
    expect(elapsed(SENT, at + 133_000)).toBe("2:13");
    expect(elapsed(SENT, at + 3_849_000)).toBe("1:04:09");
    expect(elapsed(null, at)).toBeNull();
    expect(inFlightWords(model)).toBe("inkling-2-mini thinking");
    expect(inFlightWords({ ...model, name: "gpt-6-luna", for_tool: "web_search" })).toBe("gpt-6-luna thinking for web_search");
    expect(inFlightWords(fetching)).toBe("web_fetch");
  });
  it("lists a model request and a tool call with their times, and nothing when nothing waits", () => {
    const h = renderToStaticMarkup(createElement(InFlight, { items: [model, fetching], now: Date.parse(SENT) + 133_000 }));
    expect(h).toContain("Waiting on");
    expect(h).toContain("inkling-2-mini thinking");
    expect(h).toContain("· 2:13");
    expect(h).toContain("web_fetch");
    expect(h).toContain("· 0:41");
    expect(h).toContain("up to 17,355 tokens of input");
    expect(renderToStaticMarkup(createElement(InFlight, { items: [] }))).toBe("");
  });
});

describe("LiveRun, what the run waits on", () => {
  it("shows the page's in-flight requests under the header while the run works, and none once it ends", async () => {
    const run = (status: Run["status"]): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: status === "working" ? 1000 : 0, place: { mode: "runner" },
      run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status, state: status === "working" ? "working" : "idle", title: "Research Parcha",
      created_at: "2026-11-23T22:48:00Z", ended_at: status === "working" ? null : "2026-11-23T22:53:00Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null } as Run);
    let ended = false;
    const page = (): TimelinePage => ({ cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, run_id: "r1", status: ended ? "completed" : "working", state: ended ? "idle" : "working", rows: [], drop: [], reset: true, unchanged: false, final: ended, has_more: false, next_after: ended ? 2 : 1, in_flight: ended ? [] : [model] } as TimelinePage);
    const v2 = { getRun: async () => run(ended ? "completed" : "working"), listFiles: async () => ({ run_id: "r1", files: [], complete: true, truncated: false }), getTimeline: async () => page(), listRevisions: async () => ({ revisions: [], next_cursor: null }) };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(LiveRun, { v2: v2 as never, runId: "r1", caps: null, agentName: () => "Calc" })));
    const strip = () => host.querySelector("[data-in-flight]");
    for (let i = 0; i < 80 && !strip(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(strip()?.textContent).toContain("inkling-2-mini thinking");
    expect(strip()!.compareDocumentPosition(host.querySelector('[role="tablist"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    ended = true;
    for (let i = 0; i < 200 && strip(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(strip()).toBeNull();
  });
});
