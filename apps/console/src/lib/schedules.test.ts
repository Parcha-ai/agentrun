import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientError } from "./client";
import { bodyOf, capWords, type Draft, draftOf, type Schedule, emptyDraft, firingWords, instantOf, issuesOf, patchOf, scheduleLine, span, utcWhen, wallOf } from "./schedules";
import type { Firing } from "./v2";

const draft = (over: Partial<Draft>): Draft => ({ ...emptyDraft(), agentId: "triage", content: "Triage last night's issues.", maxCost: "2", ...over });
const trigger = (over: Partial<Schedule> = {}): Schedule => ({
  id: "trg_1", name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 },
  catchup_window_s: 300, max_active_runs: null, failures_in_a_row: 0, disabled: null, last_run_id: null,
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-05T09:30:00Z", last_firing: null, ...over,
});
const firing = (over: Partial<Firing>): Firing => ({ key: "fir_1", by: "schedule", nominal_at: "2026-11-05T09:30:00Z", status: "started", at: "2026-11-05T09:30:01Z", run_id: null, reason: null, error: null, ...over });

// A one-time "at" and an interval's start are typed in the browser's own zone: the tests pin it.
beforeEach(() => { vi.stubEnv("TZ", "UTC"); });
afterEach(() => { vi.unstubAllEnvs(); });

