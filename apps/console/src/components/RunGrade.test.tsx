import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail } from "@/components/RunDetail";
import { NO_WORDS } from "@/components/RunGrade";
import { messageFeatures } from "@/fixtures";
import { ClientError } from "@/lib/client";
import type { GradeAnswer, GradeBody, Run, RunGraded, RunLearningRead } from "@/lib/v2";

// The run page's Grade control (PUT /v2/runs/{id}/grade): on an ended run that learns, Right, or Wrong with the
// reviewer's words (`label`) and the fields a right answer holds (`expected`); the hint that a look-back needs words; a
// graded run's grade read back (GET /v2/runs/{id}/learning `graded`) with a re-grade; nothing where a grade teaches nothing.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const LEARNS: Run["learning"] = { detail: null, at: "2026-11-14T10:00:09Z", state: "dropped", reason: "empty" };
const run = (over: Partial<Run> = {}): Run => ({ sha: null, updated_at: "2026-11-14T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "run-g", agent_id: "sorter", agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title: "invoice 17",
  created_at: "2026-11-14T10:00:00Z", ended_at: "2026-11-14T10:00:09Z", result: { final_answer: "6100" }, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, learning: LEARNS, ...over,
} as Run);
const read = (graded?: RunGraded): RunLearningRead => ({
  run: "run-g", state: "dropped", reason: "empty", detail: null, at: "2026-11-14T10:00:09Z", seed: "c1", merged: null, pending: [], verdict: null, problems: [], compiled: null, draft_errors: [],
  cost_usd: { grade: null }, tokens: { grade: null }, used: { skills: [], workflows: [] }, ...(graded ? { graded } : {}),
});
const answer = (body: GradeBody, feedback: GradeAnswer["feedback"]): GradeAnswer => ({ run_id: "run-g", correct: body.correct, source: "feedback", graded_at: "2026-11-14T10:05:00.000Z", path: "agent", workflow: null, workflow_digest: null, feedback });

/** A grade as the learning read gives it back: the PUT's answer without `expected`. */
const gradedOf = (over: Partial<RunGraded> = {}): RunGraded => ({ run_id: "run-g", correct: false, source: "feedback", graded_at: "2026-11-14T10:02:00.000Z", path: "agent", workflow: null, workflow_digest: null, feedback: null, ...over });

