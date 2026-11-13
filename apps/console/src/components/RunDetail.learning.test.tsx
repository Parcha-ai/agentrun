import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail } from "@/components/RunDetail";
import { messageFeatures, recorded } from "@/fixtures";
import type { LearningDiff } from "@/lib/learning";
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
const run = (learning: Run["learning"]): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "run-b", agent_id: "refunds", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "brooklinen.com",
  created_at: "2026-11-03T18:50:00Z", ended_at: "2026-11-03T18:50:09Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, learning,
});
const MERGED: Run["learning"] = { detail: null, at: "2026-11-03T16:52:09Z", state: "merged", reason: null, learned: [{ file: "refund-limit.md", name: "Refund limit", supersedes: [] }, { file: "answer-shape.md", name: "Answer shape", supersedes: [] }] };

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
    expect(show(run({ detail: null, at: "2026-11-03T16:52:09Z", state: "dropped", reason: "empty" }), rows).steps().join("\n")).toContain("Looked back: nothing new to keep");
  });
  it("a run that skipped looking back keeps its one row, labelled Learning, in the server's words", () => {
    const rows = [...ROWS.slice(0, 2), row("learning", 3, { kind: "learning", agent_label: "learning", summary: "Skipped: no budget left in this run to look back." })];
    const steps = show(run({ detail: null, at: "2026-11-03T16:52:09Z", state: "dropped", reason: "no_budget" }), rows).steps();
    expect(steps).toHaveLength(3);
    expect(steps[2]).toContain("Learning");
    expect(steps[2]).toContain("Skipped: no budget left in this run to look back.");
  });
});

// What a run's learning changed, on its page, from the server's diff of it (recorded: Brooklinen's run added a note
// that replaces an older one): each note by its name, opening to its text before and after with what changed marked.
describe("a run's page, what its learning changed", () => {
  const DIFF = recorded<LearningDiff>("learning.diff").body;
  const BROOKLINEN = recorded<Run>("learning.diff-run").body;
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  async function open(r: Run, read: () => Promise<LearningDiff>, tab: "report" | "timeline" = "report") {
    const reads: string[] = [];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(RunDetail, { run: r, agentName: "Refund policy finder", messages: messageFeatures, harnessSteers: true, rows: [], files: [], tab, readLearningDiff: () => { reads.push(r.run_id); return read(); } })));
    await settle();
    const section = () => host.querySelector('section[aria-label="What it changed"]') as HTMLElement | null;
    return { host, reads, section };
  }
  it("lists each note it added or replaced, by name, its file in small; each opens to before and after, the change marked", async () => {
    const t = await open(BROOKLINEN, async () => DIFF);
    const section = t.section()!;
    expect(section).not.toBeNull();
    const items = [...section.querySelectorAll("li > button")];
    expect(items.map((b) => b.querySelector("[data-said]")?.textContent)).toEqual([
      "Added: Try /policies/refund-policy first",
      "Replaced: Shopify refund policy path → Try /policies/refund-policy first",
    ]);
    expect(items[1]!.textContent).toContain("shopify-refund-policy-path.md");
    expect(items[1]!.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { (items[1] as HTMLButtonElement).click(); });
    const li = items[1]!.closest("li")!;
    const [before, after] = [...li.querySelectorAll("[data-side]")];
    expect([before!.getAttribute("data-side"), after!.getAttribute("data-side")]).toEqual(["before", "after"]);
    expect([...after!.querySelectorAll('[data-mark="added"]')].map((l) => l.textContent)).toEqual(["status: superseded", "superseded_by: try-policies-refund-policy-first.md"]);
    expect(before!.querySelectorAll('[data-mark="added"], [data-mark="removed"]')).toHaveLength(0);
    expect(before!.textContent).toContain("name: Shopify refund policy path");
    // The added note: nothing before it.
    await act(async () => { (items[0] as HTMLButtonElement).click(); });
    expect(items[0]!.closest("li")!.querySelector('[data-side="before"]')!.textContent).toContain("Not there before.");
    expect(section.textContent).not.toMatch(/\b(main|merge|merged|commit|diff|patch|proposal|end-of-run)\b/i);
    expect(t.reads).toEqual([BROOKLINEN.run_id]);
  });
  it("shows on the timeline too, read once", async () => {
    const t = await open(BROOKLINEN, async () => DIFF, "timeline");
    expect(t.section()).not.toBeNull();
    expect(t.reads).toHaveLength(1);
  });
  it("a run that kept nothing, or does not learn, shows nothing more and asks for nothing", async () => {
    for (const learning of [{ state: "dropped", reason: "empty" }, null] as Run["learning"][]) {
      const t = await open(run(learning), async () => DIFF);
      expect(t.section()).toBeNull();
      expect(t.reads).toEqual([]);
      act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    }
  });
  it("a read that fails says so in a line, and Try again reads it again", async () => {
    let n = 0;
    const t = await open(BROOKLINEN, async () => { if (n++ === 0) throw new TypeError("Failed to fetch"); return DIFF; });
    expect(t.section()!.textContent).toContain("Couldn't read what it changed: can't reach agentrun-serve.");
    const retry = [...t.section()!.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => { retry.click(); });
    await settle();
    expect(t.section()!.textContent).toContain("Added: Try /policies/refund-policy first");
    expect(t.reads).toHaveLength(2);
  });
});

