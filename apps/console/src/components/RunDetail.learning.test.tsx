import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail } from "@/components/RunDetail";
import { messageFeatures } from "@/fixtures";
import type { Run, TimelineRow } from "@/lib/v2";

// A run's timeline, as its page shows it: the end-of-run look-back is one step, "Looked back: kept 2 notes (…)", with
// what it did behind it; the run's own steps are as they were.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const row = (id: string, seq: number, over: Partial<TimelineRow> & { learning?: unknown }): TimelineRow => ({ id, seq, kind: "text_block", summary: "", text: null, timestamp: `2026-11-03T18:50:0${seq}Z`, tool_name: null, ...over }) as TimelineRow;
const ROWS: TimelineRow[] = [
  row("u1", 1, { kind: "user_message", summary: "You: Find this shop's refund policy page" }),
  row("a1", 2, { kind: "final_answer", summary: "https://www.brooklinen.com/policies/refund-policy" }),
  row("l1", 3, { kind: "user_message", agent_label: "learning", summary: "Looking back on this run.", text: "Looking back on this run." }),
  row("l2", 4, { kind: "tool_use", tool_name: "write", agent_label: "learning", summary: "Wrote .learning/refund-limit.md", tool_input_preview: ".learning/refund-limit.md" }),
  row("l3", 5, { kind: "tool_result", tool_name: "write", agent_label: "learning", summary: "Wrote .learning/refund-limit.md: ok" }),
  row("l4", 6, { kind: "phase", agent_label: "learning", summary: "Saved .learning/refund-limit.md" }),
  row("l5", 7, { kind: "text_block", agent_label: "learning", summary: "Reflected.", text: "Reflected." }),
  row("learning", 8, { kind: "learning", agent_label: "learning", summary: "Learned 2 notes: Refund limit; Answer shape", text: "Learned 2 notes: Refund limit; Answer shape", learning: { state: "merged", reason: null, detail: "Learned 2 notes: Refund limit; Answer shape" } }),
];
const run = (learning: Run["learning"]): Run => ({
  run_id: "run-b", agent_id: "refunds", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "brooklinen.com",
  created_at: "2026-11-03T18:50:00Z", ended_at: "2026-11-03T18:50:09Z", result: null, error: null, cost: null, archived_at: null, learning,
});
const MERGED: Run["learning"] = { state: "merged", reason: null, learned: [{ file: "refund-limit.md", name: "Refund limit", supersedes: [] }, { file: "answer-shape.md", name: "Answer shape", supersedes: [] }] };

function show(r: Run, rows: TimelineRow[]) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunDetail, { run: r, agentName: "Refund policy finder", messages: messageFeatures, harnessSteers: true, rows, files: [], tab: "timeline" })));
  const steps = () => [...host.querySelectorAll("ol > li")].map((li) => li.textContent ?? "");
  return { host, steps };
}

describe("a run's timeline, its look-back", () => {
  it("is one step, labelled Learning, saying what it kept by name, with no file path and no chip", () => {
    const t = show(run(MERGED), ROWS);
    const steps = t.steps();
    expect(steps).toHaveLength(3);
    const look = steps.filter((s) => s.includes("Looked back"));
    expect(look).toHaveLength(1);
    expect(look[0]).toContain("Learning");
    expect(look[0]).toContain("Looked back: kept 2 notes (Refund limit, Answer shape)");
    expect(look[0]).not.toContain(".learning/");
    // The look-back's message is the server's, never the person's, and no step repeats the label as a chip.
    expect(steps.filter((s) => s.startsWith("You"))).toHaveLength(1);
    expect(t.host.innerHTML).not.toMatch(/>learning</);
  });
  it("opens to what it did, row by row", async () => {
    const t = show(run(MERGED), ROWS);
    const li = [...t.host.querySelectorAll("ol > li")].find((x) => x.textContent?.includes("Looked back"))!;
    const toggle = li.querySelector("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { toggle.click(); });
    const pre = li.querySelector("pre")!.textContent!;
    expect(pre).toContain("Looking back on this run.");
    expect(pre).toContain("Wrote .learning/refund-limit.md");
    expect(pre).toContain("Learned 2 notes: Refund limit; Answer shape");
  });
  it("one that kept nothing new says so", () => {
    const rows = [...ROWS.slice(0, 7), row("learning", 8, { kind: "learning", agent_label: "learning", summary: "Nothing new to remember from this run.", text: "Nothing new to remember from this run." })];
    expect(show(run({ state: "dropped", reason: "empty" }), rows).steps().join("\n")).toContain("Looked back: nothing new to keep");
  });
  it("a run that skipped looking back keeps its one row, labelled Learning, in the server's words", () => {
    const rows = [...ROWS.slice(0, 2), row("learning", 3, { kind: "learning", agent_label: "learning", summary: "Skipped: no budget left in this run to look back." })];
    const steps = show(run({ state: "dropped", reason: "no_budget" }), rows).steps();
    expect(steps).toHaveLength(3);
    expect(steps[2]).toContain("Learning");
    expect(steps[2]).toContain("Skipped: no budget left in this run to look back.");
  });
});
