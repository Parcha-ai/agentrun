import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail } from "@/components/RunDetail";
import { messageFeatures, recorded } from "@/fixtures";
import type { LearningDiff } from "@/lib/learning";
import type { Run, RunGraded, RunLearningRead, TimelineRow } from "@/lib/v2";

// A run's timeline, as its page shows it: the end-of-run learning is one step, "Looked back: kept 2 workflows (…)", with
// what it did behind it; the run's own steps are as they were.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const row = (id: string, seq: number, over: Partial<TimelineRow> & { learning?: unknown }): TimelineRow => ({ id, seq, kind: "text_block", summary: "", text: null, timestamp: `2026-11-03T18:50:0${seq}Z`, tool_name: null, ...over }) as TimelineRow;
const ROWS: TimelineRow[] = [
  row("u1", 1, { kind: "user_message", summary: "You: Find this shop's refund policy page" }),
  row("a1", 2, { kind: "final_answer", summary: "https://www.brooklinen.com/policies/refund-policy" }),
  row("l1", 3, { kind: "user_message", agent_label: "learning", summary: "Looking back on this run.", text: "Looking back on this run." }),
  row("l2", 4, { kind: "tool_use", tool_name: "write", agent_label: "learning", summary: "Wrote workflows/refund-limit/workflow.json", tool_input_preview: "workflows/refund-limit/workflow.json" }),
  row("l3", 5, { kind: "tool_result", tool_name: "write", agent_label: "learning", summary: "Wrote workflows/refund-limit/workflow.json: ok" }),
  row("l4", 6, { kind: "phase", agent_label: "learning", summary: "Saved workflows/refund-limit/workflow.json" }),
  row("l5", 7, { kind: "text_block", agent_label: "learning", summary: "Compiled.", text: "Compiled." }),
  row("learning", 8, { kind: "learning", agent_label: "learning", summary: "Learned 2 workflows: refund-limit, answer-shape", text: "Learned 2 workflows: refund-limit, answer-shape", learning: { state: "merged", reason: null, detail: "Learned 2 workflows: refund-limit, answer-shape" } }),
];
const run = (learning: Run["learning"]): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "run-b", agent_id: "refunds", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "brooklinen.com",
  created_at: "2026-11-03T18:50:00Z", ended_at: "2026-11-03T18:50:09Z", result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, learning,
});
const MERGED: Run["learning"] = { detail: null, at: "2026-11-03T16:52:09Z", state: "merged", reason: null, workflows: [{ file: "workflows/refund-limit/workflow.json", name: "refund-limit" }, { file: "workflows/answer-shape/workflow.json", name: "answer-shape" }] };

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
    expect(look[0]).toContain("Looked back: kept 2 workflows (refund-limit, answer-shape)");
    expect(look[0]).not.toContain("workflow.json");
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
    expect(pre).toContain("Wrote workflows/refund-limit/workflow.json");
    expect(pre).toContain("Learned 2 workflows: refund-limit, answer-shape");
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

// What a run's learning changed, on its page, from the server's diff of it (recorded: Brooklinen's run added a line to
// corrections.md and compiled a workflow): each file in words, opening to its text before and after with what changed marked.
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
  it("lists each file it added or changed, in words, its file in small; each opens to before and after, the change marked", async () => {
    const t = await open(BROOKLINEN, async () => DIFF);
    const section = t.section()!;
    expect(section).not.toBeNull();
    const items = [...section.querySelectorAll("li > button")];
    expect(items.map((b) => b.querySelector("[data-said]")?.textContent)).toEqual([
      "Added: workflow find-refund-policy",
      "Changed: corrections",
    ]);
    expect(items[1]!.textContent).toContain("corrections.md");
    expect(items[1]!.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { (items[1] as HTMLButtonElement).click(); });
    const li = items[1]!.closest("li")!;
    const [before, after] = [...li.querySelectorAll("[data-side]")];
    expect([before!.getAttribute("data-side"), after!.getAttribute("data-side")]).toEqual(["before", "after"]);
    expect([...after!.querySelectorAll('[data-mark="added"]')].map((l) => l.textContent)).toEqual(["- Open /policies/refund-policy before any other page; fall back to /pages/returns."]);
    expect(before!.querySelectorAll('[data-mark="added"], [data-mark="removed"]')).toHaveLength(0);
    expect(before!.textContent).toContain("- Keep the summary to three lines.");
    // The added workflow: nothing before it.
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
    expect(t.section()!.textContent).toContain("Added: workflow find-refund-policy");
    expect(t.reads).toHaveLength(2);
  });
});


