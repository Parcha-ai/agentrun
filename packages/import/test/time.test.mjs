// A record's time: what Date.parse gives for it, the usual shape ("YYYY-MM-DDTHH:MM:SS.sssZ") read without it.
// Every value here is made up; each test names the edge it holds timeOf to Date.parse on, NaN (undefined) included.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timeOf } from "../dist/text.js";

const pad = (n, w) => String(n).padStart(w, "0");
const parsed = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
};
const sameAsDateParse = (values) => {
  for (const value of values) assert.equal(timeOf(value), parsed(value), JSON.stringify(value));
};

test("a time as records write it is read as Date.parse reads it: every day, hour, edge and near miss", () => {
  let seed = 11;
  const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) % n;
  const times = [];
  for (let i = 0; i < 20_000; i += 1) {
    const year = [1970, 1999, 2000, 2024, 2025, 2026, 2100, 9999, 50, 99, 100, 0][rnd(12)];
    times.push(`${pad(year, 4)}-${pad(1 + rnd(13), 2)}-${pad(rnd(33), 2)}T${pad(rnd(25), 2)}:${pad(rnd(61), 2)}:${pad(rnd(61), 2)}.${pad(rnd(1000), 3)}Z`);
  }
  times.push(
    "2025-02-29T00:00:00.000Z", "2024-02-29T23:59:59.999Z", "2025-04-31T12:00:00.000Z", "2025-12-31T24:00:00.000Z",
    "2025-01-01T00:00:00.000+01:00", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00.0000Z", "2025-01-01 00:00:00.000Z",
    "2025-1a-01T00:00:00.000Z", "2025-01-01T00:00:00.000z", "-025-01-01T00:00:00.000Z", "", "not a time",
  );
  sameAsDateParse(times);
  assert.equal(timeOf(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(timeOf(Number.NaN), undefined);
  assert.equal(timeOf(undefined), undefined);
});

test("each field of the usual shape, swept through its digits one at a time, is read as Date.parse reads it", () => {
  const at = (year, month, day, hour, minute, second, ms) => `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(ms, 3)}Z`;
  const times = [];
  for (let year = 0; year <= 9999; year += 1) times.push(at(year, 6, 15, 12, 30, 30, 500));
  for (let n = 0; n <= 99; n += 1) {
    times.push(at(2025, n, 15, 12, 30, 30, 500), at(2025, 1, n, 12, 30, 30, 500), at(2025, 2, n, 0, 0, 0, 0));
    times.push(at(2025, 6, 15, n, 30, 30, 500), at(2025, 6, 15, n, 0, 0, 0), at(2025, 6, 15, 12, n, 30, 500), at(2025, 6, 15, 12, 30, n, 500));
  }
  for (let ms = 0; ms <= 999; ms += 1) times.push(at(2026, 11, 24, 23, 59, 59, ms));
  sameAsDateParse(times);
});

test("an offset other than Z (+05:30, -08:00, +00:00, +14:00, -12:00) is read as Date.parse reads it", () => {
  const offsets = ["Z", "+05:30", "-08:00", "+00:00", "+14:00", "-12:00", "+0530", "-0800", "+05", "+24:00", "+05:60", "05:30", "+5:30"];
  const bases = ["2025-01-01T00:00:00.000", "2024-02-29T23:59:59.999", "2025-12-31T23:30:00.000", "2026-11-24T23:20:00", "2026-11-24T23:20", "2026-11-24T12:00:00.1234567", "1969-12-31T23:59:59.999"];
  sameAsDateParse(bases.flatMap((base) => offsets.map((offset) => `${base}${offset}`)));
  // One instant written in each offset is one time.
  const instant = parsed("2025-01-01T00:00:00.000Z");
  assert.equal(timeOf("2025-01-01T05:30:00.000+05:30"), instant);
  assert.equal(timeOf("2024-12-31T16:00:00.000-08:00"), instant);
  assert.equal(timeOf("2025-01-01T14:00:00.000+14:00"), instant);
  assert.equal(timeOf("2024-12-31T12:00:00.000-12:00"), instant);
  assert.equal(timeOf("2025-01-01T00:00:00.000+00:00"), instant);
});

test("0 through 9 fractional-second digits are read as Date.parse reads them (it keeps the first 3 and rounds none)", () => {
  const times = [];
  for (const digit of ["0", "1", "5", "9", "123456789", "999999999", "500500500", "000999999", "0004"]) {
    for (let width = 0; width <= 9; width += 1) {
      const fraction = digit.repeat(9).slice(0, width);
      times.push(`2025-06-15T12:30:59.${fraction}Z`, `2025-12-31T23:59:59.${fraction}Z`, `2025-06-15T12:30:59.${fraction}+05:30`);
    }
  }
  times.push("2025-06-15T12:30:59Z", "2025-06-15T12:30:59.Z", "2025-06-15T12:30:59.1234567890Z", "2025-06-15T12:30:59,123Z", "2025-06-15T12:30:59.12aZ");
  sameAsDateParse(times);
  assert.equal(timeOf("2025-12-31T23:59:59.9999Z"), parsed("2025-12-31T23:59:59.999Z"), "a fourth digit does not round up");
  assert.equal(timeOf("2025-06-15T12:30:59.1235Z"), parsed("2025-06-15T12:30:59.123Z"), "a fourth digit does not round up");
});

test("no seconds, date only, and lowercase t and z are read as Date.parse reads them", () => {
  sameAsDateParse([
    "2026-11-24T23:20Z", "2026-11-24T23:20:00Z", "2026-11-24T23:20+05:30", "2026-11-24T23Z", "2026-11-24T2320Z",
    "2026-11-24", "2026-11", "2026", "2026-11-24Z", "2024-02-29", "2025-02-29", "2025-13-01",
    "2026-11-24t23:20:00.000Z", "2026-11-24T23:20:00.000z", "2026-11-24t23:20:00.000z", "2026-11-24t23:20z", "2026-11-24t23:20:00.000+05:30",
  ]);
});

test("Feb 29 in a leap year (2024) and a non-leap year (2025), and every month's last days, are read as Date.parse reads them", () => {
  const times = [];
  for (const year of [1900, 2000, 2024, 2025, 2100, 2400]) {
    for (let month = 1; month <= 12; month += 1) {
      for (const day of [28, 29, 30, 31]) times.push(`${year}-${pad(month, 2)}-${day}T23:59:59.999Z`, `${year}-${pad(month, 2)}-${day}T00:00:00.000+05:30`);
    }
  }
  sameAsDateParse(times);
  assert.equal(timeOf("2024-02-29T12:00:00.000Z"), Date.UTC(2024, 1, 29, 12));
});

test("month 00 and 13, day 00 and 32, hour 24, minute 60 and second 60 are read as Date.parse reads them", () => {
  sameAsDateParse([
    "2025-00-15T12:00:00.000Z", "2025-13-15T12:00:00.000Z", "2025-13-01T00:00:00.000Z", "2025-13-28T23:59:59.999Z",
    "2025-06-00T12:00:00.000Z", "2025-06-32T12:00:00.000Z", "2025-01-32T00:00:00.000Z",
    "2025-06-15T24:00:00.000Z", "2025-12-31T24:00:00.000Z", "2025-06-15T24:00:00Z", "2025-06-15T24:00Z",
    "2025-06-15T24:01:00.000Z", "2025-06-15T24:00:01.000Z", "2025-06-15T24:00:00.001Z", "2025-06-15T24:30Z",
    "2025-06-15T12:60:00.000Z", "2025-06-15T12:59:60.000Z", "2025-06-30T23:59:60.000Z", "2025-06-15T12:60Z",
    "2025-13-15T12:00:00.000+05:30", "2025-00-15", "2025-13-15", "2025-06-00", "2025-06-32",
  ]);
  assert.equal(timeOf("2025-13-01T00:00:00.000Z"), undefined, "there is no month 13");
});

test("leading and trailing spaces, signed years, and years before 1970 and after 2100 are read as Date.parse reads them", () => {
  sameAsDateParse([
    " 2025-06-15T12:00:00.000Z", "2025-06-15T12:00:00.000Z ", " 2025-06-15T12:00:00.000Z ", "\t2025-06-15T12:00:00.000Z", "2025-06-15T12:00:00.000Z\n",
    " 2025-06-15", "2025-06-15 ", "2025-06-15T12:00:00.000 Z",
    "+002024-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z", "-000000-01-01T00:00:00.000Z", "+000000-01-01T00:00:00.000Z",
    "+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.001Z", "-271821-04-20T00:00:00.000Z", "-271821-04-19T23:59:59.999Z",
    "+2024-01-01T00:00:00.000Z", "-2024-01-01T00:00:00.000Z", "+02024-01-01T00:00:00.000Z", "002024-01-01T00:00:00.000Z",
    "1969-12-31T23:59:59.999Z", "1900-01-01T00:00:00.000Z", "1066-10-14T09:00:00.000Z", "0100-01-01T00:00:00.000Z",
    "0099-12-31T23:59:59.999Z", "0001-01-01T00:00:00.000Z", "0000-01-01T00:00:00.000Z",
    "2100-12-31T23:59:59.999Z", "2101-01-01T00:00:00.000Z", "2400-02-29T00:00:00.000Z", "5000-06-15T12:00:00.000Z", "9999-12-31T23:59:59.999Z",
  ]);
});

test("a time with no offset is local to Date.parse, and is read so in a zone that is not UTC", (t) => {
  const zone = process.env.TZ;
  t.after(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  process.env.TZ = "Asia/Kolkata";
  assert.notEqual(parsed("2025-06-15T12:00:00.000"), parsed("2025-06-15T12:00:00.000Z"), "the zone took");
  sameAsDateParse(["2025-06-15T12:00:00.000", "2025-06-15T12:00:00.0000", "2025-06-15T12:00:00", "2025-06-15T12:00", "2025-06-15T12:00:00.000Z"]);
});

test("a numeric time past what a Date holds (±8.64e15 ms) is no time, and a read that meets one still ends", async (t) => {
  assert.equal(timeOf(8.64e15), 8.64e15);
  assert.equal(timeOf(-8.64e15), -8.64e15);
  for (const value of [8.64e15 + 1, -8.64e15 - 1, 1e17, 12345678901234567890, Number.MAX_VALUE]) assert.equal(timeOf(value), undefined, String(value));
  const { READERS } = await import("../dist/index.js");
  const { claudeAnswer, claudeFile, claudeUser, anthropicUsage, tempHome, writeJsonl } = await import("./fixtures.mjs");
  const home = await tempHome(t);
  const file = await writeJsonl(claudeFile(home), [{ ...claudeUser({ uuid: "u1", text: "Fixture prompt.", i: 0 }), timestamp: 1e17 }, claudeAnswer({ uuid: "a1", msg: "msg_1", req: "req_1", usage: anthropicUsage(10, 2), i: 1 })]);
  for (const options of [{ turns: true }, { turns: false, totals: true }]) {
    const { sessions } = await READERS["claude-code"].read({ file }, undefined, options);
    assert.equal(sessions[0].session.startedAt, "2026-01-01T00:00:01.000Z", JSON.stringify(options));
  }
});
