import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { RunHeader } from "./RunHeader";
import { RunsList } from "./RunsList";
import { StatusBadge } from "./StatusBadge";
import { failedWith, recorded, runFixture } from "@/fixtures";
import { verdictOf, type RunGraph } from "@/lib/runGraph";
import type { Run } from "@/lib/v2";
import { NO_MESSAGES } from "@/lib/runState";

describe("StatusBadge", () => {
  it("reads a paused workflow run as Paused", () => {
    expect(renderToStaticMarkup(createElement(StatusBadge, { run: { status: "paused", state: "idle", kind: "workflow" } }))).toContain("Paused");
  });
  it("reads a recorded escalated run as Escalated, in the runs list and the run's header, never Failed", () => {
    const { run } = failedWith("escalated");
    expect(run.status).toBe("failed");
    const badge = renderToStaticMarkup(createElement(StatusBadge, { run }));
    expect(badge).toContain("Escalated");
    expect(badge).not.toContain("Failed");
    for (const html of [renderToStaticMarkup(createElement(RunsList, { runs: [run], agentName: (id: string) => id, onOpen: () => {} })), renderToStaticMarkup(createElement(RunHeader, { run, agentName: "Agent" }))]) {
      expect(html).toContain("Escalated");
      expect(html).not.toContain(">Failed<");
    }
    const detail = renderToStaticMarkup(createElement(RunDetail, { run, agentName: "Agent", messages: NO_MESSAGES, harnessSteers: true, rows: [], files: [] }));
    expect(detail).toContain("The run escalated");
    expect(detail).not.toContain("The run failed");
  });
});

// A workflow run that escalated completes with a `review`: a person takes it from here, so it never reads as done.
describe("a recorded run that escalated for review (status completed, with review)", () => {
  const run = recorded<Run>("run.escalated").body;
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
  it("is the recorded shape: completed, no answer, and a review with its kind, node and reason", () => {
    expect([run.status, run.result?.final_answer ?? null, run.review?.kind, run.review?.node]).toEqual(["completed", null, "needs_evidence", "request-better-evidence"]);
  });
  it("its badge reads Needs review in warning, never a green Completed", () => {
    const badge = html(createElement(StatusBadge, { run }));
    expect(badge).toContain("Needs review");
    expect(badge).not.toContain("Completed");
    expect(badge).toContain("text-warning-text");
    expect(badge).not.toContain("text-success-text");
  });
  it("the run header and the runs list say Needs review, with its reason", () => {
    for (const out of [html(createElement(RunHeader, { run, agentName: "QA decision jev" })), html(createElement(RunsList, { runs: [run], agentName: (id: string) => id, onOpen: () => {} }))]) {
      expect(out).toContain("Needs review");
      expect(out).toContain(run.review!.reason);
      expect(out).not.toContain(">Completed<");
    }
  });
  it("Report says the reason and the node it stopped at, never that the run gave no answer", () => {
    const detail = html(createElement(RunDetail, { run, agentName: "QA decision jev", messages: NO_MESSAGES, harnessSteers: true, rows: [], files: [], tab: "report" }));
    expect(detail).toContain("Needs review");
    expect(detail).toContain(run.review!.reason);
    expect(detail).toContain("Stopped at request-better-evidence");
    expect(detail).not.toContain("The agent finished without writing an answer.");
  });
  it("a completed run with no review reads as it always did", () => {
    const done = runFixture("run.completed.idle.1").run;
    expect(done.review ?? null).toBeNull();
    const badge = html(createElement(StatusBadge, { run: done }));
    expect(badge).toContain("Completed");
    expect(badge).not.toContain("Needs review");
  });
  it("the graph's judge reads the verdict and its probability as the timeline does: no 0.99, never no 0.01", () => {
    const graph = recorded<RunGraph>("run.escalated.graph").body;
    const judge = graph.decisions[0];
    expect(judge.answers?.supported).toEqual({ type: "noul", noul: 0.01 });
    // The timeline's row for the same decision reads "check-evidence (jev): supported no 0.99".
    expect(verdictOf(judge)).toBe("no 0.99");
    expect(verdictOf({ ...judge, answers: { supported: { type: "noul", noul: 0.92 } } })).toBe("yes 0.92");
  });
});

