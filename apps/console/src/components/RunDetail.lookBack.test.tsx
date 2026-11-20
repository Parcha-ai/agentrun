import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail } from "@/components/RunDetail";
import { messageFeatures } from "@/fixtures";
import type { Run, RunGraded, RunLearningRead } from "@/lib/v2";

// A run looking back (its learning `reflecting`) after its job ended, as the server serves it: completed, with its answer
// and its end time, still polled (poll_after_ms 1000). Its page shows the answer, offers no Stop or Cancel (the server
// refuses both on an ended run), and says it is learning: from the grade when a grade's round opened it, from the run
// itself when it is the run's own look-back. The look-back keeps the run's end, so its learning settling (not its end
// moving) is what says a grade's round ended.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const ANSWER = "6100";
const REFLECTING: Run["learning"] = { detail: "Looking back on this run.", at: "2026-11-14T10:02:01Z", state: "reflecting", reason: null };
const MERGED: Run["learning"] = { detail: null, at: "2026-11-14T10:02:30Z", state: "merged", reason: null, workflows: [] };
const run = (learning: Run["learning"] = REFLECTING): Run => ({ sha: null, updated_at: "2026-11-14T00:00:00Z", poll_after_ms: learning?.state === "reflecting" ? 1000 : 0, place: { mode: "runner" },
  run_id: "run-g", agent_id: "sorter", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "invoice 17",
  created_at: "2026-11-14T10:00:00Z", ended_at: "2026-11-14T10:00:09Z", result: { final_answer: ANSWER }, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null,
  learning,
} as Run);
const graded = (feedback_status: RunGraded["feedback_status"]): RunGraded => ({ run_id: "run-g", correct: false, source: "feedback", graded_at: "2026-11-14T10:02:00.000Z", path: "agent", workflow: null, workflow_digest: null, feedback: "correction", feedback_status });
const read = (grade?: RunGraded): RunLearningRead => ({
  run: "run-g", state: "reflecting", reason: null, detail: null, at: "2026-11-14T10:02:01Z", seed: "c1", merged: null, workflows: [], corrections: 0, problems: [], compiled: null, draft_errors: [],
  used: { workflows: [] }, ...(grade ? { graded: grade } : {}),
});

async function open(grade?: RunGraded) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  // The server's learning read: the grade as it stands now (its round running, then ended).
  let stored = grade;
  const actions = { onStop: () => {}, onCancel: () => {}, busy: null };
  const show = (r: Run) => root!.render(createElement(RunDetail, { run: r, agentName: "Invoice sorter", messages: messageFeatures, harnessSteers: true, rows: [], files: [], tab: "report", actions, readLearning: async () => read(stored), onGrade: async () => { throw new Error("not sent"); } } as Parameters<typeof RunDetail>[0]));
  act(() => show(run()));
  await settle();
  const buttons = () => [...host.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
  const cue = () => host.querySelector('[aria-label="Learning"][role="status"]')?.textContent;
  const gradeText = () => host.querySelector('section[aria-label="Grade"]')?.textContent ?? "";
  /** The round settles on the server: its grade's round ended, the run read again with its learning merged, its end kept. */
  const settled = async () => { if (stored) stored = { ...stored, feedback_status: "ended" }; act(() => show(run(MERGED))); await settle(); };
  return { host, buttons, cue, gradeText, settled };
}

describe("a completed run whose learning looks back", () => {
  it("after a grade: shows its answer, no Stop or Cancel, and that it is learning from the grade", async () => {
    const t = await open(graded("running"));
    expect(t.host.textContent).toContain(ANSWER);
    expect(t.host.textContent).not.toContain("Writing the answer");
    expect(t.buttons().filter((b) => /Cancel run|Stop/.test(b))).toEqual([]);
    expect(t.cue()).toBe("Learning from your grade");
    expect(t.gradeText()).toContain("Reviewing");
  });
  it("its own look-back: the same, learning from the run", async () => {
    const t = await open();
    expect(t.host.textContent).toContain(ANSWER);
    expect(t.buttons().filter((b) => /Cancel run|Stop/.test(b))).toEqual([]);
    expect(t.cue()).toBe("Learning from this run");
  });
  it("once the grade's round settles with the run's end unchanged, reads its learning again: no longer reviewing, no cue", async () => {
    const t = await open(graded("running"));
    await t.settled();
    expect(t.cue()).toBeUndefined();
    expect(t.gradeText()).not.toContain("Reviewing");
    expect(t.host.textContent).toContain(ANSWER);
  });
});
