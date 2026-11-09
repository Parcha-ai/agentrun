import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelineRow } from "@/lib/v2";

// A call parked for the owner's approval has a result row that says it has not run yet, with `tool_status: null`: no
// finished result has a null status (the server's results are "success" or "failed"). Its step shows no duration: the
// time between the call and that row is no run of the tool's. A finished call keeps its duration.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const row = (over: Partial<TimelineRow>): TimelineRow => ({ created_at: "2026-11-05T10:00:00.000Z", agent_label: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, id: "r", seq: 0, kind: "tool_use", summary: "", text: null, timestamp: "2026-11-05T10:00:00.000Z", tool_name: null, ...over });
function mount(rows: TimelineRow[]) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Timeline, { rows, live: false })));
  const step = (has: string) => [...host.querySelectorAll("li")].find((li) => (li.textContent ?? "").includes(has))!;
  // The step's duration: the mono span in its label line that reads "<n> ms" or "<n> s".
  const duration = (li: Element) => [...li.querySelectorAll("span")].map((s) => s.textContent ?? "").find((t) => /^\d+(\.\d)? (ms|s)$/.test(t));
  return { step, duration };
}

describe("Timeline, a call parked for approval", () => {
  it("shows no duration while the call has not run", () => {
    const page = mount([
      row({ id: "u1", seq: 1, kind: "tool_use", summary: "Fetch public.example/a", tool_name: "web_fetch", tool_use_id: "call_1", timestamp: "2026-11-05T10:00:00.000Z" }),
      row({ id: "r1", seq: 2, kind: "tool_result", summary: "Not run yet: it waits for your approval", tool_name: "web_fetch", tool_use_id: "call_1", tool_status: null, timestamp: "2026-11-05T10:00:00.017Z" }),
    ]);
    const li = page.step("Not run yet");
    expect(li).toBeTruthy();
    expect(page.duration(li)).toBeUndefined();
  });

  it("a finished call keeps its duration, success or failed", () => {
    const page = mount([
      row({ id: "u2", seq: 1, kind: "tool_use", summary: "Fetch public.example/b", tool_name: "web_fetch", tool_use_id: "call_2", timestamp: "2026-11-05T10:00:00.000Z" }),
      row({ id: "r2", seq: 2, kind: "tool_result", summary: "Fetched public.example/b: ok", tool_name: "web_fetch", tool_use_id: "call_2", tool_status: "success", timestamp: "2026-11-05T10:00:00.017Z" }),
      row({ id: "u3", seq: 3, kind: "tool_use", summary: "Fetch public.example/c", tool_name: "web_fetch", tool_use_id: "call_3", timestamp: "2026-11-05T10:00:01.000Z" }),
      row({ id: "r3", seq: 4, kind: "tool_result", summary: "Fetch public.example/c failed: refused", tool_name: "web_fetch", tool_use_id: "call_3", tool_status: "failed", timestamp: "2026-11-05T10:00:02.500Z" }),
    ]);
    expect(page.duration(page.step("public.example/b"))).toBe("17 ms");
    expect(page.duration(page.step("refused"))).toBe("1.5 s");
  });
});
