import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { messageFeatures, runFixture } from "@/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { NO_MESSAGES } from "@/lib/runState";
import type { Run, RunFile, TimelineRow } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => { vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn((_blob: Blob) => "blob:test-file"); static revokeObjectURL = vi.fn(); }); });
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const run: Run = { run_id: "r1", agent_id: "a1", agent_version: 1, revision: "rev1", kind: "agentic", status: "completed", state: "idle", title: "Write a report", created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: null, archived_at: null };
const file: RunFile = { path: "report.txt", content_type: "text/plain", size_bytes: 6, modified_at: run.created_at };

describe("RunDetail's native lifecycle controls", () => {
  it.each([
    { label: "complete", content: "Divided by 7", shown: "Divided by 7", rejects: false },
    { label: "truncated", content: "Explain the calculation and show each step. ".repeat(60), shown: `${"Explain the calculation and show each step. ".repeat(60).slice(0, 1997)}...`, rejects: false },
    { label: "rejected callback", content: "Try this follow-up again", shown: "Try this follow-up again", rejects: true },
  ])("submits duplicate activations once, keeps a failed follow-up draft, then acknowledges acceptance until its new $label message arrives", async ({ content, shown, rejects }) => {
    const old: TimelineRow = { id: "old", seq: 1, kind: "user_message", summary: `You: ${shown}`, text: shown, timestamp: run.created_at, tool_name: null };
    let refuse!: (value: boolean) => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise<boolean>((resolve, fail) => { refuse = resolve; reject = fail; });
    const onMessage = vi.fn<(_text: string) => Promise<boolean>>().mockReturnValueOnce(pending).mockResolvedValueOnce(true);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const render = async (rows: TimelineRow[], enabled = true) => {
      await act(async () => { root!.render(createElement(RunDetail, {
        run: { ...run, result: { final_answer: "The answer is 42." } }, agentName: "Writer", messages: { ...NO_MESSAGES, follow_up: true }, harnessSteers: false,
        rows, files: [], onMessage: enabled ? onMessage : undefined,
      })); });
    };
    const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === name)!;
    const draft = () => host.querySelector<HTMLTextAreaElement>("#composer")!;
    const send = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const type = async () => { await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft(), content);
      draft().dispatchEvent(new Event("input", { bubbles: true }));
    }); };
    await render([old], false);
    await type();
    expect(send().disabled).toBe(true);
    await render([old]);
    await act(async () => { send().click(); send().click(); });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(send().disabled).toBe(true);
    await act(async () => { if (rejects) reject(new Error("Connection interrupted")); else refuse(false); });
    expect(tab("Report").getAttribute("aria-selected")).toBe("true");
    expect(draft().value).toBe(content);
    expect(host.textContent).not.toContain("Sent.");
    expect(send().disabled).toBe(false);
    if (rejects) expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection interrupted");
    await act(async () => { send().click(); send().click(); });
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(tab("Timeline").getAttribute("aria-selected")).toBe("true");
    expect(draft().value).toBe("");
    expect(host.textContent).toContain("Sent.");
    expect(host.querySelectorAll("ol > li")).toHaveLength(1);
    const unrelated = { ...old, id: "other", seq: 2, summary: "You: Another request", text: "Another request" };
    await render([old, unrelated]);
    expect(host.textContent).toContain("Sent.");
    const arrived = { ...old, id: "new", seq: 3 };
    await render([old, unrelated, arrived]);
    expect(host.textContent).not.toContain("Sent.");
    expect([...host.querySelectorAll("ol > li")].filter((row) => row.textContent?.includes(shown))).toHaveLength(2);
    await act(async () => { tab("Report").click(); });
    await type();
    let accept!: (value: boolean) => void;
    onMessage.mockImplementationOnce(() => new Promise<boolean>((resolve) => { accept = resolve; }));
    await act(async () => { send().click(); });
    await render([old, unrelated, arrived, { ...old, id: "fast", seq: 4 }]);
    await act(async () => { accept(true); });
    expect(tab("Timeline").getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).not.toContain("Sent.");
  });

  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("keeps Enter in the input method while composing ($isComposing/$keyCode)", async (composition) => {
    const onMessage = vi.fn().mockResolvedValue(true);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(RunDetail, { run, agentName: "Writer", messages: { ...NO_MESSAGES, follow_up: true }, harnessSteers: false, rows: [], files: [], onMessage })); });
    const draft = host.querySelector<HTMLTextAreaElement>("#composer")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "東京について");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...composition })); });
    expect(onMessage).not.toHaveBeenCalled();
    expect(draft.value).toBe("東京について");
    await act(async () => { draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith("東京について");
    expect(draft.value).toBe("");
  });

  it.each([
    { name: "completed native run", record: run, message: true, stop: false, cancel: false, archive: "Archive" },
    { name: "completed archived run", record: { ...run, archived_at: run.ended_at }, message: false, stop: false, cancel: false, archive: "Unarchive" },
    { name: "completed imported history", record: { ...run, imported_from: { source: "codex" as const, session: "source-session" } }, message: false, stop: false, cancel: false, archive: "Archive" },
    { name: "imported history with an active snapshot", record: { ...run, status: "working" as const, state: "working" as const, ended_at: null, imported_from: { source: "codex" as const, session: "source-session" } }, message: false, stop: false, cancel: false, archive: "Archive" },
    { name: "archived working run", record: { ...run, status: "working" as const, state: "working" as const, ended_at: null, archived_at: run.created_at }, message: true, stop: true, cancel: true, archive: "Unarchive" },
    { name: "archived run waiting for input", record: { ...run, status: "input_required" as const, state: "waiting" as const, ended_at: null, archived_at: run.created_at }, message: true, stop: false, cancel: true, archive: "Unarchive" },
  ])("offers only supported native actions for $name", async ({ record, message, stop, cancel, archive }) => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(RunDetail, {
      run: record, agentName: "Writer", messages: { steer: true, answer: true, follow_up: true, steer_workflow_runs: false }, harnessSteers: true,
      rows: [], files: [], onMessage: vi.fn(), actions: { onStop: vi.fn(), onCancel: vi.fn(), onArchive: vi.fn() },
    })); });
    expect(host.querySelector("textarea#composer") !== null).toBe(message);
    const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(buttons.includes("Stop")).toBe(stop);
    expect(buttons.includes("Cancel run")).toBe(cancel);
    expect(buttons).toContain(archive);
  });
});

