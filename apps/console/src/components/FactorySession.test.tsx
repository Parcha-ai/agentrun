import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactorySession } from "./FactorySession";
import recordedRun from "../fixtures/run.input_required.waiting.1.json";
import recordedTimeline from "../fixtures/run.input_required.waiting.1.timeline.json";
import { messageFeatures } from "@/fixtures";
import type { MessageCaps } from "@/lib/liveRun";
import type { Run, TimelinePage } from "@/lib/v2";

// One session beside Agent Factory's board: the run's own live view, with the panel's way out and the run's own page a
// press away. What a person does in it reaches the server through the run page's own calls, and the board hears of it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

// A recorded run that waits on its question (an invoice checker asking which currency), under an id that needs encoding.
const asking = (): Run => ({ ...(recordedRun.body as unknown as Run), run_id: "r/1" });
const page = (run: Run): TimelinePage => ({ ...(recordedTimeline.body as unknown as TimelinePage), run_id: run.run_id, final: true, has_more: false });
const CAPS: MessageCaps = { features: { messages: messageFeatures }, harnesses: [{ id: "pi", available: true, steer: true }] };
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

async function open(over: { run?: Run; sendMessage?: (id: string, text: string, key: string) => Promise<unknown> } = {}) {
  const run = over.run ?? asking();
  const sendMessage = vi.fn(over.sendMessage ?? (async () => ({})));
  const v2 = {
    getRun: vi.fn(async () => run), listFiles: async () => ({ run_id: run.run_id, files: [], complete: true, truncated: false }),
    getTimeline: async () => page(run), listRevisions: async () => ({ revisions: [], next_cursor: null }),
    harnesses: async () => ({ harnesses: [{ id: "pi", available: true, steer: true }] }), sendMessage,
  };
  const onClose = vi.fn(), onChanged = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(FactorySession, { v2: v2 as never, runId: run.run_id, caps: CAPS, agentName: () => "Issue triage", label: "Issue triage · run r/1", onClose, onChanged })));
  await settle();
  const panel = host.querySelector<HTMLElement>('aside[aria-label="Session"]')!;
  return { host, panel, v2, sendMessage, onClose, onChanged };
}
const key = (el: Element, name: string) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });

describe("Agent Factory's session panel", () => {
  it("shows the run's own live view with no way back of its own: the panel names the session, closes, and leads to the run's page", async () => {
    const { panel, v2, onClose } = await open();
    expect(v2.getRun).toHaveBeenCalledWith("r/1");
    expect(panel.getAttribute("data-factory-session")).toBe("r/1");
    expect(panel.textContent).toContain("Issue triage · run r/1");
    // The run as its own page shows it: its title, and what it asks.
    expect(panel.querySelector("h2")?.textContent).toBe(asking().title);
    expect(panel.textContent).toContain("Which currency are these amounts in: USD or EUR?");
    // The board's page has the one h1 and the one way back: the embedded run brings neither.
    expect(panel.querySelector("h1")).toBeNull();
    expect(panel.querySelector('button[aria-label="Back"]')).toBeNull();
    expect(panel.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull();
    expect(panel.querySelector('a[href="#/runs/r%2F1"]')?.textContent).toBe("Open run");
    // The keyboard is on Close as the panel opens.
    const close = panel.querySelector<HTMLButtonElement>('button[aria-label="Close session"]')!;
    expect(document.activeElement).toBe(close);
    act(() => close.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape, except from a field a person is typing in", async () => {
    const { panel, onClose } = await open();
    const field = panel.querySelector("textarea")!;
    key(field, "Escape");
    expect(onClose).not.toHaveBeenCalled();
    key(panel.querySelector('button[aria-label="Close session"]')!, "Enter");
    expect(onClose).not.toHaveBeenCalled();
    key(panel.querySelector("h2")!, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("answers the run's question from the panel, and tells the board once the answer is read back", async () => {
    const { panel, sendMessage, onChanged, v2 } = await open();
    const field = panel.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(field.getAttribute("placeholder")).toBe("Answer the question...");
    const reads = v2.getRun.mock.calls.length;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "USD");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { panel.querySelector<HTMLFormElement>("form")!.requestSubmit(); });
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]!.slice(0, 2)).toEqual(["r/1", "USD"]);
    // The run is read again before the board is told: what the board then reads is what the answer made true.
    expect(v2.getRun.mock.calls.length).toBeGreaterThan(reads);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
