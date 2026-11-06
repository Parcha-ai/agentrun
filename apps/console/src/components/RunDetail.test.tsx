import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import type { Run } from "@/lib/v2";

const page = (run: Run, rows: ReturnType<typeof runFixture>["page"]["rows"]) =>
  renderToStaticMarkup(createElement(RunDetail, { run, agentName: "invoice-checker", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, onMessage: () => {} }))
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const times = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// A run waiting on a question (recorded: run.input_required.waiting.1) asks it once: in the banner above, where it's
// answered. The timeline's step for it points there instead of saying it again.
describe("RunDetail, a run waiting on a question", () => {
  const f = runFixture("run.input_required.waiting.1");
  const question = "Which currency are these amounts in: USD or EUR?";

  it("shows the question once, in the banner, and the timeline points to it", () => {
    expect(f.page.rows.some((r) => r.kind === "waiting")).toBe(true);
    const shown = page(f.run, f.page.rows);
    expect(times(shown, question)).toBe(1);
    expect(shown).toContain("Input required");
    expect(shown).toContain("Asked you the question above.");
  });

  it("once it's answered, the timeline says the question again: the banner is gone", () => {
    const shown = page({ ...f.run, status: "working", state: "working" }, f.page.rows);
    expect(times(shown, question)).toBe(1);
    expect(shown).not.toContain("Asked you the question above.");
  });
});

// A run paused at its spend cap waits on a raise, not an answer: a message to it is refused (409 budget_reached).
describe("RunDetail, a run paused at its spend cap", () => {
  const f = runFixture("run.input_required.waiting.1");
  // Words with no apostrophe: the page's markup escapes one (&#x27;), and these tests read its text as written.
  const SAID = "Not sent: this run has spent $0.04 of its $0.05 cap, and the next step needs at least $0.11. Raise the cap to at least $0.16 to continue.";
  const paused: Run = { ...f.run, pending: { kind: "budget", cap_usd: 0.05, spent_usd: 0, needs_usd: 0.1024, said: SAID, at: "2026-11-04T20:08:05.127Z" } };
  it("shows the cap's words in the banner and offers no composer: no answer, no follow-up", () => {
    const shown = page(paused, f.page.rows);
    expect(shown).toContain("Paused at its $0.05 spend cap");
    expect(shown).toContain(SAID);
    expect(shown).not.toContain("Answer the question");
    expect(shown).not.toContain("Ask a follow-up");
    // The banner is the cap's, not a question's (the run's header keeps its status, input required).
    expect(shown).not.toContain("Asked you the question above.");
  });
});

