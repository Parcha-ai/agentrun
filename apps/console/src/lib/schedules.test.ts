import { describe, expect, it } from "vitest";
import { ClientError } from "./client";
import { bodyOf, type Draft, draftOf, emptyDraft, firingWords, instantIn, issuesOf, localIn, span, whenWords } from "./schedules";
import type { Firing, Trigger } from "./v2";

const draft = (over: Partial<Draft>): Draft => ({ ...emptyDraft(), agentId: "triage", content: "Triage last night's issues.", maxCost: "2", ...over });
const trigger = (over: Partial<Trigger> = {}): Trigger => ({
  id: "trg_1", name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 },
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-05T09:30:00Z", overlap: "skip", last_firing: null, ...over,
});
const firing = (over: Partial<Firing>): Firing => ({ key: "fir_1", by: "schedule", nominal_at: "2026-11-05T09:30:00Z", status: "started", at: "2026-11-05T09:30:01Z", run_id: null, reason: null, error: null, ...over });

describe("a schedule's when, in words", () => {
  it("names a cron line and its zone, one time in UTC, and an interval in the largest whole unit", () => {
    expect(whenWords({ kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" })).toBe("Cron 30 1 * * * · America/Los_Angeles");
    expect(whenWords({ kind: "schedule", at: "2026-11-05T09:30:00Z" })).toBe("Once, Nov 5, 9:30 AM UTC");
    expect(whenWords({ kind: "schedule", every_s: 300, start_at: "2026-11-04T00:00:00Z" })).toBe("Every 5 minutes");
    expect([60, 90, 3600, 7200, 5400, 86400].map(span)).toEqual(["minute", "90 seconds", "hour", "2 hours", "90 minutes", "24 hours"]);
  });
});

describe("a firing, in words", () => {
  it("says what came of it: its run, why it was skipped, how many times were missed, why it failed, when a due one tries again", () => {
    expect(firingWords(firing({ status: "started", run_id: "r1" }))).toBe("Started");
    expect(firingWords(firing({ status: "skipped", reason: "The last run is still working." }))).toBe("Skipped: The last run is still working.");
    expect(firingWords(firing({ status: "missed", count: 3, reason: "The server was down or its timer late." }))).toBe("Missed 3 times: The server was down or its timer late.");
    expect(firingWords(firing({ status: "missed", count: 1, reason: null }))).toBe("Missed 1 time");
    expect(firingWords(firing({ status: "failed", error: { code: "agent_not_runnable", message: "No model." } }))).toBe("Failed: No model.");
    expect(firingWords(firing({ status: "due", attempts: 2, retry_at: "2026-11-05T09:31:00Z" }))).toBe("Due: the server was full, tries again at 09:31 AM");
    expect(firingWords(firing({ status: "due" }))).toBe("Due");
  });
});

describe("a time typed in a zone", () => {
  it("is the instant that wall time is in that zone, to the second, and reads back as typed", () => {
    expect(instantIn("2026-11-05T01:30", "America/Los_Angeles")).toBe("2026-11-05T09:30:00Z");
    expect(instantIn("2026-07-05T01:30", "America/Los_Angeles")).toBe("2026-07-05T08:30:00Z");
    expect(instantIn("2026-11-05T09:30", "UTC")).toBe("2026-11-05T09:30:00Z");
    expect(localIn("2026-11-05T09:30:00Z", "America/Los_Angeles")).toBe("2026-11-05T01:30");
    expect(instantIn("2026-11-05T09:30", "Not/AZone")).toBeNull();
    expect(instantIn("", "UTC")).toBeNull();
  });
});

describe("the form's body", () => {
  it("is a cron source in its zone, the agent, its input and its cap", () => {
    expect(bodyOf(draft({ name: " nightly triage ", kind: "cron", cron: "30 1 * * *", timezone: "America/Los_Angeles" }))).toEqual({
      body: { name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" }, target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 } },
    });
  });
  it("is one time, or every N units from an optional start, as instants in the zone chosen", () => {
    expect(bodyOf(draft({ kind: "at", at: "2026-11-05T01:30", timezone: "America/Los_Angeles" })).body?.source).toEqual({ kind: "schedule", at: "2026-11-05T09:30:00Z" });
    expect(bodyOf(draft({ kind: "every", every: "5", everyUnit: "minutes" })).body?.source).toEqual({ kind: "schedule", every_s: 300 });
    expect(bodyOf(draft({ kind: "every", every: "2", everyUnit: "hours", startAt: "2026-11-05T09:00" })).body?.source).toEqual({ kind: "schedule", every_s: 7200, start_at: "2026-11-05T09:00:00Z" });
  });
  it("names no name when none is typed, so the server's default holds", () => {
    expect(bodyOf(draft({ kind: "cron", cron: "* * * * *" })).body).not.toHaveProperty("name");
  });
  it("says what is missing or not a number, under the field the server would name, and checks nothing else", () => {
    expect(bodyOf(draft({ kind: "cron", cron: "", agentId: "", content: " ", maxCost: "" })).issues).toEqual({
      "source.cron": "A cron line is needed.", "target.agent_id": "Pick an agent.", "target.input": "Say what each run is asked.", "target.max_cost_usd": "A cost cap is needed: every run a schedule starts is capped.",
    });
    expect(bodyOf(draft({ kind: "every", every: "five", maxCost: "two" })).issues).toEqual({ "source.every_s": "A number is needed.", "target.max_cost_usd": "A number is needed." });
    expect(bodyOf(draft({ kind: "at", at: "" })).issues).toEqual({ "source.at": "A time is needed." });
    expect(bodyOf(draft({ kind: "at", at: "2026-11-05T01:30", timezone: "Not/AZone" })).issues).toEqual({ "source.timezone": "This browser knows no time zone by that name." });
    // The server's own checks stay the server's: a short interval, a bad cron line, a cap of 0.
    expect(bodyOf(draft({ kind: "every", every: "1", everyUnit: "seconds", maxCost: "0" })).issues).toBeUndefined();
    expect(bodyOf(draft({ kind: "cron", cron: "every day" })).issues).toBeUndefined();
  });
});

describe("a schedule in the form, to edit", () => {
  it("reads back each kind of source, its times in its zone, and its interval in the largest whole unit", () => {
    expect(draftOf(trigger())).toMatchObject({ name: "nightly triage", kind: "cron", cron: "30 1 * * *", timezone: "America/Los_Angeles", agentId: "triage", content: "Triage last night's issues.", maxCost: "2", enabled: true });
    expect(draftOf(trigger({ source: { kind: "schedule", at: "2026-11-05T09:30:00Z" } }))).toMatchObject({ kind: "at", at: "2026-11-05T09:30", timezone: "UTC" });
    expect(draftOf(trigger({ source: { kind: "schedule", every_s: 7200, start_at: "2026-11-05T09:00:00Z" } }))).toMatchObject({ kind: "every", every: "2", everyUnit: "hours", startAt: "2026-11-05T09:00" });
    expect(draftOf(trigger({ source: { kind: "schedule", every_s: 90, start_at: "2026-11-05T09:00:00Z" } }))).toMatchObject({ every: "90", everyUnit: "seconds" });
  });
});

describe("a 422, by field", () => {
  it("puts each issue the server names under its field, and keeps the rest to say above the form", () => {
    const e = new ClientError(422, "input_invalid", "max_cost_usd is required");
    e.fields = [
      { field: "target.max_cost_usd", reason: "missing", message: "max_cost_usd is required: every run a trigger starts is capped" },
      { field: "target.agent_id", reason: "not_allowed", message: "A trigger's runs are capped, and a workflow run's spend is not capped here: name an agent that is not a workflow." },
      { field: "source.kind", reason: "not_an_option", message: "source.kind is schedule" },
    ];
    expect(issuesOf(e)).toEqual({
      fields: { "target.max_cost_usd": "max_cost_usd is required: every run a trigger starts is capped", "target.agent_id": "A trigger's runs are capped, and a workflow run's spend is not capped here: name an agent that is not a workflow." },
      rest: ["source.kind is schedule"],
    });
  });
  it("is the whole message for any other refusal", () => {
    expect(issuesOf(new ClientError(409, "store_unreadable", "triggers.json does not read"))).toEqual({ fields: {}, rest: ["store_unreadable: triggers.json does not read"] });
  });
});
