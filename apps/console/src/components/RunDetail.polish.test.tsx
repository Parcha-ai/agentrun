import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import type { Run, RunFile, TimelineRow } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const open = (run: Run, { rows = [] as TimelineRow[], files = [] as RunFile[], tab = "report" as const } = {}) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(<RunDetail run={run} agentName="invoice-checker" messages={messageFeatures} harnessSteers rows={rows} files={files} actions={{}} onMessage={() => {}} tab={tab} />));
  return host;
};
const tabNamed = (host: HTMLElement, word: RegExp) => [...host.querySelectorAll('[role="tab"]')].find((t) => word.test(t.textContent ?? ""));

// A completed agentic run (the recorded completed runs are workflows, whose answer is their output).
const done = { ...runFixture("run.completed.idle.1").run, kind: "agentic", result: { final_answer: "Done." } } as Run;
const NO_ANSWER = "The agent finished without writing an answer.";

// A run that completed with an empty answer says so on its Report tab, and how to get one when it takes messages.
describe("RunDetail, a completed run with an empty answer", () => {
  it("says the agent wrote no answer, and that a follow-up can ask for one", () => {
    const host = open({ ...done, result: { final_answer: "" } } as Run);
    expect(host.textContent).toContain(NO_ANSWER);
    expect(host.textContent).toContain("Send a follow-up below to ask for one.");
  });

  it("an answer of only spaces is empty too: no blank report", () => {
    const host = open({ ...done, result: { final_answer: "  \n " } } as Run);
    expect(host.querySelector("article.report")).toBeNull();
    expect(host.textContent).toContain(NO_ANSWER);
  });
});

// The Files tab's count is what it lists: files in dot and cache folders wait behind "Show hidden".
describe("RunDetail, the Files tab's count", () => {
  const file = (path: string): RunFile => ({ path, size_bytes: 10, content_type: "text/plain", modified_at: "2026-11-03T21:00:00Z" } as RunFile);
  it("counts only the files it lists", () => {
    const host = open(done, { files: [file("stats.py"), file("__pycache__/stats.pyc"), file(".git/HEAD"), file(".env.example")] });
    expect(tabNamed(host, /^Files/)?.textContent).toBe("Files 2");
  });

  it("with the hidden ones shown, counts them too", () => {
    const host = open(done, { files: [file("stats.py"), file("__pycache__/stats.pyc"), file(".git/HEAD"), file(".env.example")], tab: "files" as never });
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Show 2 hidden")!.click());
    expect(tabNamed(host, /^Files/)?.textContent).toBe("Files 4");
    expect(host.querySelectorAll("li")).toHaveLength(4);
  });
});

// A run that waits on the person in its browser or on its computer says where, and what the server asks: never that a
// reply below answers it.
describe("RunDetail, a run that waits on you in its browser or on its computer", () => {
  const waitingRun = runFixture("run.input_required.waiting.1").run;
  const asked = { instruction: "Sign in to the supplier portal.", completion_condition: "The portal shows the invoices list.", asked_at: "2026-11-05T10:00:00Z", expires_at: "2026-11-05T10:30:00Z" };

  it("in the browser: says so, with the server's instruction", () => {
    const host = open({ ...waitingRun, result: null, pending: { kind: "browser", ...asked } } as Run);
    expect(host.textContent).toContain("Waiting for you in the browser");
    expect(host.textContent).toContain("Sign in to the supplier portal.");
    expect(host.textContent).not.toMatch(/reply below/i);
  });

  it("on its phone: says so, with the server's instruction", () => {
    const host = open({ ...waitingRun, result: null, pending: { kind: "computer", computer: "phone", ...asked } } as Run);
    expect(host.textContent).toContain("Waiting for you on its phone");
    expect(host.textContent).toContain("Sign in to the supplier portal.");
  });
});
