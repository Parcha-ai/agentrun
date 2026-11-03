import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { NO_MESSAGES } from "@/lib/runState";
import type { Run, RunFile, TimelineRow } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => { vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn((_blob: Blob) => "blob:test-file"); static revokeObjectURL = vi.fn(); }); });
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const run: Run = { run_id: "r1", agent_id: "a1", agent_version: 1, revision: "rev1", kind: "agentic", status: "completed", state: "idle", title: "Write a report", created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: null, archived_at: null };
const file: RunFile = { path: "report.txt", content_type: "text/plain", size_bytes: 6, modified_at: run.created_at };

describe("RunDetail's native lifecycle controls", () => {
  it.each([
    { label: "complete", content: "Divided by 7", shown: "Divided by 7" },
    { label: "truncated", content: "Explain the calculation and show each step. ".repeat(60), shown: `${"Explain the calculation and show each step. ".repeat(60).slice(0, 1997)}...` },
  ])("keeps a failed follow-up draft, then opens its timeline and acknowledges acceptance until its new $label message arrives", async ({ content, shown }) => {
    const old: TimelineRow = { id: "old", seq: 1, kind: "user_message", summary: `You: ${shown}`, text: shown, timestamp: run.created_at, tool_name: null };
    const onMessage = vi.fn<(_text: string) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
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
    await act(async () => { send().click(); });
    expect(tab("Report").getAttribute("aria-selected")).toBe("true");
    expect(draft().value).toBe(content);
    expect(host.textContent).not.toContain("Sent.");
    await act(async () => { send().click(); });
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

  it("surfaces a failed authenticated read and retries without closing the file", async () => {
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
  });
});