// A schedule's whole line, in the viewer's time with the zone said once: the schedule's own time and zone in parentheses
// when its zone is another, and its next time with its day and zone.
describe("a schedule's line", () => {
  const cron = (line: string, timezone: string): Schedule["source"] => ({ kind: "schedule", cron: line, timezone });
  const NY = { zone: "America/New_York" };

  it("reads a UTC schedule in a New York viewer's time, with its own time in parentheses (the QA case)", () => {
    expect(scheduleLine(cron("0 8 * * 1", "UTC"), "2026-11-16T08:00:00Z", NY)).toBe("At 3:00 AM your time (08:00 UTC), only on Monday · next Mon Nov 16, 3:00 AM EST");
    // The viewer's zone is the browser's when none is given.
    vi.stubEnv("TZ", "America/New_York");
    expect(scheduleLine(cron("0 8 * * 1", "UTC"), "2026-11-16T08:00:00Z")).toBe("At 3:00 AM your time (08:00 UTC), only on Monday · next Mon Nov 16, 3:00 AM EST");
  });

  it("reads a Europe/Madrid schedule in a Los Angeles viewer's time, the day before when its days are named", () => {
    const LA = { zone: "America/Los_Angeles" };
    expect(scheduleLine(cron("0 18 * * *", "Europe/Madrid"), "2026-11-12T17:00:00Z", LA)).toBe("At 9:00 AM your time (18:00 Europe/Madrid) · next Thu Nov 12, 9:00 AM PST");
    expect(scheduleLine(cron("30 7 * * 1-5", "Europe/Madrid"), "2026-11-12T06:30:00Z", LA)).toBe("At 10:30 PM your time the day before (07:30 Europe/Madrid), Monday through Friday · next Wed Nov 11, 10:30 PM PST");
    expect(scheduleLine(cron("0 20 * * 1", "UTC"), "2026-11-16T20:00:00Z", { zone: "Asia/Tokyo" })).toBe("At 5:00 AM your time the next day (20:00 UTC), only on Monday · next Tue Nov 17, 5:00 AM GMT+9");
  });

  it("says no parentheses when the schedule is in the viewer's own zone", () => {
    const MADRID = { zone: "Europe/Madrid" };
    expect(scheduleLine(cron("0 8 * * 1", "Europe/Madrid"), "2026-11-16T07:00:00Z", MADRID)).toBe("At 8:00 AM your time, only on Monday · next Mon Nov 16, 8:00 AM CET");
    expect(scheduleLine(cron("0 9-17 * * 1-5", "Europe/Madrid"), "2026-11-12T08:00:00Z", MADRID)).toBe("Every hour, between 09:00 and 17:00, Monday through Friday · next Thu Nov 12, 9:00 AM CET");
  });

  it("reads the hour a clock change gives on each side of it, with the zone's name then", () => {
    // US: summer time starts Mar 8 and ends Nov 1, 2026.
    expect(scheduleLine(cron("0 8 * * 1", "UTC"), "2026-03-02T08:00:00Z", NY)).toBe("At 3:00 AM your time (08:00 UTC), only on Monday · next Mon Mar 2, 3:00 AM EST");
    expect(scheduleLine(cron("0 8 * * 1", "UTC"), "2026-03-09T08:00:00Z", NY)).toBe("At 4:00 AM your time (08:00 UTC), only on Monday · next Mon Mar 9, 4:00 AM EDT");
    expect(scheduleLine(cron("0 8 * * 1", "UTC"), "2026-10-26T08:00:00Z", NY)).toBe("At 4:00 AM your time (08:00 UTC), only on Monday · next Mon Oct 26, 4:00 AM EDT");
    expect(scheduleLine(cron("0 8 * * 1", "UTC"), "2026-11-02T08:00:00Z", NY)).toBe("At 3:00 AM your time (08:00 UTC), only on Monday · next Mon Nov 2, 3:00 AM EST");
    // Europe: summer time ends Oct 25, 2026, a week before the US's.
    const MADRID = { zone: "Europe/Madrid" };
    expect(scheduleLine(cron("0 8 * * 1", "Europe/Madrid"), "2026-10-19T06:00:00Z", MADRID)).toBe("At 8:00 AM your time, only on Monday · next Mon Oct 19, 8:00 AM CEST");
    expect(scheduleLine(cron("0 8 * * 1", "Europe/Madrid"), "2026-10-26T07:00:00Z", MADRID)).toBe("At 8:00 AM your time, only on Monday · next Mon Oct 26, 8:00 AM CET");
    expect(scheduleLine(cron("0 8 * * 1", "Europe/Madrid"), "2026-10-26T07:00:00Z", NY)).toBe("At 3:00 AM your time (08:00 Europe/Madrid), only on Monday · next Mon Oct 26, 3:00 AM EDT");
    // An hour its own zone's clock change skips: 02:30 does not exist in Los Angeles on Mar 8, 2026, and the server runs
    // it at 3:00 AM PDT (10:00Z). Both clocks read the server's instant, never a rebuilt 09:30Z.
    const LA = { zone: "America/Los_Angeles" };
    expect(scheduleLine(cron("30 2 * * *", "America/Los_Angeles"), "2026-03-08T10:00:00Z", LA)).toBe("At 3:00 AM your time · next Sun Mar 8, 3:00 AM PDT");
    expect(scheduleLine(cron("30 2 * * *", "America/Los_Angeles"), "2026-03-08T10:00:00Z", NY)).toBe("At 6:00 AM your time (02:30 America/Los_Angeles) · next Sun Mar 8, 6:00 AM EDT");
    // An hour it repeats: 01:30 in Los Angeles on Nov 1, 2026 is 08:30Z (PDT) and again 09:30Z (PST); the pass the server
    // gives is the one both clocks say.
    expect(scheduleLine(cron("30 1 * * *", "America/Los_Angeles"), "2026-11-01T08:30:00Z", LA)).toBe("At 1:30 AM your time · next Sun Nov 1, 1:30 AM PDT");
    expect(scheduleLine(cron("30 1 * * *", "America/Los_Angeles"), "2026-11-01T09:30:00Z", LA)).toBe("At 1:30 AM your time · next Sun Nov 1, 1:30 AM PST");
    expect(scheduleLine(cron("30 1 * * *", "America/Los_Angeles"), "2026-11-01T08:30:00Z", NY)).toBe("At 3:30 AM your time (01:30 America/Los_Angeles) · next Sun Nov 1, 3:30 AM EST");
    expect(scheduleLine(cron("30 1 * * *", "America/Los_Angeles"), "2026-11-01T09:30:00Z", NY)).toBe("At 4:30 AM your time (01:30 America/Los_Angeles) · next Sun Nov 1, 4:30 AM EST");
    // With no next time, the time is today's.
    expect(scheduleLine(cron("0 8 * * 1", "UTC"), null, { ...NY, now: Date.parse("2026-07-01T00:00:00Z") })).toBe("At 4:00 AM your time (08:00 UTC), only on Monday · no next time");
    expect(scheduleLine(cron("0 8 * * 1", "UTC"), null, { ...NY, now: Date.parse("2026-12-01T00:00:00Z") })).toBe("At 3:00 AM your time (08:00 UTC), only on Monday · no next time");
  });

  it("keeps the words of a line with more than one time, its zone said once", () => {
    expect(scheduleLine(cron("*/15 * * * *", "UTC"), "2026-11-11T13:15:00Z", NY)).toBe("Every 15 minutes (UTC) · next Wed Nov 11, 8:15 AM EST");
    expect(scheduleLine(cron("0 9,17 * * *", "UTC"), "2026-11-11T17:00:00Z", NY)).toBe("At 09:00 and 17:00 (UTC) · next Wed Nov 11, 12:00 PM EST");
    expect(scheduleLine({ kind: "schedule", every_s: 900, start_at: "2026-11-04T00:00:00Z" }, "2026-11-11T13:15:00Z", NY)).toBe("Every 15 minutes · next Wed Nov 11, 8:15 AM EST");
    // One cronstrue can't read stays as it is.
    expect(scheduleLine(cron("not a cron", "UTC"), null, NY)).toBe("Cron not a cron (UTC) · no next time");
  });

  it("says a one time once, and what stands in for its next time", () => {
    const LA = { zone: "America/Los_Angeles" };
    const once: Schedule["source"] = { kind: "schedule", at: "2026-11-05T09:30:00Z" };
    expect(scheduleLine(once, "2026-11-05T09:30:00Z", LA)).toBe("Once, Thu Nov 5, 1:30 AM PST");
    expect(scheduleLine(once, null, LA)).toBe("Once, Thu Nov 5, 1:30 AM PST · no next time");
    expect(scheduleLine(once, null, { ...LA, instead: "Done · ran Nov 5, 1:30 AM" })).toBe("Once, Thu Nov 5, 1:30 AM PST · Done · ran Nov 5, 1:30 AM");
  });

  it("says an interval in its largest whole unit", () => {
    expect([60, 90, 3600, 7200, 5400, 86400].map(span)).toEqual(["minute", "90 seconds", "hour", "2 hours", "90 minutes", "24 hours"]);
  });
});

