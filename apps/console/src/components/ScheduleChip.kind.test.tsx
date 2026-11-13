import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import { ScheduleNames } from "./ScheduleChip";
import type { Run } from "@/lib/v2";

// A run a trigger started names the trigger by its kind, as the triggers list gives it (source.kind): a webhook's run
// never reads "Schedule".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const run = (trigger: string): Run => ({
  run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b", place: { mode: "runner" }, agent_id: "triage", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle",
  title: "Qualify the lead.", created_at: "2026-11-05T09:30:01Z", ended_at: "2026-11-05T09:31:00Z", result: null, error: null, cost: null, archived_at: null,
  trigger: { id: trigger, firing_key: "fir_1" },
} as unknown as Run);
const KNOWN = new Map([
  ["trg_s", { name: "nightly triage", kind: "schedule" as const }],
  ["trg_w", { name: "inbound-lead", kind: "webhook" as const }],
]);

function chipOf(trigger: string) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ScheduleNames.Provider, { value: KNOWN }, createElement(RunHeader, { run: run(trigger), agentName: "Triage" }))));
  return host.querySelector<HTMLAnchorElement>('a[href^="#/triggers/"]');
}

describe("a triggered run's chip names its trigger's kind", () => {
  it("a webhook's run: Webhook, never Schedule, linking to the trigger", () => {
    const chip = chipOf("trg_w")!;
    expect(chip.textContent).toBe("Webhook: inbound-lead");
    expect(chip.getAttribute("href")).toBe("#/triggers/trg_w");
  });
  it("a schedule's run: Schedule", () => {
    expect(chipOf("trg_s")!.textContent).toBe("Schedule: nightly triage");
  });
  it("a trigger the list doesn't have: Trigger and its id, not a kind it can't know", () => {
    expect(chipOf("trg_gone")!.textContent).toBe("Trigger: trg_gone");
  });
});
