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
  run: "run-g", state: "dropped", reason: "empty", detail: null, at: "2026-11-14T10:00:09Z", seed: "c1", seed_failed: null, learned_chars: 0, merged: null, workflows: [], corrections: 0, problems: [], compiled: null, draft_errors: [],
  used: { workflows: [] }, ...(graded ? { graded } : {}),
});
const answer = (body: GradeBody, feedback: GradeAnswer["feedback"]): GradeAnswer => ({ run_id: "run-g", correct: body.correct, source: "feedback", graded_at: "2026-11-14T10:05:00.000Z", path: "agent", workflow: null, workflow_digest: null, feedback });

/** A grade as the learning read gives it back: the PUT's answer without `expected`, and how its round stands (running
 *  unless `over` says otherwise; none for a grade that opened none). */
const gradedOf = (over: Partial<RunGraded> = {}): RunGraded => ({ run_id: "run-g", correct: false, source: "feedback", graded_at: "2026-11-14T10:02:00.000Z", path: "agent", workflow: null, workflow_digest: null, feedback: null, feedback_status: over.feedback ? "running" : null, ...over });
/** The sentence a round that could not run says. */
const NOT_RUN = "The review could not run.";
/** The run's end after gradedOf's round: the round it opened ended the run again. */
const ENDED_AGAIN = "2026-11-14T10:03:00Z";
/** A run's end dated before the grade (gradedOf's 10:02, answer's 10:05) by a runner whose clock trails the server's. */
const ENDED_SKEWED = "2026-11-14T10:01:00Z";

/** `readLearning`: the page's learning read in place of the server's (one still pending, one that failed, an older one).
 *  `refreshed: false`: the run read after the PUT failed, so the page still holds the run as it was before the grade. */
