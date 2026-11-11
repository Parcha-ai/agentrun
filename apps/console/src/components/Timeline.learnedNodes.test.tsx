import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { LearnedNode, TimelineRow } from "@/lib/v2";

// A learned workflow's call on a run's timeline: its result row carries the nodes that ran (`learned_nodes`), shown
// under the step once opened; a call without them reads as any other call.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const row = (id: string, seq: number, over: Partial<TimelineRow>): TimelineRow => ({
  id, seq, kind: "tool_use", summary: "", text: null, timestamp: `2026-11-11T10:00:0${seq}Z`, tool_name: null, created_at: "2026-11-11T10:00:00Z", agent_label: null,
  tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, ...over,
});
const NODES: LearnedNode[] = [
  { label: "fetch the policy page", kind: "call", status: "ok", duration_ms: 840 },
  { label: "read the refund window", kind: "extract", status: "failed", duration_ms: 2300 },
  { label: "ask a person", kind: "escalate", status: "escalated", duration_ms: 12 },
];
const call = (nodes?: LearnedNode[], tool = "learned_workflow") => [
  row("c1", 1, { kind: "tool_use", tool_name: tool, tool_use_id: "t1", summary: "learned_workflow check-refunds", tool_input_preview: '{"name":"check-refunds"}' }),
  row("r1", 3, { kind: "tool_result", tool_name: tool, tool_use_id: "t1", tool_status: "failed", summary: "learned_workflow check-refunds failed", tool_result_preview: "the workflow failed", ...(nodes ? { learned_nodes: nodes } : {}) }),
];
const statusOf = (li: Element) => li.querySelector("[data-status]")?.getAttribute("data-status");
function show(rows: TimelineRow[]) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(<Timeline rows={rows} live={false} />));
  const toggle = () => [...host.querySelectorAll("button")].find((b) => /node/.test(b.getAttribute("aria-label") ?? "")) ?? null;
  const list = () => host.querySelector('ol[aria-label="The workflow\'s nodes"]');
  return { host, toggle, list };
}

describe("Timeline, a learned workflow's call", () => {
  it("with learned_nodes: a closed toggle that says how many nodes ran and how they ended, opening to each node's label, kind, status and time", async () => {
    const t = show(call(NODES));
    const toggle = t.toggle()!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("3 nodes");
    expect(toggle.textContent).toContain("1 failed");
    expect(t.list()).toBeNull();
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const items = [...t.list()!.querySelectorAll("li")];
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("fetch the policy page");
    expect(items[0]!.textContent).toContain("call");
    expect(items[0]!.textContent).toContain("840 ms");
    expect(items[1]!.textContent).toContain("read the refund window");
    expect(items[1]!.textContent).toContain("2.3 s");
    // Each status in its own colour: ok in success, failed in the error colour, escalated in warning.
    const chip = (li: Element) => li.querySelector("[data-status] > span")!;
    expect(statusOf(items[0]!)).toBe("ok");
    expect(chip(items[0]!).className).toContain("text-success-text");
    expect(chip(items[1]!).className).toContain("text-destructive-text");
    expect(chip(items[2]!).className).toContain("text-warning-text");
    // Its other text still opens under the step's own toggle: the nodes never replace it.
    expect(t.host.textContent).toContain("learned_workflow check-refunds failed");
  });
  it("an MCP harness's learned_workflow call shows its nodes the same way", () => {
    expect(show(call(NODES, "mcp__hands__learned_workflow")).toggle()).not.toBeNull();
  });
  it("only a call with learned_nodes gets the toggle: one without them, or with none, beside it reads as it did", () => {
    for (const nodes of [undefined, []]) {
      const other = call(nodes).map((r) => ({ ...r, id: `${r.id}b`, seq: r.seq + 10, tool_use_id: "t2", timestamp: `2026-11-11T10:00:${r.seq + 10}Z` }));
      const t = show([...call(NODES), ...other]);
      const steps = [...t.host.querySelectorAll("ol:not([aria-label]) > li")];
      expect(steps).toHaveLength(2);
      expect(steps[0]!.querySelector('button[aria-label^="Show the workflow"]')).not.toBeNull();
      expect(steps[1]!.querySelector('button[aria-label^="Show the workflow"]')).toBeNull();
      expect(steps[1]!.textContent).not.toMatch(/\bnodes?\b/);
      expect(t.host.querySelectorAll('button[aria-label^="Show the workflow"]')).toHaveLength(1);
      act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    }
  });
});
