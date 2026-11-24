// A record's time: what Date.parse gives for it, the usual shape ("YYYY-MM-DDTHH:MM:SS.sssZ") read without it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timeOf } from "../dist/text.js";

const pad = (n, w) => String(n).padStart(w, "0");
const parsed = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
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
  for (const value of times) assert.equal(timeOf(value), parsed(value), value);
  assert.equal(timeOf(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(timeOf(Number.NaN), undefined);
  assert.equal(timeOf(undefined), undefined);
});
