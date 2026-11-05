// The lines one run adds to GET /usage (usage-lines.ts runLines): each meter's known dollars on its own line, whatever else
// of the run is unknown, and the lines summing to what the run is known to have spent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runLines } from "../dist/usage-lines.js";

const round = (usd) => Math.round(usd * 1e6) / 1e6;
const byLine = (lines) => Object.fromEntries(lines.map((line) => [line.name, [round(line.usd), line.unpriced]]));
const sum = (lines) => round(lines.reduce((total, line) => total + line.usd, 0));

test("a run whose model cost is unknown, with one priced tool charge ($0.003) and one unknown: tools holds the $0.003, tokens the rest, and the lines sum to what it spent so far", () => {
  const lines = runLines({ usd: null, soFar: 0.013, key: "tokens", meters: { tools: null, tokens: null, browser: { usd: 0 }, others: null, known: { tokens: 0.01, browser: 0, others: 0.003 } } });
  assert.deepEqual(byLine(lines), { tokens: [0.01, true], tools: [0.003, true] });
  assert.equal(sum(lines), 0.013);
});

test("the same with the model cost known: tokens its own dollars, tools the $0.003, unpriced on tools alone", () => {
  const lines = runLines({ usd: null, soFar: 0.013, key: "tokens", meters: { tools: null, tokens: 0.01, browser: { usd: 0 }, others: null, known: { tokens: 0.01, browser: 0, others: 0.003 } } });
  assert.deepEqual(byLine(lines), { tokens: [0.01, false], tools: [0.003, true] });
  assert.equal(sum(lines), 0.013);
});

test("browser time priced ($0.50) beside an unknown model cost: browser_time holds it, tokens the rest", () => {
  const lines = runLines({ usd: null, soFar: 0.6, key: "tokens", meters: { tools: 0.5, tokens: null, browser: { usd: 0.5 }, others: 0, known: { tokens: 0.1, browser: 0.5, others: 0 } } });
  assert.deepEqual(byLine(lines), { tokens: [0.1, true], browser_time: [0.5, false] });
  assert.equal(sum(lines), 0.6);
});
