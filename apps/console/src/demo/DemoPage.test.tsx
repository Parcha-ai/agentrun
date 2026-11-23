import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Client } from "@/lib/client";
import { DemoBar, DemoPage, TOUR } from "./DemoPage";
import { AGENTS, heroes } from "./tale";

// Settings → Demo: the switch, the tour while it is on, and the strip that says the console shows sample data.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

function mount(el: ReactElement) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}
const client = (startRun: unknown = vi.fn()) => ({ startRun }) as unknown as Client;
const named = (host: HTMLElement, tag: string, text: RegExp) => [...host.querySelectorAll<HTMLElement>(tag)].find((x) => text.test(x.textContent ?? ""));

it("off: says the console shows the server, offers the switch, and no tour", () => {
  const onChange = vi.fn();
  const host = mount(createElement(DemoPage, { on: false, onChange, v2: client(), go: () => {} }));
  expect(host.textContent).toContain("Off: the console shows your server");
  expect(host.textContent).not.toContain("Approve a tool call");
  const toggle = host.querySelector<HTMLElement>('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(document.getElementById(toggle.getAttribute("aria-labelledby")!)?.textContent).toBe("Demo mode");
  act(() => toggle.click());
  expect(onChange).toHaveBeenCalledWith(true);
});

it("on: lists the tour, and a live stop starts a run in the demo and opens it", async () => {
  const startRun = vi.fn(async () => ({ run: { run_id: "demo-run-now-1" }, status: 202 }));
  const go = vi.fn();
  const host = mount(createElement(DemoPage, { on: true, onChange: () => {}, v2: client(startRun), go }));
  expect(host.textContent).toContain("On: the console shows sample data");
  expect(named(host, "a", /Approve a tool call/)?.getAttribute("href")).toBe("#/runs/demo-run-refund-approval");
  await act(async () => { named(host, "button", /Watch a run live/)!.click(); await Promise.resolve(); });
  expect((startRun.mock.calls[0] as unknown[]).slice(0, 2)).toEqual(["support-triage", { input: {} }]);
  expect(go).toHaveBeenCalledWith("#/runs/demo-run-now-1");
});

it("a stop whose run does not start says why, and stays on the page", async () => {
  const go = vi.fn();
  const host = mount(createElement(DemoPage, { on: true, onChange: () => {}, v2: client(vi.fn(async () => { throw new Error("no such agent"); })), go }));
  await act(async () => { named(host, "button", /Watch a run live/)!.click(); await Promise.resolve(); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("no such agent");
  expect(go).not.toHaveBeenCalled();
});

it("every stop of the tour names a run or an agent the story has", () => {
  const runs = new Set(heroes().map((r) => r.id));
  const agents = new Set(AGENTS.map((a) => a.id));
  for (const stop of TOUR.flatMap((g) => g.stops)) {
    if ("start" in stop) { expect(agents.has(stop.start), stop.title).toBe(true); continue; }
    const run = stop.href.match(/^#\/runs\/(.+)$/)?.[1];
    const agent = stop.href.match(/^#\/agents\/([^/]+)/)?.[1];
    if (run) expect(runs.has(run), stop.title).toBe(true);
    // "#/agents/new" is the builder, not an agent.
    if (agent && agent !== "new") expect(agents.has(agent), stop.title).toBe(true);
  }
});

it("the bar says what the person is looking at, and turns the demo off", () => {
  const onOff = vi.fn();
  const host = mount(createElement(DemoBar, { onOff }));
  expect(host.querySelector('[role="status"]')?.textContent).toMatch(/Demo mode\..*nothing here is from your server/);
  act(() => named(host, "button", /^Turn off$/)!.click());
  expect(onOff).toHaveBeenCalled();
});
