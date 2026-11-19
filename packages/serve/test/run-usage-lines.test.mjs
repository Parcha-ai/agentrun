// A run's usage lines from its booking (run-usage.ts usageLinesOf), over journal entries written the way the runner books
// them: model requests in the harness's session, decisions in theirs, paid calls and browser time in the paid-tools
// session, browser seconds on the root. The expected lines are worked out by hand from the entries, not from the code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { usageLinesOf } from "../dist/run-usage.js";

let id = 0;
const e = (conversationId, kind, data) => ({ id: String(++id), conversationId, kind, data });
const keys = () => [
  e(1, "agentrun.session.key", { key: "harness", conversation: 7 }),
  e(1, "agentrun.session.key", { key: "decisions", conversation: 8 }),
  e(1, "agentrun.session.key", { key: "paid-tools", conversation: 9 }),
];
const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
/** A model request answered at `usd`, reported by its gateway (the proxy keeps the table's figure beside it). */
const reported = (conv, turn, model, usd, use) => [e(conv, "runner.request", { turn, model }), e(conv, "runner.turn", { turn, usd, bookedUsd: usd, tableUsd: usd, usage: use, rule: "answered" })];
/** A model request priced from a table. */
const estimated = (conv, turn, model, usd, use) => [e(conv, "runner.request", { turn, model }), e(conv, "runner.turn", { turn, usd, bookedUsd: usd, estimated: true, usage: use, rule: "answered" })];
/** A paid charge booked in the paid-tools session. */
const paid = (turn, name, by, usd, extra = {}) => [e(9, "runner.request", { turn, model: `paid:${name}`, paid: true, charged_by: by, ...extra }), e(9, "runner.turn", { turn, usd, bookedUsd: usd, rule: "answered" })];
const line = (lines, meter, dimension) => lines.find((one) => one.meter === meter && one.dimension === dimension);
const micro = (usd) => Math.round(usd * 1e6);

test("a run on two models, a decision, two paid tools and a browser: a line per model, per charger and per provider, joining to the run's cost", () => {
  const entries = [
    ...keys(),
    ...reported(7, 1, "anthropic/claude-sonnet-5-5", 0.03, usage(1000, 200, 500, 100)),
    ...reported(7, 2, "anthropic/claude-sonnet-5-5", 0.02, usage(800, 100)),
    ...estimated(7, 3, "openai/gpt-6.1-mini", 0.001, usage(300, 50)),
    ...reported(8, 1, "jev", 0.00004, usage(40, 1)),
    ...paid(1, "monid:faux/person/enrich", "monid", 0.003),
    ...paid(2, "mcp:fake/paid", "fake", 0.05),
    ...paid(3, "monid:faux/person/enrich", "monid", 0.003),
    ...paid(4, "browser", "browserbase", 0.002, { tool: "browser", tag: "s1" }),
    ...paid(5, "browser", "browserbase", 0.0005, { tool: "browser", tag: "s1" }),
    e(1, "agentrun.browser_charged", { tool: "browser", charged_by: "browserbase", seconds: 60, tag: "s1" }),
    e(1, "agentrun.browser_charged", { tool: "browser", charged_by: "browserbase", seconds: 15.25, tag: "s1" }),
  ];
  const { lines, total_usd } = usageLinesOf(entries);
  assert.deepEqual(lines.map((one) => `${one.meter}/${one.dimension}`), ["tokens/anthropic/claude-sonnet-5-5", "tokens/jev", "tokens/openai/gpt-6.1-mini", "tools/fake", "tools/monid", "browser_time/browserbase"], "tokens first, then tools, then browser time, each by dimension");

  const sonnet = line(lines, "tokens", "anthropic/claude-sonnet-5-5");
  assert.deepEqual(sonnet, { meter: "tokens", dimension: "anthropic/claude-sonnet-5-5", quantity: 2700, unit: "token", basis: "reported", usd: 0.05, requests: 2, tokens: { input: 1800, output: 300, cache_read: 500, cache_write: 100 }, unmetered_requests: 0 });
  const mini = line(lines, "tokens", "openai/gpt-6.1-mini");
  assert.equal(mini.basis, "estimate", "priced from a table");
  assert.equal(mini.quantity, 350);
  assert.equal(line(lines, "tokens", "jev").usd, 0.00004, "a decision is a model request on its own model");

  assert.deepEqual(line(lines, "tools", "monid"), { meter: "tools", dimension: "monid", quantity: 2, unit: "call", basis: "estimate", usd: 0.006 });
  assert.deepEqual(line(lines, "tools", "fake"), { meter: "tools", dimension: "fake", quantity: 1, unit: "call", basis: "estimate", usd: 0.05 });
  assert.deepEqual(line(lines, "browser_time", "browserbase"), { meter: "browser_time", dimension: "browserbase", quantity: 75.25, unit: "second", basis: "estimate", usd: 0.0025 });

  // 0.03 + 0.02 + 0.001 + 0.00004 + 0.003 + 0.05 + 0.003 + 0.002 + 0.0005
  assert.equal(micro(total_usd), micro(0.10954), "the join of every charge");
  assert.equal(micro(lines.reduce((sum, one) => sum + one.usd, 0)), micro(total_usd), "the lines sum to it");
});