// A grade with words of a run the agent finished opens the run again on a look-back (PUT /runs/{id}/grade, serve's
// feedback-round.ts): no turn of the job's, only its end-of-run step, which takes the grade. While it runs the server reads
// the run as one going again (store reopen: state running, ended_at and its end cleared), so GET /runs/{id} serves it
// working with no `result` and no `ended_at`; the learning read says the grade's round runs (`graded.feedback_status`).
// Stop and Cancel there would end the run stopped or cancelled in place of the completed end it had.
describe("a run's page while its grade's look-back runs", () => {
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const ANSWER = "Qualified: a 40-seat team on the annual plan.";
  const JOB: TimelineRow[] = [
    row("u1", 1, { kind: "user_message", summary: "You: Qualify this inbound lead" }),
    row("a1", 2, { kind: "final_answer", summary: ANSWER, text: ANSWER }),
  ];
  const KEPT: Run["learning"] = { detail: null, at: "2026-11-03T18:50:09Z", state: "dropped", reason: "empty" };
  const graded = (status: RunGraded["feedback_status"]): RunGraded => ({ run_id: "run-b", correct: false, source: "feedback", graded_at: "2026-11-03T18:51:00.000Z", path: "agent", workflow: null, workflow_digest: null, feedback: "correction", feedback_status: status });
  const readOf = (g: RunGraded | null): RunLearningRead => ({ run: "run-b", state: "dropped", reason: "empty", detail: null, at: "2026-11-03T18:50:09Z", seed: "c1", merged: null, workflows: [], corrections: 0, problems: [], compiled: null, draft_errors: [], used: { workflows: [] }, ...(g ? { graded: g } : {}) });
  /** The run as the server serves it: completed with its answer, or open again (working, no result, no end). */
  const served = (over: Partial<Run> = {}): Run => ({ ...run(KEPT), status: "completed", state: "idle", result: { output: null, final_answer: ANSWER }, cost: { usd: 0.04, basis: "estimate", charge_state: null, cap_usd: 1 }, ...over } as Run);
  const reopened = (over: Partial<Run> = {}) => served({ status: "working", state: "working", ended_at: null, result: null, ...over });

  async function open(r: Run, g: RunGraded | null, tab: "report" | "timeline" = "report") {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    let stored = g;
    const props = { agentName: "Inbound leads", messages: messageFeatures, harnessSteers: true, rows: JOB, files: [], tab,
      readLearning: async () => readOf(stored),
      onMessage: () => true,
      actions: { onStop: () => {}, onCancel: () => {}, onArchive: () => {}, onRaiseCap: async (usd: number) => ({ run_id: "run-b", max_cost_usd: usd, resumed: false, status: "working", state: "working" }) as never } };
    const show = async (next: Run, nextGrade = stored) => { stored = nextGrade; act(() => root!.render(createElement(RunDetail, { ...props, run: next }))); await settle(); };
    await show(r);
    const buttons = () => [...host.querySelectorAll("header button")].map((b) => b.textContent?.trim() ?? "");
    const badge = () => host.querySelector("header [data-title-block]")?.textContent ?? "";
    return { host, show, buttons, badge };
  }

  it("reads as a finished run learning from the grade: its answer, no Writing the answer, no job actions", async () => {
    const t = await open(reopened(), graded("running"));
    const text = t.host.textContent ?? "";
    expect(text).toContain(ANSWER);
    expect(text).not.toContain("Writing the answer");
    expect(t.badge()).toContain("Learning from your grade");
    expect(t.badge()).not.toContain("Working");
    expect(t.buttons().some((b) => /Stop|Cancel run|Raise the cap/.test(b))).toBe(false);
    expect(t.buttons().some((b) => b.includes("Archive"))).toBe(true);
    // A message would wait for the look-back's end: none is offered while it runs.
    expect(t.host.querySelector("#composer")).toBeNull();
  });

  it("says so on the Timeline too, not that the job works", async () => {
    const t = await open(reopened(), graded("running"), "timeline");
    const text = t.host.textContent ?? "";
    expect(text).toContain("Learning from your grade");
    expect(text).not.toContain("Steps appear as the agent takes them.");
  });

  it("shows its answer while the run is open again, then reads completed once the look-back ends", async () => {
    const t = await open(served(), graded("running"));
    expect(t.badge()).toContain("Completed");
    await t.show(reopened());
    expect(t.badge()).toContain("Learning from your grade");
    expect(t.host.textContent).toContain(ANSWER);
    await t.show(served({ ended_at: "2026-11-03T18:51:09Z" }), graded("ended"));
    expect(t.badge()).toContain("Completed");
    expect(t.badge()).not.toContain("Learning from your grade");
  });

  it("is not a run doing its job: no grade, or a grade whose look-back ended (a follow-up), or its first look-back before an answer", async () => {
    for (const [r, g] of [
      [reopened(), null],
      [reopened(), graded("ended")],
      [reopened(), graded("not_run")],
      [reopened({ learning: { ...KEPT!, state: "reflecting", reason: null } }), null],
    ] as [Run, RunGraded | null][]) {
      const t = await open(r, g);
      expect(t.badge()).toContain("Working");
      expect(t.badge()).not.toContain("Learning from your grade");
      expect(t.buttons().some((b) => b.includes("Cancel run"))).toBe(true);
      expect(t.buttons().some((b) => b.includes("Raise the cap"))).toBe(true);
      expect(t.host.textContent).toContain("Writing the answer");
      act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    }
  });
});