async function open(r: Run, { graded, grade, readLearning, refreshed = true }: { graded?: RunGraded; grade?: (body: GradeBody) => Promise<GradeAnswer>; readLearning?: () => Promise<RunLearningRead>; refreshed?: boolean } = {}) {
  const sent: GradeBody[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  // The server's side: the learning read gives back the newest grade it took, and how the round it opened stands (its
  // run's journal and its steer's row say so, `end` below). A grade that opens a round opens the run again, and the page
  // reads the run again before the answer returns (LiveRun's grade). `failing`: how many of the next reads fail.
  let stored = graded;
  let failing = 0;
  let reads = 0;
  const show = (next: Run) => root!.render(createElement(RunDetail, { ...props, run: next }));
  const props = { run: r, agentName: "Invoice sorter", messages: messageFeatures, harnessSteers: true, rows: [], files: [], tab: "report" as const,
    readLearning: readLearning ?? (async () => {
      reads += 1;
      if (failing > 0) { failing -= 1; throw new Error("read failed"); }
      return read(stored);
    }),
    onGrade: async (body: GradeBody) => {
      sent.push(body);
      const { expected: _, ...a } = grade ? await grade(body) : answer(body, body.label ? "correction" : null);
      stored = { ...a, feedback_status: a.feedback ? "running" : null };
      if (a.feedback && refreshed) show({ ...r, status: "working", state: "working", ended_at: null });
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
  // The round the grade opened settles on the server (`as`: its run's end after its words, or an end before the runner
  // took them), and the page reads the run as `next`.
  const end = async (next: Run, as: "ended" | "not_run" = "ended") => { if (stored?.feedback) stored = { ...stored, feedback_status: as }; await rerender(next); };
  const failNext = (n: number) => { failing = n; };
  const readCount = () => reads;
  // A tab of the run page, by the start of its label ("Files 0").
  const tab = async (name: string) => {
    const b = [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.startsWith(name)) as HTMLButtonElement | undefined;
    expect(b, `a ${name} tab`).toBeTruthy();
    await act(async () => { b!.click(); });
    await settle();
  };
  return { host, sent, section, button, click, boxes, type, rerender, end, tab, failNext, readCount };
}

/** A grade's answer on a run a learned workflow answered alone: it opens no round, right or wrong. */
const served = (body: GradeBody): GradeAnswer => ({ ...answer(body, null), path: "workflow", workflow: "sort-invoice", workflow_digest: "0123456789abcdef" });

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
    // The fields are found by position (copy-independent), so a broken label link is checked here: each has a name.
    for (const box of [words!, expected!]) expect([...(box.labels ?? [])].map((l) => l.textContent?.trim()).join("") || box.getAttribute("aria-label"), "a textbox's accessible name").toBeTruthy();
    await t.type(words!, "  The account is 6400 Shipping: Northwind is a freight vendor.  ");
    await t.type(expected!, '{"account": "6400"}');
    await t.click("Send grade");
    expect(t.sent).toEqual([{ correct: false, label: "The account is 6400 Shipping: Northwind is a freight vendor.", expected: { account: "6400" } }]);
    let text = t.section()!.textContent ?? "";
    expect(text).toContain("Graded wrong");
    expect(text).toContain("Reviewing");
    expect(text).toContain("Your words are being added to its corrections.");
    expect(t.button("Open the Timeline")).toBeTruthy();
    // The run, open again on the round, then ended again: the round is done.
    await t.rerender(run({ status: "working", state: "working", ended_at: null }));
    expect(t.section()!.textContent).toContain("Reviewing");
    await t.end(run({ ended_at: "2026-11-14T10:06:00Z" }));
    text = t.section()!.textContent ?? "";
    expect(text).not.toContain("Reviewing");
    expect(text).toContain("Your words were added to its corrections.");
    expect(t.button("Grade again")).toBeTruthy();
  });

  // Review on #2858 (round 2): `graded_at` is the API server's clock, `ended_at` the runner's. The round's end is the
  // server's word (`feedback_status`, read from the run's journal), never the two clocks compared.
  it("shows a finished round's outcome when the runner's clock trails the server's: the run's end dated before the grade", async () => {
    const t = await open(run());
    await t.click("Wrong");
    await t.type(t.boxes()[0]!, "Wrong vendor.");
    await t.click("Send grade");
    await t.rerender(run({ status: "working", state: "working", ended_at: null }));
    expect(t.section()!.textContent).toContain("Reviewing");
    await t.end(run({ ended_at: ENDED_SKEWED }));
    let text = t.section()!.textContent ?? "";
    expect(text).not.toContain("Reviewing");
    expect(text).toContain("Your words were added to its corrections.");
    expect(t.button("Grade again")).toBeTruthy();
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";

    // And after a reload.
    const again = await open(run({ ended_at: ENDED_SKEWED }), { graded: gradedOf({ feedback: "correction", feedback_status: "ended" }) });
    text = again.section()!.textContent ?? "";
    expect(text).not.toContain("Reviewing");
    expect(again.section()!.querySelector('[role="status"]')?.textContent).toBe("Your words were added to its corrections.");
    expect(again.button("Grade again")).toBeTruthy();
  });

  it("stays reviewing while the server says the round runs, even once the page's run reads ended after the grade", async () => {
    const t = await open(run());
    await t.click("Wrong");
    await t.type(t.boxes()[0]!, "Wrong vendor.");
    await t.click("Send grade");
    await t.rerender(run({ ended_at: "2026-11-14T10:06:00Z" }));
    let text = t.section()!.textContent ?? "";
    expect(text).toContain("Reviewing");
    expect(text).toContain("Your words are being added to its corrections.");
    expect(t.button("Grade again")).toBeUndefined();
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";

    // And after a reload.
    const again = await open(run({ ended_at: "2026-11-14T10:06:00Z" }), { graded: gradedOf({ feedback: "correction" }) });
    text = again.section()!.textContent ?? "";
    expect(text).toContain("Reviewing");
    expect(again.button("Grade again")).toBeUndefined();
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
    const graded = gradedOf({ feedback: "correction" });
    const open1 = await open(run({ status: "working", state: "working", ended_at: null }), { graded });
    let text = open1.section()!.textContent ?? "";
    expect(text).toContain("Graded wrong");
    expect(text).toContain("Reviewing");
    expect(open1.button("Grade again")).toBeUndefined();
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";

    const t = await open(run({ ended_at: ENDED_AGAIN }), { graded: { ...graded, feedback_status: "ended" } });
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
    const t = await open(run({ ended_at: ENDED_AGAIN }), { graded: gradedOf({ feedback: "correction", feedback_status: "ended" }) });
    const text = t.section()!.textContent ?? "";
    expect(text).toContain("Graded wrong");
    expect(text).not.toContain("Reviewing");
    expect(t.section()!.querySelector('[role="status"]')?.textContent).toBe("Your words were added to its corrections.");
    expect(t.button("Open the Timeline")).toBeTruthy();
    expect(t.button("Grade again")).toBeTruthy();
  });

  it("is still reviewing after a reload while the round's learning settles: no Grade again until it has", async () => {
    const settling = run({ ended_at: ENDED_AGAIN, learning: { ...LEARNS!, state: "reflecting", reason: null } });
    const t = await open(settling, { graded: gradedOf({ feedback: "correction", feedback_status: "ended" }) });
    const text = t.section()!.textContent ?? "";
    expect(text).toContain("Reviewing");
    expect(text).toContain("Your words are being added to its corrections.");
    expect(t.button("Grade again")).toBeUndefined();
    await t.rerender(run({ ended_at: ENDED_AGAIN }));
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
    expect(text).toContain("Your words are being added to its corrections.");
    await t.tab("Report");
    expect(t.section()!.textContent).toContain("Your words are being added to its corrections.");
  });

  it("keeps the grade it sent while the learning read is still pending, or failed", async () => {
    for (const readLearning of [() => new Promise<RunLearningRead>(() => {}), async () => { throw new Error("read failed"); }]) {
      const t = await open(run(), { readLearning });
      await t.click("Right");
      const text = t.section()!.textContent ?? "";
      expect(text).toContain("Graded right");
      expect(text).toContain("Kept for this agent.");
      expect(t.button("Grade again")).toBeTruthy();
      act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    }
  });

  it("never lets an older learning read replace a newer grade", async () => {
    // The read started before the grade answers with the grade it replaced, after the PUT's answer.
    let answerRead: (r: RunLearningRead) => void = () => {};
    const t = await open(run(), { readLearning: () => new Promise((resolve) => { answerRead = resolve; }) });
    await t.click("Right");
    expect(t.section()!.textContent).toContain("Graded right");
    await act(async () => { answerRead(read(gradedOf())); });
    await t.rerender(run());
    expect(t.section()!.textContent).toContain("Graded right");
    expect(t.section()!.textContent).not.toContain("Graded wrong");
  });

  it("keeps the round it opened reviewing when the run read after the grade failed, until the learning read says it ended", async () => {
    const t = await open(run(), { refreshed: false });
    await t.click("Wrong");
    await t.type(t.boxes()[0]!, "Wrong vendor.");
    await t.click("Send grade");
    // The page still holds the run as it ended before the grade.
    let text = t.section()!.textContent ?? "";
    expect(text).toContain("Reviewing");
    expect(text).toContain("Your words are being added to its corrections.");
    expect(t.button("Grade again")).toBeUndefined();
    // The page's run read later brings the run's new end, which reads the learning again.
    await t.end(run({ ended_at: "2026-11-14T10:06:00Z" }));
    text = t.section()!.textContent ?? "";
    expect(text).not.toContain("Reviewing");
    expect(text).toContain("Your words were added to its corrections.");
    expect(t.button("Grade again")).toBeTruthy();
  });

  // Review on #2858 (round 3): a reopened run can end before its runner takes the grade's words (its claim refused: an end
  // with nothing sent). The server reads that round settled, not run (`not_run`): one plain sentence, and a new grade.
  it("says a round that could not run in one sentence, with Grade again, live and after a reload", async () => {
    const refused = run({ status: "failed", ended_at: "2026-11-14T10:06:00Z", result: null, error: { code: "run_failed", message: "The MCP server crm can't be used. Nothing was sent.", retryable: false } });
    const t = await open(run());
    await t.click("Wrong");
    await t.type(t.boxes()[0]!, "Wrong vendor.");
    await t.click("Send grade");
    await t.rerender(run({ status: "working", state: "working", ended_at: null }));
    expect(t.section()!.textContent).toContain("Reviewing");
    await t.end(refused, "not_run");
    let text = t.section()!.textContent ?? "";
    expect(text).not.toContain("Reviewing");
    expect(t.section()!.querySelector('[role="status"]')?.textContent).toBe(NOT_RUN);
    expect(text).not.toContain("looked back");
    expect(t.button("Grade again")).toBeTruthy();
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";

    // And after a reload, the same.
    const again = await open(refused, { graded: gradedOf({ feedback: "correction", feedback_status: "not_run" }) });
    text = again.section()!.textContent ?? "";
    expect(text).not.toContain("Reviewing");
    expect(again.section()!.querySelector('[role="status"]')?.textContent).toBe(NOT_RUN);
    expect(again.button("Grade again")).toBeTruthy();
  });

  // Review on #2858 (round 3): the learning read after the round's end failed. While the grade's round is unsettled, the
  // page reads it again on a backoff, and stops once a read says the round settled.
  it("reads the learning again after a failed read while the round is unsettled, then shows it ended and stops", async () => {
    const t = await open(run());
    await t.click("Wrong");
    await t.type(t.boxes()[0]!, "Wrong vendor.");
    await t.click("Send grade");
    await t.rerender(run({ status: "working", state: "working", ended_at: null }));
    t.failNext(1);
    const before = t.readCount();
    await t.end(run({ ended_at: "2026-11-14T10:06:00Z" }));
    expect(t.readCount()).toBe(before + 1);
    expect(t.section()!.textContent).toContain("Reviewing");
    // The next read, on the backoff's first wait (1 s).
    await act(async () => { await new Promise((r) => setTimeout(r, 1_100)); });
    await settle();
    expect(t.readCount()).toBe(before + 2);
    const text = t.section()!.textContent ?? "";
    expect(text).not.toContain("Reviewing");
    expect(text).toContain("Your words were added to its corrections.");
    expect(t.button("Grade again")).toBeTruthy();
    // Settled: no read after it.
    await act(async () => { await new Promise((r) => setTimeout(r, 1_100)); });
    expect(t.readCount()).toBe(before + 2);
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

  // A wrong grade of a run its learned workflow answered alone opens no round (the workflow's graded hold reads it): the
  // grade is kept, said so at once, and nothing is reviewed.
  it("says a wrong grade of a served run is kept, with no round", async () => {
    const t = await open(run(), { grade: async (body) => served(body) });
    await t.click("Wrong");
    await t.type(t.boxes()[0]!, "Northwind is a freight vendor.");
    await t.click("Send grade");
    const text = t.section()!.textContent ?? "";
    expect(text).toContain("Kept for this agent.");
    expect(text).not.toContain("Reviewing");
    expect(text).not.toMatch(/revis/i);
  });

  it("says a refused grade in the server's words and keeps the choice", async () => {
    const t = await open(run(), { grade: async () => { throw new ClientError(422, "invalid_input", "A replay run is never graded: its answer is scored against the run it replays."); } });
    await t.click("Right");
    expect(t.section()!.querySelector('[role="alert"]')?.textContent).toContain("A replay run is never graded");
    expect(t.button("Right")).toBeTruthy();
  });

  // One rule for when a grade is refused, the server's: a run whose row has ended can still read `reflecting` while what
  // it wrote is checked, and the server takes its grade. Only the server knows when it refuses one (409 run_learning).
  const REFLECTING: Run["learning"] = { detail: null, at: "2026-11-14T10:00:09Z", state: "reflecting", reason: null };
  const LEARNING_409 = "The run is still learning from its answer: grade it once that ends.";

  it("offers the grade on an ended run that reads reflecting, and sends it", async () => {
    const t = await open(run({ learning: REFLECTING }));
    expect(t.section()!.textContent).toContain("Was the answer right?");
    await t.click("Right");
    expect(t.sent).toEqual([{ correct: true }]);
  });

  it("says a 409 run_learning in the server's words and keeps the choice", async () => {
    const t = await open(run({ poll_after_ms: 1000, learning: REFLECTING }), { grade: async () => { throw new ClientError(409, "run_learning", LEARNING_409); } });
    await t.click("Right");
    expect(t.section()!.querySelector('[role="alert"]')?.textContent).toBe(`Your grade wasn't taken: ${LEARNING_409}`);
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