describe("a schedule's cost cap, in words", () => {
  it("is dollars and cents, and keeps a cap finer than a cent whole", () => {
    expect([2, 0.5, 12.3, 0.005].map(capWords)).toEqual(["$2.00 a run", "$0.50 a run", "$12.30 a run", "$0.005 a run"]);
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

describe("a time typed in the browser", () => {
  it("is the instant that wall time is in the browser's zone, to the second, and reads back as typed", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(instantOf("2026-11-05T01:30")).toBe("2026-11-05T09:30:00Z");
    expect(instantOf("2026-07-05T01:30")).toBe("2026-07-05T08:30:00Z");
    expect(wallOf("2026-11-05T09:30:00Z")).toBe("2026-11-05T01:30");
    vi.stubEnv("TZ", "UTC");
    expect(instantOf("2026-11-05T09:30")).toBe("2026-11-05T09:30:00Z");
    expect(instantOf("")).toBeNull();
  });
});

describe("a new schedule's zone", () => {
  // As n8n's and Windmill's schedule forms do: the zone a cron line runs in starts as the browser's, and is sent.
  it("starts as the browser's own, and is sent as typed", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(emptyDraft().timezone).toBe("America/Los_Angeles");
    expect(bodyOf({ ...emptyDraft("triage"), cron: "30 1 * * *", content: "Go.", maxCost: "1" }).body?.source).toEqual({ kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" });
  });
});

describe("the instant a one time becomes", () => {
  it("is said in UTC whatever the browser's zone", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(utcWhen("2026-11-05T09:30:00Z")).toBe("Nov 5, 9:30 AM UTC");
  });
});

describe("the form's body", () => {
  it("is a cron source in its zone, the agent, its input and its cap", () => {
    expect(bodyOf(draft({ name: " nightly triage ", kind: "cron", cron: "30 1 * * *", timezone: "America/Los_Angeles" }))).toEqual({
      body: { name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" }, target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 } },
    });
  });
  it("is one time, or every N units from an optional start, as instants in the browser's zone (the zone is a cron line's only)", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(bodyOf(draft({ kind: "at", at: "2026-11-05T01:30", timezone: "Europe/Paris" })).body?.source).toEqual({ kind: "schedule", at: "2026-11-05T09:30:00Z" });
    vi.stubEnv("TZ", "UTC");
    expect(bodyOf(draft({ kind: "every", every: "5", everyUnit: "minutes" })).body?.source).toEqual({ kind: "schedule", every_s: 300 });
    expect(bodyOf(draft({ kind: "every", every: "2", everyUnit: "hours", startAt: "2026-11-05T09:00" })).body?.source).toEqual({ kind: "schedule", every_s: 7200, start_at: "2026-11-05T09:00:00Z" });
  });
  it("names no name when none is typed, so the server's default holds", () => {
    expect(bodyOf(draft({ kind: "cron", cron: "* * * * *" })).body).not.toHaveProperty("name");
  });
  it("says what is missing or not a number, under the field the server would name, and checks nothing else", () => {
    expect(bodyOf(draft({ kind: "cron", cron: "", agentId: "", content: " ", maxCost: "" })).issues).toEqual({
      "source.cron": "Pick when it runs.", "target.agent_id": "Pick an agent.", "target.input": "Say what each run is asked.", "target.max_cost_usd": "A cost cap is needed: every run a schedule starts is capped.",
    });
    expect(bodyOf(draft({ kind: "every", every: "five", maxCost: "two" })).issues).toEqual({ "source.every_s": "A number is needed.", "target.max_cost_usd": "A number is needed." });
    expect(bodyOf(draft({ kind: "at", at: "" })).issues).toEqual({ "source.at": "A time is needed." });
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

describe("an edit's body", () => {
  // The server starts a schedule again from now whenever an edit names its source, and turns it on or off by `enabled`:
  // an edit sends only what changed, and never `enabled` (Pause and Resume do).
  it("names only the parts that changed, and never enabled", () => {
    const t = trigger({ enabled: false });
    expect(patchOf(t, bodyOf(draftOf(t)).body!)).toEqual({});
    expect(patchOf(t, bodyOf({ ...draftOf(t), name: "nightly" }).body!)).toEqual({ name: "nightly" });
    expect(patchOf(t, bodyOf({ ...draftOf(t), maxCost: "3" }).body!)).toEqual({ target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 3 } });
    expect(patchOf(t, bodyOf({ ...draftOf(t), cron: "0 2 * * *" }).body!)).toEqual({ source: { kind: "schedule", cron: "0 2 * * *", timezone: "America/Los_Angeles" } });
    const every = trigger({ source: { kind: "schedule", every_s: 300, start_at: "2026-11-05T09:00:00Z" } });
    expect(patchOf(every, bodyOf(draftOf(every)).body!)).toEqual({});
  });
  // The second 1:30 of a fall-back day in Los Angeles (09:30Z) reads as the wall time 01:30, which as typed is the first
  // 1:30 (08:30Z): an edit that leaves the time alone keeps the instant it read, and moves no firing.
  it("keeps a time in a clock change's repeated hour when it is left alone, and reads a changed one as typed", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const once = trigger({ source: { kind: "schedule", at: "2027-11-07T09:30:00Z" } });
    expect(patchOf(once, bodyOf({ ...draftOf(once), name: "nightly" }).body!)).toEqual({ name: "nightly" });
    const every = trigger({ source: { kind: "schedule", every_s: 300, start_at: "2027-11-07T09:30:00Z" } });
    expect(patchOf(every, bodyOf({ ...draftOf(every), name: "nightly" }).body!)).toEqual({ name: "nightly" });
    expect(bodyOf({ ...draftOf(once), at: "2027-11-07T02:30" }).body?.source).toEqual({ kind: "schedule", at: "2027-11-07T10:30:00Z" });
  });
});

describe("a 422, by field", () => {
  it("puts each issue the server names under its field, and keeps the rest to say above the form", () => {
    const e = new ClientError(422, "input_invalid", "max_cost_usd is required");
    e.fields = [
      { field: "target.max_cost_usd", reason: "missing", message: "max_cost_usd is required: every run a trigger starts is capped" },
      { field: "target.agent_id", reason: "invalid", message: "the agent flow has no current revision" },
      { field: "source.kind", reason: "not_an_option", message: "source.kind is schedule" },
    ];
    expect(issuesOf(e)).toEqual({
      fields: { "target.max_cost_usd": "max_cost_usd is required: every run a trigger starts is capped", "target.agent_id": "the agent flow has no current revision" },
      rest: ["source.kind is schedule"],
    });
  });
  it("is the whole message for any other refusal", () => {
    expect(issuesOf(new ClientError(409, "scope_taken", "another trigger listens there"))).toEqual({ fields: {}, rest: ["scope_taken: another trigger listens there"] });
  });
});
