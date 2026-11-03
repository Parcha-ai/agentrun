import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Playground, type StartResult } from "./Playground";
import { RunBar } from "./RunBar";
import { agentFixture } from "@/fixtures";
import type { Client } from "@/lib/client";
import type { Upload, UploadedFile } from "@/lib/uploads";

// Both start screens take files: a run started with files picked names them (`file_ids`), and none starts while one is
// still being sent. The playground's request shows them, and the next request starts with none picked.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const made: UploadedFile = { file_id: "019a0000-0000-7000-8000-000000000001", path: "invoice.pdf", size_bytes: 4, content_type: "application/pdf", sha256: "a".repeat(64), status: "ready" };
function uploads() {
  const pending: ((f: UploadedFile) => void)[] = [];
  const upload: Upload = () => new Promise((resolve) => { pending.push(resolve); });
  return { pending, upload };
}
function mount(el: ReturnType<typeof createElement>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(el));
  const type = (el: HTMLTextAreaElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const pick = (...files: File[]) => act(() => {
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""))!;
  return { host, type, pick, button };
}
const pdf = () => new File(["%PDF"], "invoice.pdf", { type: "application/pdf" });

describe("RunBar, files", () => {
  it("names the picked files in the run it starts, and waits to start until each is sent", async () => {
    const { pending, upload } = uploads();
    const started: Record<string, unknown>[] = [];
    const v2 = { startRun: async (_id: string, body: Record<string, unknown>) => { started.push(body); return { run: { run_id: "run_1" }, status: 202 }; }, deleteUpload: async () => "" } as unknown as Client;
    const opened: string[] = [];
    const page = mount(createElement(RunBar, { agent: agentFixture("invoice-checker"), efforts: [], v2, go: (h: string) => opened.push(h), upload, limits: { max_files_per_run: 20, max_upload_bytes: 50 * 2 ** 20 } }));
    page.type(page.host.querySelector("textarea")!, "Check this invoice.");
    page.pick(pdf());
    expect(page.button(/Run/).disabled).toBe(true);
    await act(async () => { pending[0]!(made); await Promise.resolve(); });
    expect(page.button(/Run/).disabled).toBe(false);
    await act(async () => { page.button(/Run/).click(); await Promise.resolve(); });
    expect(started).toEqual([{ input: { content: "Check this invoice." }, file_ids: [made.file_id] }]);
    expect(opened).toEqual(["#/runs/run_1"]);
  });
});

describe("Playground, files", () => {
  it("shows the picked files in the request, sends them, and starts the next request with none", async () => {
    const { pending, upload } = uploads();
    const sent: Record<string, unknown>[] = [];
    const onSend = async (_id: string, body: Record<string, unknown>): Promise<StartResult> => { sent.push(body); return { status: 202, ms: 1, body: { run_id: "run_1" }, runId: "run_1" }; };
    const page = mount(createElement(Playground, { agents: [agentFixture("invoice-checker")], efforts: [], origin: "http://serve.test", agentId: "invoice-checker", onSend, upload, removeUpload: async () => "" }));
    page.type(page.host.querySelector("textarea")!, "Check this invoice.");
    page.pick(pdf());
    expect(page.button(/Send request/).disabled).toBe(true);
    await act(async () => { pending[0]!(made); await Promise.resolve(); });
    expect(page.host.querySelector("pre")!.textContent).toContain(`"file_ids":["${made.file_id}"]`);
    await act(async () => { page.button(/Send request/).click(); await Promise.resolve(); await Promise.resolve(); });
    expect(sent).toEqual([{ input: { content: "Check this invoice." }, file_ids: [made.file_id] }]);
    expect(page.host.querySelector('[aria-label="Attached files"]')).toBeNull();
  });
});