it.each([false, 0, ""])("shows a completed workflow's output %j without claiming it gave no answer", async (output) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(RunDetail, { run: { ...run, kind: "workflow", result: { output } }, agentName: "Workflow", messages: NO_MESSAGES, harnessSteers: false, rows: [], files: [] })); });
  expect(host.querySelector("pre")?.textContent).toBe(JSON.stringify(output));
  expect(host.textContent).not.toContain("This run gave no answer.");
});

describe("RunDetail's files", () => {
  it("previews supported images and downloads their original binary bytes", async () => {
    const original = await new Response(new Uint8Array([0x89, 0xff, 0x00]), { headers: { "content-type": "image/png" } }).blob();
    const urls = vi.fn((_blob: Blob) => "blob:test-image");
    vi.stubGlobal("URL", class extends URL { static createObjectURL = urls; static revokeObjectURL = vi.fn(); });
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(RunDetail, { run, agentName: "Writer", messages: NO_MESSAGES, harnessSteers: false, rows: [], files: [{ ...file, path: "plot.png", content_type: "image/png" }], tab: "files", readFileBlob: async () => original })); });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("plot.png"))!.click(); });
    expect(host.querySelector("dialog img")?.getAttribute("src")).toBe("blob:test-image");
    expect(host.querySelector("dialog a[download]")?.getAttribute("href")).toBe("blob:test-image");
    expect(urls.mock.calls[0][0]).toBe(original);
  });

  it.each(["unavailable", "denied"])("retries a failed file read and reports %s clipboard access without losing the file", async (clipboard) => {
    let reads = 0;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => { root!.render(createElement(RunDetail, { run, agentName: "Writer", messages: NO_MESSAGES, harnessSteers: false, rows: [], files: [file], tab: "files", readFile: async () => { if (++reads === 1) throw new Error("Server disconnected"); return "Report"; } })); });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("report.txt"))!.click(); });
    expect(host.querySelector('dialog [role="alert"]')?.textContent).toContain("Server disconnected");
    const retry = [...host.querySelectorAll("dialog button")].find((b) => b.textContent === "Try again") as HTMLButtonElement;
    expect(retry).toBeTruthy();
    await act(async () => { retry.click(); });
    expect(host.querySelector("dialog pre")?.textContent).toBe("Report");
    expect(host.querySelector('dialog [role="alert"]')).toBeNull();
    expect(reads).toBe(2);
    const writeText = vi.fn().mockRejectedValueOnce(new Error("Copy permission denied")).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: clipboard === "denied" ? { writeText } : undefined });
    const copy = () => [...host.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent?.trim() === "Copy")!;
    await act(async () => { copy().click(); });
    expect(host.querySelector('dialog [role="alert"]')).toBeTruthy();
    expect(host.querySelector("dialog pre")?.textContent).toBe("Report");
    expect(host.querySelector("dialog")?.textContent).not.toContain("Copied");
    vi.stubGlobal("navigator", { clipboard: { writeText: writeText.mockReset().mockResolvedValue(undefined) } });
    await act(async () => { copy().click(); });
    expect(host.querySelector('dialog [role="alert"]')).toBeNull();
    expect(host.querySelector("dialog")?.textContent).toContain("Copied");
    expect(writeText).toHaveBeenLastCalledWith("Report");
  });
});

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
  const SAID = "Not sent: the run has spent $0.04 of its $0.05 cap, and its next faux-1 request needs at least $0.11. Raise the cap to at least $0.16 to run it.";
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
    const said = "Not sent: the run has spent $0.04 of its $0.05 cap.";
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
