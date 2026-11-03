import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { NO_MESSAGES } from "@/lib/runState";
import type { Run, RunFile } from "@/lib/v2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => { vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn((_blob: Blob) => "blob:test-file"); static revokeObjectURL = vi.fn(); }); });
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const run: Run = { run_id: "r1", agent_id: "a1", agent_version: 1, revision: "rev1", kind: "agentic", status: "completed", state: "idle", title: "Write a report", created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: null, error: null, cost: null, archived_at: null };
const file: RunFile = { path: "report.txt", content_type: "text/plain", size_bytes: 6, modified_at: run.created_at };

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
