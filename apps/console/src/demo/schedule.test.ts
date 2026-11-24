import { describe, expect, it } from "vitest";
import { nextCron, nextFiring } from "./schedule";

const at = (iso: string) => Date.parse(iso);
const next = (cron: string, zone: string, after: string) => { const t = nextCron(cron, zone, at(after)); return t === null ? null : new Date(t).toISOString(); };

describe("a demo schedule's next time", () => {
  it("reads a cron line in its time zone, either day field doing when both are named", () => {
    expect(next("0 2 * * *", "UTC", "2026-11-18T15:00:00Z")).toBe("2026-11-19T02:00:00.000Z");
    expect(next("30 9 * * 1-5", "America/New_York", "2026-11-20T15:00:00Z")).toBe("2026-11-23T14:30:00.000Z");
    expect(next("*/15 * * * *", "UTC", "2026-11-18T15:07:00Z")).toBe("2026-11-18T15:15:00.000Z");
    expect(next("0 0 1 * mon", "UTC", "2026-11-18T15:00:00Z")).toBe("2026-11-23T00:00:00.000Z");
    expect(next("0 0 30 2 *", "UTC", "2026-11-18T15:00:00Z")).toBeNull();
    expect(next("not a cron", "UTC", "2026-11-18T15:00:00Z")).toBeNull();
  });

  it("fires a time the clock skips at the first time after the gap, and a time it repeats once", () => {
    // 02:30 does not happen in Los Angeles on March 8, 2026: it fires at 03:00 PDT, then at 02:30 the next day.
    expect(next("30 2 * * *", "America/Los_Angeles", "2026-03-07T12:00:00Z")).toBe("2026-03-08T10:00:00.000Z");
    expect(next("30 2 * * *", "America/Los_Angeles", "2026-03-08T10:00:00Z")).toBe("2026-03-09T09:30:00.000Z");
    // 01:30 happens twice on November 1, 2026: it fires at the first (PDT), and next on November 2.
    expect(next("30 1 * * *", "America/Los_Angeles", "2026-10-31T12:00:00Z")).toBe("2026-11-01T08:30:00.000Z");
    expect(next("30 1 * * *", "America/Los_Angeles", "2026-11-01T08:30:00Z")).toBe("2026-11-02T09:30:00.000Z");
  });

  it("reads a time once and an interval from its start", () => {
    expect(nextFiring({ kind: "schedule", at: "2026-11-20T10:00:00Z" }, at("2026-11-18T15:00:00Z"), 0)).toBe(at("2026-11-20T10:00:00Z"));
    expect(nextFiring({ kind: "schedule", at: "2026-11-01T10:00:00Z" }, at("2026-11-18T15:00:00Z"), 0)).toBeNull();
    expect(nextFiring({ kind: "schedule", every_s: 3600, start_at: "2026-11-18T09:30:00Z" }, at("2026-11-18T15:00:00Z"), 0)).toBe(at("2026-11-18T15:30:00Z"));
  });
});
