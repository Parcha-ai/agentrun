import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import { RunsList } from "./RunsList";
import { ScheduleNames } from "./ScheduleChip";
import type { Run } from "@/lib/v2";

// A run a schedule started names the schedule, in the runs list and on the run's page, and links to it. A schedule the
// names lack is asked about (the app reads the whole list again): until that read answers, the chip names the id and
// links to it; one the fresh read did not find either (`gone`, deleted since) says so and links nowhere. Read from the DOM.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const run = (over: Partial<Run> = {}): Run => ({
  run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b", agent_id: "triage", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle",
  title: "Triage last night's issues.", created_at: "2026-11-05T09:30:01Z", ended_at: "2026-11-05T09:31:00Z", result: null, error: null, cost: null, archived_at: null, ...over,
} as Run);
const names = new Map([["trg_1", "nightly triage"]]);
let asked: string[] = [];
const show = (el: ReturnType<typeof createElement>, gone: string[] = []) => {
  asked = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ScheduleNames.Provider, { value: { names, gone: new Set(gone), ask: (id: string) => { asked.push(id); } } }, el)));
  return host;
};
const links = (host: HTMLElement) => [...host.querySelectorAll("a[href^='#/schedules/']")].map((a) => a.getAttribute("href"));

describe("a run a schedule started", () => {
  // The runs list's rows carry a run's trigger (serve's RunSummary): the chip there, as on the run's page.
  it("names the schedule in the runs list and links to it", () => {
    const host = show(createElement(RunsList, { runs: [run({ trigger: { id: "trg_1", firing_key: "fir_1" } }), run({ run_id: "r2", trigger: null })], agentName: (id: string) => id, onOpen: () => {} }));
    expect(host.textContent).toContain("Schedule: nightly triage");
    expect(links(host)).toEqual(["#/schedules/trg_1"]);
    expect(host.textContent?.match(/Schedule: /g)).toHaveLength(1);
  });
  it("names it on the run's page", () => {
    const host = show(createElement(RunHeader, { run: run({ trigger: { id: "trg_1", firing_key: "fir_1" } }), agentName: "Triage" }));
    expect(host.textContent).toContain("Schedule: nightly triage");
    expect(links(host)).toEqual(["#/schedules/trg_1"]);
  });
  it("a schedule a fresh read did not find (deleted since): says so, links nowhere, and asks nothing more", () => {
    for (const el of [createElement(RunHeader, { run: run({ trigger: { id: "trg_gone", firing_key: "fir_1" } }), agentName: "Triage" }),
      createElement(RunsList, { runs: [run({ trigger: { id: "trg_gone", firing_key: "fir_1" } })], agentName: (id: string) => id, onOpen: () => {} })]) {
      const host = show(el, ["trg_gone"]);
      expect(host.textContent).toContain("Schedule deleted");
      expect(host.textContent).not.toContain("trg_gone");
      expect(links(host)).toEqual([]);
      expect(asked).toEqual([]);
      act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
    }
  });
  // A schedule made in another tab since the list was read: never taken for a deleted one before a fresh read.
  it("a schedule the names lack: asks for a fresh read, and meanwhile names the id and links to it", () => {
    const host = show(createElement(RunHeader, { run: run({ trigger: { id: "trg_new", firing_key: "fir_1" } }), agentName: "Triage" }));
    expect(asked).toEqual(["trg_new"]);
    expect(host.textContent).toContain("Schedule: trg_new");
    expect(host.textContent).not.toContain("Schedule deleted");
    expect(links(host)).toEqual(["#/schedules/trg_new"]);
  });
  it("says nothing on a run a caller started", () => {
    const host = show(createElement(RunHeader, { run: run(), agentName: "Triage" }));
    expect(host.textContent).toContain("Triage last night's issues.");
    expect(host.textContent).not.toContain("Schedule");
  });
  // On a phone the runs list must not widen past the screen: the run's cell takes the room the table leaves it (max-w-0
  // on an auto-width table), and the chip's label truncates in it. jsdom lays nothing out, so this reads the classes; the
  // phone walk measures the page.
  it("in the runs list, the chip's cell can't widen the table, and its label truncates", () => {
    const host = show(createElement(RunsList, { runs: [run({ trigger: { id: "trg_1", firing_key: "fir_1" } })], agentName: (id: string) => id, onOpen: () => {} }));
    const chip = host.querySelector("a[href^='#/schedules/']")!;
    const cell = chip.closest("td")!;
    expect(cell.classList).toContain("max-w-0");
    expect(chip.classList).toContain("max-w-full");
    expect(chip.querySelector("span.truncate")?.textContent).toBe("Schedule: nightly triage");
  });
});