// The Report tab of a run with no answer yet says what is true of it: working, waiting on the person, stopped or paused.
// Only a queued or working run reads "Writing the answer"; one that ended says how (the error, the cancel, no answer).
describe("RunDetail's Report tab before an answer", () => {
  const report = (run: Run, rows: ReturnType<typeof runFixture>["page"]["rows"], messages = messageFeatures) =>
    renderToStaticMarkup(createElement(RunDetail, { run, agentName: "invoice-checker", messages, harnessSteers: true, rows, files: [], actions: {}, onMessage: () => {}, tab: "report" }))
      .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  const WRITING = "Writing the answer";

  it("a run that asked a question waits for the answer, and points at the box below", () => {
    const f = runFixture("run.input_required.waiting.1");
    const shown = report(f.run, f.page.rows);
    expect(shown).not.toContain(WRITING);
    expect(shown).toContain("Waiting for your answer");
    expect(shown).toContain("The run continues when you reply below.");
  });

  it("where the server takes no answer from here, it says it waits for one, never that a box below takes it", () => {
    const f = runFixture("run.input_required.waiting.1");
    const shown = report(f.run, f.page.rows, { ...messageFeatures, answer: false, follow_up: false, steer: false });
    expect(shown).not.toContain(WRITING);
    expect(shown).toContain("Waiting for your answer");
    expect(shown).toContain("The run continues once the question is answered.");
    expect(shown).not.toContain("reply below");
  });

  it("a budget pause the server sends without its figures (kind only) shows the pause without an amount, and its page still opens", () => {
    for (const [name, state] of [["run.input_required.waiting.1", "waiting"], ["run.input_required.idle.1", "idle"]] as const) {
      const f = runFixture(name);
      const run = { ...f.run, state, pending: { kind: "budget" } } as unknown as Run;
      const shown = report(run, f.page.rows);
      expect(shown, name).toContain("Paused at its spend cap");
      expect(shown, name).toContain("Its spend cap is reached. Raise the cap above to continue.");
      expect(shown, name).not.toMatch(/undefined|NaN/);
      // With a way to raise, the page still opens: no figure to name, so the banner offers no raise of its own.
      const withRaise = renderToStaticMarkup(createElement(RunDetail, { run, agentName: "invoice-checker", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: { onRaiseCap: async () => { throw new Error("no raise"); } }, onMessage: () => {}, tab: "report" }));
      expect(withRaise, name).not.toMatch(/undefined|NaN/);
    }
  });

  it("a run that waits on something this console doesn't know yet says it waits for you, never for an answer below or that it stopped", () => {
    // A kind of `pending` a newer server may send (one this console knows neither as a question, an approval nor a
    // budget pause): only its kind is read, nothing else of it.
    for (const [name, state] of [["run.input_required.waiting.1", "waiting"], ["run.input_required.idle.1", "idle"]] as const) {
      const f = runFixture(name);
      const run = { ...f.run, state, pending: { kind: "a_future_kind" } } as unknown as Run;
      const shown = report(run, f.page.rows);
      expect(shown, name).not.toContain(WRITING);
      expect(shown, name).toContain("Waiting for you");
      expect(shown, name).toContain("The run continues once you give it what it waits on.");
      expect(shown, name).not.toContain("Waiting for your answer");
      expect(shown, name).not.toContain("reply below");
      expect(shown, name).not.toContain("Stopped before it wrote an answer.");
    }
  });

  it("a run paused at its spend cap says so, with what it spent of its cap from the served figures, and points at the raise above", () => {
    const f = runFixture("run.input_required.waiting.1");
    const said = "Not sent: this run has spent $0.04 of its $0.05 cap.";
    const paused = { ...f.run, pending: { kind: "budget", cap_usd: 0.05, spent_usd: 0.04, needs_usd: 0.1024, said, at: "2026-11-04T20:08:05.127Z" } } as Run;
    const shown = report(paused, f.page.rows);
    expect(shown).not.toContain(WRITING);
    expect(shown).not.toContain("Waiting for you ");
    expect(shown).toContain("Paused at its spend cap");
    expect(shown).toContain("It has spent $0.04 of its $0.05 cap. Raise the cap above to continue.");
    // A server that sends the cap without the figures: said without them, never a figure it lacks.
    const bare = report({ ...paused, pending: { kind: "budget", cap_usd: 0.05, said, at: "2026-11-04T20:08:05.127Z" } } as Run, f.page.rows);
    expect(bare).toContain("Its $0.05 cap is reached. Raise the cap above to continue.");
  });

  it("a question the server names as one (pending.kind question) reads as a question", () => {
    const f = runFixture("run.input_required.waiting.1");
    const shown = report({ ...f.run, pending: { kind: "question", question: "Which currency are these amounts in: USD or EUR?", asked_at: f.run.created_at } }, f.page.rows);
    expect(shown).toContain("Waiting for your answer");
    expect(shown).toContain("The run continues when you reply below.");
  });

  it("a stopped run says it stopped before it wrote an answer, and that a message continues it", () => {
    const f = runFixture("run.input_required.idle.1");
    const shown = report(f.run, f.page.rows);
    expect(shown).not.toContain(WRITING);
    expect(shown).toContain("Stopped before it wrote an answer.");
    expect(shown).toContain("Send a message below to continue it.");
  });

  it("a paused workflow run says it is paused, not writing", () => {
    const f = runFixture("run.cancelled.idle.1");
    const shown = report({ ...f.run, status: "paused", state: "idle", result: null }, f.page.rows);
    expect(shown).not.toContain(WRITING);
    expect(shown).toContain("Paused");
    expect(shown).toContain("No new step starts until it's resumed. The answer appears here when it finishes.");
  });

  it("a failed run shows its error, a cancelled one says so, and a completed one with no answer says it gave none: none says writing", () => {
    const failed = runFixture("run.failed.idle.3");
    const f = report(failed.run, failed.page.rows);
    expect(f).not.toContain(WRITING);
    expect(f).toContain("The run failed");
    expect(f).toContain(failed.run.error!.code);
    const cancelled = runFixture("run.cancelled.idle.1");
    const c = report(cancelled.run, cancelled.page.rows);
    expect(c).not.toContain(WRITING);
    expect(c).toContain("This run was cancelled.");
    const done = runFixture("run.completed.idle.1");
    const d = report({ ...done.run, result: null }, done.page.rows.filter((r) => r.kind !== "final_answer"));
    expect(d).not.toContain(WRITING);
    expect(d).toContain("This run gave no answer.");
  });

  it("a queued or working run is the one that is writing the answer", () => {
    for (const name of ["run.queued.working.1", "run.working.working.1"]) {
      const f = runFixture(name);
      expect(report(f.run, f.page.rows), name).toContain(WRITING);
    }
  });
});
