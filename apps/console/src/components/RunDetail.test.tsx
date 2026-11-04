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