test("a charge of unknown cost: its line's usd is null with what is known beside it, and the total is null, never $0", () => {
  const entries = [
    ...keys(),
    ...reported(7, 1, "m", 0.01, usage(100, 10)),
    ...paid(1, "monid:faux/late", "monid", 0.003),
    e(9, "runner.request", { turn: 2, model: "paid:monid:faux/late", paid: true, charged_by: "monid" }),
    e(9, "runner.turn", { turn: 2, usd: null, rule: "answered" }),
  ];
  const { lines, total_usd } = usageLinesOf(entries);
  const tools = line(lines, "tools", "monid");
  assert.equal(tools.usd, null);
  assert.equal(tools.so_far_usd, 0.003, "the known charge");
  assert.equal(tools.unpriced, 1);
  assert.equal(tools.quantity, 2, "both calls were made");
  assert.equal(line(lines, "tokens", "m").usd, 0.01, "the other meter is still known");
  assert.equal(total_usd, null);
});

test("a request sent and never answered: counted on its model as unpriced and unmetered, in no token count", () => {
  const entries = [...keys(), ...reported(7, 1, "m", 0.01, usage(100, 10)), e(7, "runner.request", { turn: 2, model: "m" })];
  const { lines, total_usd } = usageLinesOf(entries);
  const m = line(lines, "tokens", "m");
  assert.equal(m.requests, 2);
  assert.equal(m.unmetered_requests, 1);
  assert.equal(m.quantity, 110);
  assert.equal(m.usd, null);
  assert.equal(m.so_far_usd, 0.01);
  assert.equal(total_usd, null);
});

test("a run that booked nothing has no lines and costs $0; a hold given back is no line", () => {
  assert.deepEqual(usageLinesOf(keys()), { lines: [], total_usd: 0 });
  const given = [...keys(), e(9, "runner.request", { turn: 1, model: "paid:x", paid: true, charged_by: "monid" }), e(9, "runner.turn", { turn: 1, usd: 0, givenBack: true })];
  assert.deepEqual(usageLinesOf(given), { lines: [], total_usd: 0 });
});

test("browser seconds with no charge booked for them: the seconds are said, their cost unknown", () => {
  const entries = [...keys(), e(1, "agentrun.browser_charged", { tool: "browser", charged_by: "steel", seconds: 12, tag: "s" })];
  const { lines, total_usd } = usageLinesOf(entries);
  assert.deepEqual(lines, [{ meter: "browser_time", dimension: "steel", quantity: 12, unit: "second", basis: "unpriced", usd: null }]);
  assert.equal(total_usd, null);
});
