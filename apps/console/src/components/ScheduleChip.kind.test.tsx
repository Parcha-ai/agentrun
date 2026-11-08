import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import { RunsList } from "./RunsList";
import { ScheduleNames } from "./ScheduleChip";
import type { Run } from "@/lib/v2";

// A run a trigger started is labelled by its trigger's kind, as served: the triggers list's `source.kind` for a trigger
// that exists, else the run's own trigger row (`trigger.source`, on its page). Only a schedule links to its page (the
// Schedules page shows schedules alone); a webhook's chip is not a link. A deleted trigger whose kind is not known
// (the runs list, with no rows) reads "Trigger deleted". Read from the DOM.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const run = (over: Partial<Run> = {}): Run => ({
  run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b", agent_id: "triage", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle",
  title: "Score this lead.", created_at: "2026-11-05T09:30:01Z", ended_at: "2026-11-05T09:31:00Z", result: null, error: null, cost: null, archived_at: null, ...over,
} as Run);
const known = { names: new Map([["trg_s", "nightly triage"], ["trg_w", "inbound-lead-webhook"]]), kinds: new Map([["trg_s", "schedule"], ["trg_w", "webhook"]]) };
const show = (el: ReturnType<typeof createElement>, gone: string[] = []) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ScheduleNames.Provider, { value: { ...known, gone: new Set(gone), ask: () => {} } }, el)));
  return host;
};
const links = (host: HTMLElement) => [...host.querySelectorAll("a[href^='#/schedules/']")].map((a) => a.getAttribute("href"));
const fresh = () => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; };

describe("a run a trigger started, by its trigger's kind", () => {
  it("a webhook's run reads Webhook: <name>, with no link, in the runs list and on its page", () => {
    for (const el of [createElement(RunsList, { runs: [run({ trigger: { id: "trg_w", firing_key: "f" } })], agentName: (id: string) => id, onOpen: () => {} }),
      createElement(RunHeader, { run: run({ trigger: { id: "trg_w", firing_key: "f" } }), agentName: "Triage" })]) {
      const host = show(el);
      expect(host.textContent).toContain("Webhook: inbound-lead-webhook");
      expect(host.textContent).not.toContain("Schedule");
      expect(links(host)).toEqual([]);
      fresh();
    }
  });
  it("a schedule's run still reads Schedule: <name> and links to it", () => {
    const host = show(createElement(RunHeader, { run: run({ trigger: { id: "trg_s", firing_key: "f" } }), agentName: "Triage" }));
    expect(host.textContent).toContain("Schedule: nightly triage");
    expect(links(host)).toEqual(["#/schedules/trg_s"]);
  });
  it("a deleted trigger: by its kind on the run's page (its trigger row's source), else Trigger deleted", () => {
    const page = show(createElement(RunHeader, { run: run({ trigger: { id: "trg_old", firing_key: "f" } }), agentName: "Triage", triggerSource: "webhook" }), ["trg_old"]);
    expect(page.textContent).toContain("Webhook deleted");
    expect(links(page)).toEqual([]);
    fresh();
    const list = show(createElement(RunsList, { runs: [run({ trigger: { id: "trg_old", firing_key: "f" } })], agentName: (id: string) => id, onOpen: () => {} }), ["trg_old"]);
    expect(list.textContent).toContain("Trigger deleted");
    expect(list.textContent).not.toContain("Schedule");
    expect(links(list)).toEqual([]);
  });
});
