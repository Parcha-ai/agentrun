import { describe, expect, it } from "vitest";
import { lineOf, shapeAs, shapeOf, timeOf } from "./cronShape";

// The schedule picker's shapes and the cron lines they are. A line of another shape is none (the form keeps it typed).
describe("a cron line's shape", () => {
  it.each([
    ["5 * * * *", { kind: "hourly", minute: 5 }],
    ["30 1 * * *", { kind: "daily", at: { hour: 1, minute: 30 } }],
    ["0 9 * * 1-5", { kind: "weekdays", at: { hour: 9, minute: 0 } }],
    ["0 8 * * 1", { kind: "weekly", day: 1, at: { hour: 8, minute: 0 } }],
    ["0 8 * * 0", { kind: "weekly", day: 0, at: { hour: 8, minute: 0 } }],
    ["15 18 31 * *", { kind: "monthly", date: 31, at: { hour: 18, minute: 15 } }],
  ])("%s reads as its shape and writes back as the same line", (line, shape) => {
    expect(shapeOf(line)).toEqual(shape);
    expect(lineOf(shapeOf(line)!)).toBe(line);
  });

  it.each(["", "* * * * *", "*/5 * * * *", "0 8 * * 1,3", "0 8 * * 2-4", "0 8 * * 7", "0 8 1 1 *", "0 8 1 * 1", "0 24 * * *", "60 1 * * *", "0 8 * *", "0 8 * * MON", "@daily"])("%j is none of them", (line) => {
    expect(shapeOf(line)).toBeNull();
  });

  it("a new shape keeps the time and day it can, else 09:00, Monday, the 1st", () => {
    const daily = shapeOf("30 7 * * *");
    expect(shapeAs("weekly", daily)).toEqual({ kind: "weekly", day: 1, at: { hour: 7, minute: 30 } });
    expect(shapeAs("monthly", daily)).toEqual({ kind: "monthly", date: 1, at: { hour: 7, minute: 30 } });
    expect(shapeAs("hourly", daily)).toEqual({ kind: "hourly", minute: 30 });
    expect(shapeAs("daily", shapeOf("45 * * * *"))).toEqual({ kind: "daily", at: { hour: 9, minute: 45 } });
    expect(shapeAs("weekdays", null)).toEqual({ kind: "weekdays", at: { hour: 9, minute: 0 } });
    expect(shapeAs("weekly", shapeOf("0 8 * * 5"))).toEqual({ kind: "weekly", day: 5, at: { hour: 8, minute: 0 } });
  });

  it("reads a time field's HH:MM, and nothing else", () => {
    expect(timeOf("07:05")).toEqual({ hour: 7, minute: 5 });
    expect(timeOf("23:59:00")).toEqual({ hour: 23, minute: 59 });
    expect(timeOf("")).toBeNull();
    expect(timeOf("25:00")).toBeNull();
  });
});
