import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import type { Run, RunFile, TimelineRow } from "@/lib/v2";

const page = (run: Run, rows: TimelineRow[], tab: "report" | "timeline" | "files", files: RunFile[] = []) =>
  renderToStaticMarkup(createElement(RunDetail, { run, agentName: "invoice-checker", messages: messageFeatures, harnessSteers: true, rows, files, actions: {}, onMessage: () => {}, tab }))
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// A completed run whose answer is empty (the server says final_answer "" and keeps the run completed) says so on its
// Report tab and in its Answer step, and points to a follow-up; never a blank page.
describe("RunDetail, a completed run with an empty answer", () => {
  const f = runFixture("run.with-files");
  const run: Run = { ...f.run, status: "completed", result: { ...(f.run.result ?? {}), final_answer: "" } } as Run;
  const rows = f.page.rows.map((r) => (r.kind === "final_answer" ? { ...r, summary: "", text: "" } : r));

  it("says it on the Report tab, with the follow-up to send", () => {
    expect(f.page.rows.some((r) => r.kind === "final_answer")).toBe(true);
    const shown = page(run, rows, "report");
    expect(shown).toContain("The agent finished without writing an answer.");
    expect(shown).toContain("Send a follow-up below to ask for one.");
  });

  it("says it in the Answer step of the timeline", () => {
    expect(page(run, rows, "timeline")).toContain("The agent finished without writing an answer.");
  });

  it("says nothing of the kind when the answer is there", () => {
    expect(page(f.run, f.page.rows, "report")).not.toContain("without writing an answer");
  });
});

// The Files tab's count is of what the run wrote: files in dot or cache folders wait behind "Show hidden".
describe("RunDetail, the Files tab's count", () => {
  it("counts the files the tab lists, not the hidden ones", () => {
    const f = runFixture("run.with-files");
    const extra = (path: string): RunFile => ({ ...f.files[0]!, path });
    const files = [...f.files, extra("__pycache__/a.cpython-312.pyc"), extra(".git/HEAD")];
    expect(page(f.run, f.page.rows, "report", files)).toContain(`Files ${f.files.length}`);
  });
});

// "Show N hidden" on the Files tab changes what it lists, and the tab bar's count follows it: the two agree.
describe("RunDetail, Show hidden", () => {
  it("moves the tab's count with the list", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const f = runFixture("run.with-files");
    const extra = (path: string): RunFile => ({ ...f.files[0]!, path });
    const files = [...f.files, extra("__pycache__/a.cpython-312.pyc"), extra(".git/HEAD")];
    const el = document.body.appendChild(document.createElement("div"));
    const root = createRoot(el);
    act(() => root.render(createElement(RunDetail, { run: f.run, agentName: "invoice-checker", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files, actions: {}, onMessage: () => {}, tab: "files" })));
    const tab = () => [...el.querySelectorAll("button, [role=tab]")].find((b) => /^Files \d+$/.test(b.textContent ?? ""))?.textContent;
    const listed = () => el.querySelectorAll("section li").length;
    expect(tab()).toBe(`Files ${f.files.length}`);
    act(() => [...el.querySelectorAll("button")].find((b) => b.textContent === "Show 2 hidden")!.click());
    expect(tab()).toBe(`Files ${f.files.length + 2}`);
    expect(listed()).toBe(f.files.length + 2);
    act(() => root.unmount());
    el.remove();
  });
});
