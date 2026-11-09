import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import { RunsList } from "./RunsList";
import { ScheduleNames } from "./ScheduleChip";
import type { Run } from "@/lib/v2";

// A run a schedule started names the schedule, in the runs list and on the run's page, and links to it.
const run = (over: Partial<Run> = {}): Run => ({
  run_id: "01a1a88f-5f5c-7ce4-a912-fb765b62e88b", agent_id: "triage", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle",
  title: "Triage last night's issues.", created_at: "2026-11-05T09:30:01Z", ended_at: "2026-11-05T09:31:00Z", result: null, error: null, cost: null, archived_at: null, ...over,
} as Run);
const names = new Map([["trg_1", { name: "nightly triage", kind: "schedule" as const }]]);
const inNames = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ScheduleNames.Provider, { value: names }, el));
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("a run a schedule started", () => {
  // The runs list's rows carry a run's trigger (serve's RunSummary): the chip there, as on the run's page.
  it("names the schedule in the runs list and links to it", () => {
    const html = inNames(createElement(RunsList, { runs: [run({ trigger: { id: "trg_1", firing_key: "fir_1" } }), run({ run_id: "r2", trigger: null })], agentName: (id: string) => id, onOpen: () => {} }));
    expect(text(html)).toContain("Schedule: nightly triage");
    expect(html).toContain('href="#/triggers/trg_1"');
    expect(text(html).match(/Schedule: /g)).toHaveLength(1);
  });
  it("names it on the run's page", () => {
    const html = inNames(createElement(RunHeader, { run: run({ trigger: { id: "trg_1", firing_key: "fir_1" } }), agentName: "Triage" }));
    expect(text(html)).toContain("Schedule: nightly triage");
    expect(html).toContain('href="#/triggers/trg_1"');
  });
  it("names it by its id, as a trigger, when it is not in the list (deleted since, or not read yet)", () => {
    expect(text(inNames(createElement(RunHeader, { run: run({ trigger: { id: "trg_gone", firing_key: "fir_1" } }), agentName: "Triage" })))).toContain("Trigger: trg_gone");
  });
  it("says nothing on a run a caller started, or from an older server", () => {
    expect(text(inNames(createElement(RunHeader, { run: run(), agentName: "Triage" })))).not.toContain("Schedule:");
  });
});
