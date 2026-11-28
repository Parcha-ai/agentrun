// The environment line (environment.ts): today's day in the run's zone, by weekday, day, month and year, with the zone
// named and no hour. A schedule-started run takes its trigger's zone, any other run the server's (TZ), an unknown one UTC.
import assert from "node:assert/strict";
import { test } from "node:test";

const { environmentLine, runZone } = await import("../dist/environment.js");

// 2026-11-16T03:00Z: Sunday evening in Los Angeles, Monday in UTC and in Tokyo.
const NOW = new Date("2026-11-16T03:00:00Z");
const TAIL = " You are running on AgentRun; your workspace is your working directory, and file paths are relative to it.";

const storeWith = (source) => ({ triggers: { get: async (id) => (id === "trg_1" ? { source } : undefined) } });
const fromTrigger = { kind: "trigger", trigger_id: "trg_1" };

test("the server's zone tells the day a person there reads, not the UTC day", async (t) => {
  const was = process.env.TZ;
  t.after(() => void (was === undefined ? delete process.env.TZ : (process.env.TZ = was)));
  process.env.TZ = "America/Los_Angeles";
  const zone = await runZone(storeWith(undefined), undefined);
  assert.equal(zone, "America/Los_Angeles");
  assert.equal(environmentLine(NOW, zone), `Today is Sunday 15 November 2026 (America/Los_Angeles).${TAIL}`);
  assert.equal(environmentLine(NOW), `Today is Sunday 15 November 2026 (America/Los_Angeles).${TAIL}`, "the default zone is the server's");
});

test("a run a schedule trigger started takes that trigger's zone", async (t) => {
  const was = process.env.TZ;
  t.after(() => void (was === undefined ? delete process.env.TZ : (process.env.TZ = was)));
  process.env.TZ = "America/Los_Angeles";
  const zone = await runZone(storeWith({ kind: "schedule", cron: "0 9 * * *", timezone: "Asia/Tokyo" }), fromTrigger);
  assert.equal(zone, "Asia/Tokyo");
  assert.equal(environmentLine(NOW, zone), `Today is Monday 16 November 2026 (Asia/Tokyo).${TAIL}`);
});

test("a trigger with no zone of its own, or one the store no longer has, leaves the server's zone", async (t) => {
  const was = process.env.TZ;
  t.after(() => void (was === undefined ? delete process.env.TZ : (process.env.TZ = was)));
  process.env.TZ = "America/Los_Angeles";
  assert.equal(await runZone(storeWith({ kind: "webhook" }), fromTrigger), "America/Los_Angeles");
  assert.equal(await runZone(storeWith(undefined), { kind: "trigger", trigger_id: "trg_gone" }), "America/Los_Angeles");
});

test("a zone this server does not know is told as UTC, named UTC", async () => {
  assert.equal(environmentLine(NOW, "Mars/Olympus"), `Today is Monday 16 November 2026 (UTC).${TAIL}`);
  assert.equal(await runZone(storeWith({ kind: "schedule", cron: "0 9 * * *", timezone: "Mars/Olympus" }), fromTrigger), "UTC");
});

test("a folder given is named by its absolute name, and the run is told to save what it keeps there, not in its home", () => {
  const line = environmentLine(NOW, "UTC", "/workspace");
  assert.equal(line, "Today is Monday 16 November 2026 (UTC). You are running on AgentRun; your workspace is your working directory, /workspace, and file paths are relative to it. Only files under /workspace are the run's files: save what the run keeps there, not in your home directory.");
  assert.equal(environmentLine(NOW, "UTC"), `Today is Monday 16 November 2026 (UTC).${TAIL}`, "no folder: the line names no path");
});