async function open(r: Run, { graded, grade }: { graded?: RunGraded; grade?: (body: GradeBody) => Promise<GradeAnswer> } = {}) {
  const sent: GradeBody[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  // The server's side: the learning read gives back the newest grade it took. A grade that opens a round opens the run
  // again, and the page reads the run again before the answer returns (LiveRun's grade).
  let stored = graded;
  const show = (next: Run) => root!.render(createElement(RunDetail, { ...props, run: next }));
  const props = { run: r, agentName: "Invoice sorter", messages: messageFeatures, harnessSteers: true, rows: [], files: [], tab: "report" as const,
    readLearning: async () => read(stored),
    onGrade: async (body: GradeBody) => {
      sent.push(body);
      const { expected: _, ...a } = grade ? await grade(body) : answer(body, body.label ? "look_back" : null);
      stored = a;
      if (a.feedback) show({ ...r, status: "working", state: "working", ended_at: null });
      return a;
    } };
  act(() => show(r));
  await settle();
  const section = () => host.querySelector('section[aria-label="Grade"]') as HTMLElement | null;
  const button = (name: string) => [...(section()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === name) as HTMLButtonElement | undefined;
  const click = async (name: string) => { const b = button(name); expect(b, `a ${name} button`).toBeTruthy(); await act(async () => { b!.click(); }); await settle(); };
  const boxes = () => [...(section()?.querySelectorAll("textarea") ?? [])] as HTMLTextAreaElement[];
  const type = async (box: HTMLTextAreaElement, text: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text); box.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const rerender = async (next: Run) => { act(() => show(next)); await settle(); };
  // A tab of the run page, by the start of its label ("Files 0").
  const tab = async (name: string) => {
    const b = [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.startsWith(name)) as HTMLButtonElement | undefined;
    expect(b, `a ${name} tab`).toBeTruthy();
    await act(async () => { b!.click(); });
    await settle();
  };
  return { host, sent, section, button, click, boxes, type, rerender, tab };
}

/** A grade's answer that opened a `revise` round: a learned workflow gave the answer alone. */
const revised = (body: GradeBody): GradeAnswer => ({ ...answer(body, "revise"), path: "workflow", workflow: "sort-invoice", workflow_digest: "0123456789abcdef" });
const WORKFLOW = { file: "workflows/sort-invoice/workflow.json", name: "sort-invoice" };

describe("a run's page, the Grade control", () => {
  it("grades it right in one click, and shows the grade with a way to grade again", async () => {
    const t = await open(run());
    expect(t.section()!.textContent).toContain("Was the answer right?");
    await t.click("Right");
    expect(t.sent).toEqual([{ correct: true }]);
    const text = t.section()!.textContent ?? "";
    expect(text).toContain("Graded right");
    expect(text).toContain("Kept for this agent.");
    expect(text).not.toContain("Reviewing");
    expect(t.button("Grade again")).toBeTruthy();
    expect(t.button("Right")).toBeUndefined();
  });

  it("grades it wrong with the reviewer's words and the correct answer, and says the look-back runs until the run ends again", async () => {
    const t = await open(run());
    await t.click("Wrong");
    const [words, expected] = t.boxes();
    await t.type(words!, "  The account is 6400 Shipping: Northwind is a freight vendor.  ");
    await t.type(expected!, '{"account": "6400"}');
    await t.click("Send grade");
    expect(t.sent).toEqual([{ correct: false, label: "The account is 6400 Shipping: Northwind is a freight vendor.", expected: { account: "6400" } }]);
    let text = t.section()!.textContent ?? "";
    expect(text).toContain("Graded wrong");
    expect(text).toContain("Reviewing");
    expect(text).toContain("The agent is looking back on your words.");
    expect(t.button("Open the Timeline")).toBeTruthy();
    // The run, open again on the round, then ended again: the round is done.
    await t.rerender(run({ status: "working", state: "working", ended_at: null }));
    expect(t.section()!.textContent).toContain("Reviewing");
    await t.rerender(run({ ended_at: "2026-11-14T10:06:00Z" }));
    text = t.section()!.textContent ?? "";
    expect(text).not.toContain("Reviewing");
    expect(text).toContain("The agent looked back on your words.");
    expect(t.button("Grade again")).toBeTruthy();
  });

  it("says a look-back needs words while they are empty, and sends a wrong grade without them", async () => {
    const t = await open(run());
    await t.click("Wrong");
    expect(t.section()!.textContent).toContain(NO_WORDS);
    await t.type(t.boxes()[0]!, "Wrong vendor.");
    expect(t.section()!.textContent).not.toContain(NO_WORDS);
    await t.type(t.boxes()[0]!, "   ");
    expect(t.section()!.textContent).toContain(NO_WORDS);
    await t.click("Send grade");
    expect(t.sent).toEqual([{ correct: false }]);
    const text = t.section()!.textContent ?? "";
    expect(text).toContain("Graded wrong");
    expect(text).not.toContain("Reviewing");
    expect(t.section()!.querySelector('[role="status"]')?.textContent).toBe("Kept for this agent.");
  });

  it("refuses a correct answer that is not a JSON object before sending, in words", async () => {
    const t = await open(run());
    await t.click("Wrong");
    await t.type(t.boxes()[1]!, "6400");
    await t.click("Send grade");
    expect(t.sent).toEqual([]);
    expect(t.section()!.querySelector('[role="alert"]')?.textContent).toMatch(/JSON object/);
  });

  it("shows a graded run's grade read back, reviewing while the run is open again, and a re-grade replaces it", async () => {
    const graded = gradedOf({ feedback: "look_back" });
    const open1 = await open(run({ status: "working", state: "working", ended_at: null }), { graded });
    let text = open1.section()!.textContent ?? "";
    expect(text).toContain("Graded wrong");
    expect(text).toContain("Reviewing");
    expect(open1.button("Grade again")).toBeUndefined();
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";

    const t = await open(run(), { graded });
    text = t.section()!.textContent ?? "";
    expect(text).toContain("Graded wrong");
    expect(text).not.toContain("Reviewing");
    expect(t.button("Right")).toBeUndefined();
    await t.click("Grade again");
    expect(t.section()!.textContent).toContain("Was the answer right?");
    await t.click("Right");
    expect(t.sent).toEqual([{ correct: true }]);
    expect(t.section()!.textContent).toContain("Graded right");
  });

  it("says a finished round's outcome after a reload, from the grade read back", async () => {
    const t = await open(run(), { graded: gradedOf({ feedback: "look_back" }) });
    const text = t.section()!.textContent ?? "";
    expect(text).toContain("Graded wrong");
    expect(text).not.toContain("Reviewing");
    expect(t.section()!.querySelector('[role="status"]')?.textContent).toBe("The agent looked back on your words.");
    expect(t.button("Open the Timeline")).toBeTruthy();
    expect(t.button("Grade again")).toBeTruthy();
  });

  it("is still reviewing after a reload while the round's learning settles: no Grade again until it has", async () => {
    const settling = run({ learning: { ...LEARNS!, state: "reflecting", reason: null } });
    const t = await open(settling, { graded: gradedOf({ feedback: "look_back" }) });
    const text = t.section()!.textContent ?? "";
    expect(text).toContain("Reviewing");
    expect(text).toContain("The agent is looking back on your words.");
    expect(t.button("Grade again")).toBeUndefined();
    await t.rerender(run());
    expect(t.section()!.textContent).not.toContain("Reviewing");
    expect(t.button("Grade again")).toBeTruthy();
  });

  it("keeps a grade it sent across a tab switch, and the round it opened stays said", async () => {
    const t = await open(run());
    await t.click("Right");
    await t.tab("Files");
    expect(t.section()).toBeNull();
    await t.tab("Report");
    let text = t.section()!.textContent ?? "";
    expect(text).toContain("Graded right");
    expect(text).toContain("Kept for this agent.");
    expect(t.button("Right")).toBeUndefined();
    expect(t.button("Grade again")).toBeTruthy();
    // Wrong with words: the look-back it opened is still said after Files and back, and on the Timeline.
    await t.click("Grade again");
    await t.click("Wrong");
    await t.type(t.boxes()[0]!, "Wrong vendor.");
    await t.click("Send grade");
    await t.tab("Files");
    await t.tab("Timeline");
    text = t.section()!.textContent ?? "";
    expect(text).toContain("Graded wrong");
    expect(text).toContain("Reviewing");
    expect(text).toContain("The agent is looking back on your words.");
    await t.tab("Report");
    expect(t.section()!.textContent).toContain("The agent is looking back on your words.");
  });

  it("shows a re-grade, not the grade it replaced, after a tab switch", async () => {
    const t = await open(run(), { graded: gradedOf() });
    expect(t.section()!.textContent).toContain("Graded wrong");
    await t.click("Grade again");
    await t.click("Right");
    await t.tab("Files");
    await t.tab("Report");
    const text = t.section()!.textContent ?? "";
    expect(text).toContain("Graded right");
    expect(text).not.toContain("Graded wrong");
  });

  it("says a finished revise round revised the workflow only when its change was kept", async () => {
    const reopened = run({ status: "working", state: "working", ended_at: null, learning: { ...LEARNS!, state: "reflecting", reason: null } });
    const ends = (learning: Run["learning"]) => run({ ended_at: "2026-11-14T10:06:00Z", learning });
    const cases: [Run["learning"], string][] = [
      [{ ...LEARNS!, state: "merged", reason: null, workflows: [WORKFLOW] }, "The learned workflow that answered was revised with your grade."],
      [{ ...LEARNS!, state: "merged", reason: null, workflows: [{ ...WORKFLOW, pending: true }] }, "The learned workflow that answered was revised with your grade. The revision waits for your OK."],
      // Its draft failed the checks: nothing kept.
      [{ ...LEARNS!, state: "dropped", reason: "checker" }, "The agent looked back at your grade; nothing changed."],
      // A note kept, the workflow's revision not.
      [{ ...LEARNS!, state: "merged", reason: null, learned: [{ file: "vendors.md", name: "vendors", supersedes: [] }] }, "The agent looked back at your grade; nothing changed."],
    ];
    for (const [learning, said] of cases) {
      const t = await open(run(), { grade: async (body) => revised(body) });
      await t.click("Wrong");
      await t.type(t.boxes()[0]!, "Northwind is a freight vendor.");
      await t.click("Send grade");
      expect(t.section()!.textContent).toContain("The learned workflow that answered is being revised with your grade.");
      await t.rerender(reopened);
      expect(t.section()!.textContent).toContain("Reviewing");
      await t.rerender(ends(learning));
      const text = t.section()!.textContent ?? "";
      expect(text).not.toContain("Reviewing");
      expect(text).toContain(said);
      if (said.includes("nothing changed")) expect(text).not.toContain("was revised");
      act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    }
  });

  it("says a refused grade in the server's words and keeps the choice", async () => {
    const t = await open(run(), { grade: async () => { throw new ClientError(422, "invalid_input", "A replay run is never graded: its answer is scored against the run it replays."); } });
    await t.click("Right");
    expect(t.section()!.querySelector('[role="alert"]')?.textContent).toContain("A replay run is never graded");
    expect(t.button("Right")).toBeTruthy();
  });

  it("is not there for a run that does not learn, one that only uses what was learned, or one under way with no grade", async () => {
    for (const r of [run({ learning: null }), run({ learning: { ...LEARNS!, reason: "use" } }), run({ status: "working", state: "working", ended_at: null, learning: { ...LEARNS!, state: "seeded", reason: null } })]) {
      const t = await open(r);
      expect(t.section()).toBeNull();
      act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    }
  });
});
