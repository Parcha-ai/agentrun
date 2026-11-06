import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientError } from "./client";
import { bodyOf, capWords, type Draft, draftOf, emptyDraft, firingWords, instantOf, issuesOf, patchOf, span, utcWhen, wallOf, whenWords } from "./schedules";
import type { Firing, Trigger } from "./v2";

const draft = (over: Partial<Draft>): Draft => ({ ...emptyDraft(), agentId: "triage", content: "Triage last night's issues.", maxCost: "2", ...over });
const trigger = (over: Partial<Trigger> = {}): Trigger => ({
  id: "trg_1", name: "nightly triage", enabled: true, source: { kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Triage last night's issues." }, max_cost_usd: 2 },
  created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z", next_at: "2026-11-05T09:30:00Z", overlap: "skip", last_firing: null, ...over,
});
const firing = (over: Partial<Firing>): Firing => ({ key: "fir_1", by: "schedule", nominal_at: "2026-11-05T09:30:00Z", status: "started", at: "2026-11-05T09:30:01Z", run_id: null, reason: null, error: null, ...over });

// A one-time "at" and an interval's start are typed in the browser's own zone: the tests pin it.
beforeEach(() => { vi.stubEnv("TZ", "UTC"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("a schedule's when, in words", () => {
  it("names a cron line and its zone, one time in the viewer's own zone as every console time, and an interval in the largest whole unit", () => {
    expect(whenWords({ kind: "schedule", cron: "30 1 * * *", timezone: "America/Los_Angeles" })).toBe("Cron 30 1 * * * · America/Los_Angeles");
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(whenWords({ kind: "schedule", at: "2026-11-05T09:30:00Z" })).toBe("Once, Nov 5, 1:30 AM");
    vi.stubEnv("TZ", "UTC");
    expect(whenWords({ kind: "schedule", every_s: 300, start_at: "2026-11-04T00:00:00Z" })).toBe("Every 5 minutes");
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
      "source.cron": "A cron line is needed.", "target.agent_id": "Pick an agent.", "target.input": "Say what each run is asked.", "target.max_cost_usd": "A cost cap is needed: every run a schedule starts is capped.",
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
    expect(issuesOf(new ClientError(409, "store_unreadable", "triggers.json does not read"))).toEqual({ fields: {}, rest: ["store_unreadable: triggers.json does not read"] });
  });
});
