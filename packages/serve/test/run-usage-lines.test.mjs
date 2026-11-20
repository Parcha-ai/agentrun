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
/** The line on `meter` for `name`: its model, its charger or its provider. */
const line = (lines, meter, name) => lines.find((one) => one.meter === meter && (one.model ?? one.charged_by ?? one.provider) === name);
const nameOf = (one) => one.model ?? one.charged_by ?? one.provider;
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
  const { lines, total } = usageLinesOf(entries, { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } });
  assert.deepEqual(lines.map((one) => `${one.meter}/${nameOf(one)}`), ["tokens/anthropic/claude-sonnet-5-5", "tokens/jev", "tokens/openai/gpt-6.1-mini", "tools/fake", "tools/monid", "browser_time/browserbase"], "tokens first, then tools, then browser time, each by its name");

  const sonnet = line(lines, "tokens", "anthropic/claude-sonnet-5-5");
  assert.deepEqual(sonnet, { meter: "tokens", model: "anthropic/claude-sonnet-5-5", provider: "anthropic", charged_by: null, quantity: 2700, unit: "token", basis: "reported", usd: 0.05, requests: 2, tokens: { input: 1800, output: 300, cache_read: 500, cache_write: 100 }, unmetered_requests: 0 });
  const mini = line(lines, "tokens", "openai/gpt-6.1-mini");
  assert.equal(mini.basis, "estimate", "priced from a table");
  assert.equal(mini.quantity, 350);
  assert.equal(mini.provider, null, "a model the server did not route itself: no provider named");
  assert.equal(line(lines, "tokens", "jev").usd, 0.00004, "a decision is a model request on its own model");
  assert.equal(line(lines, "tokens", "jev").provider, null);

  assert.deepEqual(line(lines, "tools", "monid"), { meter: "tools", model: null, provider: null, charged_by: "monid", quantity: 2, unit: "call", basis: "estimate", usd: 0.006 });
  assert.deepEqual(line(lines, "tools", "fake"), { meter: "tools", model: null, provider: null, charged_by: "fake", quantity: 1, unit: "call", basis: "estimate", usd: 0.05 });
  assert.deepEqual(line(lines, "browser_time", "browserbase"), { meter: "browser_time", model: null, provider: "browserbase", charged_by: null, quantity: 75.25, unit: "second", basis: "estimate", usd: 0.0025 });

  // 0.03 + 0.02 + 0.001 + 0.00004 + 0.003 + 0.05 + 0.003 + 0.002 + 0.0005
  assert.deepEqual(total, { usd: 0.10954 }, "the join of every charge");
  assert.equal(micro(lines.reduce((sum, one) => sum + one.usd, 0)), micro(total.usd), "the lines sum to it");
});

test("a charge of unknown cost: its line's usd is null with what is known beside it, and the total is null, never $0", () => {
  const entries = [
    ...keys(),
    ...reported(7, 1, "m", 0.01, usage(100, 10)),
    ...paid(1, "monid:faux/late", "monid", 0.003),
    e(9, "runner.request", { turn: 2, model: "paid:monid:faux/late", paid: true, charged_by: "monid" }),
    e(9, "runner.turn", { turn: 2, usd: null, rule: "answered" }),
  ];
  const { lines, total } = usageLinesOf(entries);
  const tools = line(lines, "tools", "monid");
  assert.equal(tools.usd, null);
  assert.equal(tools.so_far_usd, 0.003, "the known charge");
  assert.equal(tools.unpriced, 1);
  assert.equal(tools.quantity, 2, "both calls were made");
  assert.equal(line(lines, "tokens", "m").usd, 0.01, "the other meter is still known");
  assert.deepEqual(total, { usd: null, so_far_usd: 0.013, unpriced: 1 }, "the total says what is known of it, never a bare null");
});

test("a request sent and never answered: counted on its model as unpriced and unmetered, in no token count", () => {
  const entries = [...keys(), ...reported(7, 1, "m", 0.01, usage(100, 10)), e(7, "runner.request", { turn: 2, model: "m" })];
  const { lines, total } = usageLinesOf(entries);
  const m = line(lines, "tokens", "m");
  assert.equal(m.requests, 2);
  assert.equal(m.unmetered_requests, 1);
  assert.equal(m.quantity, 110);
  assert.equal(m.usd, null);
  assert.equal(m.so_far_usd, 0.01);
  assert.deepEqual(total, { usd: null, so_far_usd: 0.01, unpriced: 1 });
});

test("a run that booked nothing has no lines and costs $0; a hold given back is no line", () => {
  assert.deepEqual(usageLinesOf(keys()), { lines: [], total: { usd: 0 } });
  const given = [...keys(), e(9, "runner.request", { turn: 1, model: "paid:x", paid: true, charged_by: "monid" }), e(9, "runner.turn", { turn: 1, usd: 0, givenBack: true })];
  assert.deepEqual(usageLinesOf(given), { lines: [], total: { usd: 0 } });
});

test("browser seconds with no charge booked for them: the seconds are said, their cost unknown", () => {
  const entries = [...keys(), e(1, "agentrun.browser_charged", { tool: "browser", charged_by: "steel", seconds: 12, tag: "s" })];
  const { lines, total } = usageLinesOf(entries);
  assert.deepEqual(lines, [{ meter: "browser_time", model: null, provider: "steel", charged_by: null, quantity: 12, unit: "second", basis: "unpriced", usd: null }]);
  assert.deepEqual(total, { usd: null, so_far_usd: 0, unpriced: 1 });
});

test("a model gateway's requests name no provider: the server does not know its upstream; a direct route names its own", () => {
  const entries = [...keys(), ...reported(7, 1, "claude-sonnet-5-5", 0.01, usage(10, 1))];
  assert.equal(usageLinesOf(entries, { model: { provider: "agent-model", modelId: "claude-sonnet-5-5" } }).lines[0].provider, null, "behind the gateway");
  assert.equal(usageLinesOf(entries, { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } }).lines[0].provider, "anthropic", "the run's model on its provider's key, as the CLI books it (its bare id)");
  assert.equal(usageLinesOf(entries).lines[0].provider, null, "no launch: unknown");
});

test("a paid tool's basis: `reported` when every charge is its provider's own figure, `estimate` once one is a price this server holds", () => {
  const own = [...keys(), ...paid(1, "monid:a", "monid", 0.003, { reported: true }), ...paid(2, "monid:a", "monid", 0.004, { reported: true })];
  assert.equal(line(usageLinesOf(own).lines, "tools", "monid").basis, "reported");
  const mixed = [...own, ...paid(3, "monid:a", "monid", 0.001)];
  assert.equal(line(usageLinesOf(mixed).lines, "tools", "monid").basis, "estimate", "an older record with no mark is an estimate");
  const given = [...own, e(9, "runner.request", { turn: 4, model: "paid:monid:a", paid: true, charged_by: "monid" }), e(9, "runner.turn", { turn: 4, usd: 0, givenBack: true })];
  assert.equal(line(usageLinesOf(given).lines, "tools", "monid").basis, "reported", "a hold given back was never priced, so it says nothing of the basis");
});

test("tool calls with no price set are counted on their charger's line, outside its dollars, as GET /usage counts them", () => {
  const unmetered = (by) => e(1, "agentrun.tool_unmetered", { tool: "mcp__docs__search", charged_by: by, call: `c${id}` });
  const entries = [...keys(), ...paid(1, "mcp:fake/paid", "fake", 0.05), unmetered("fake"), unmetered("docs"), unmetered("docs")];
  const { lines, total } = usageLinesOf(entries);
  assert.deepEqual(line(lines, "tools", "fake"), { meter: "tools", model: null, provider: null, charged_by: "fake", quantity: 1, unit: "call", basis: "estimate", usd: 0.05, not_metered_calls: 1 });
  assert.deepEqual(line(lines, "tools", "docs"), { meter: "tools", model: null, provider: null, charged_by: "docs", quantity: 0, unit: "call", basis: "unpriced", usd: 0, not_metered_calls: 2 }, "a server its owner priced nothing on: its calls said, no charge booked");
  assert.deepEqual(total, { usd: 0.05 }, "they never make the cost unknown");
});

test("a request cut at its hold: its line and the total are a bound, and say so", () => {
  const entries = [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1)), e(7, "runner.request", { turn: 2, model: "m" }), e(7, "runner.turn", { turn: 2, bookedUsd: 0.02, rule: "cut", atMost: true })];
  const { lines, total } = usageLinesOf(entries);
  assert.equal(line(lines, "tokens", "m").upper_bound, true);
  assert.equal(total.upper_bound, true, "the total keeps the bound, as cost.usd does");
  assert.equal(micro(total.usd), micro(0.03));
});

test("a browser hold given back with no time charged used nothing: no line, and the total stays known (#3281 review)", () => {
  const entries = [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1)), e(9, "runner.request", { turn: 1, model: "paid:browser", paid: true, charged_by: "browserbase", tool: "browser", hold: true }), e(9, "runner.turn", { turn: 1, usd: 0, givenBack: true })];
  const { lines, total } = usageLinesOf(entries);
  assert.deepEqual(lines.map((one) => one.meter), ["tokens"]);
  assert.deepEqual(total, { usd: 0.01 });
});

/** A workflow decision booked as the cap books it: its request named by its id, its cost kept, no usage. */
const decision = (turn, id, usd) => [e(8, "runner.request", { turn, model: `decision:${id}` }), e(8, "runner.turn", { turn, usd, bookedUsd: usd, rule: "answered" })];

test("a decision's tokens are its receipt's, and it is not counted as reporting none (#3281 review)", () => {
  const entries = [...keys(), ...decision(1, "d1", 0.00003), ...decision(2, "d2", 0.00002)];
  const receipts = new Map([["d1", { model: "jev-1.14.0", provider: "jev", cost_basis: "reported", usage: { input_tokens: 400, output_tokens: 3 } }], ["d2", { model: "jev-1.14.0", provider: "jev", cost_basis: "reported" }]]);
  const [jev] = usageLinesOf(entries, undefined, receipts).lines;
  assert.deepEqual([jev.model, jev.provider, jev.requests, jev.tokens, jev.quantity, jev.unmetered_requests, jev.usd, jev.basis], ["jev-1.14.0", "jev", 2, { input: 400, output: 3, cache_read: 0, cache_write: 0 }, 403, 1, 0.00005, "reported"], "d2's receipt says no tokens: it alone reported none");
});

test("one model reached two ways is two lines, each with its own route's provider; a receipt with no model leaves model null (#3281 review)", () => {
  const entries = [...keys(), ...reported(7, 1, "openai/gpt-6.1-mini", 0.001, usage(100, 10)), ...decision(1, "d1", 0.0002), ...decision(2, "d2", 0.0001)];
  const receipts = new Map([["d1", { model: "openai/gpt-6.1-mini", provider: "openrouter", cost_basis: "reported" }], ["d2", { provider: "openrouter", cost_basis: "reported" }]]);
  const { lines } = usageLinesOf(entries, { model: { provider: "agent-model", modelId: "openai/gpt-6.1-mini" } }, receipts);
  assert.deepEqual(lines.map((one) => [one.model, one.provider, one.usd]), [[null, "openrouter", 0.0001], ["openai/gpt-6.1-mini", null, 0.001], ["openai/gpt-6.1-mini", "openrouter", 0.0002]]);
});

/** A store over `run` and its journal (`entries`, `submissions`), each read inside its snapshot only: a read of the store
 *  outside it throws, and `reads` says what was read inside. */
function snapshotStore(run, { entries = [], submissions = [], launch, rounds = 0 } = {}) {
  const reads = [];
  const conversations = [...new Set(entries.map((one) => one.conversationId))].map((one) => ({ id: one }));
  const page = (items) => ({ items });
  const inside = {
    runs: {
      get: async () => (reads.push("run"), run),
      launch: async () => { reads.push("launch"); if (!launch) throw new Error("no launch"); return { body: launch }; },
    },
    learning: { proposal: async (_id, round) => (reads.push("rounds"), rounds === 0 ? undefined : { round: round ?? rounds }) },
    readJournal: () => (reads.push("journal"), {
      scanConversations: async () => page(conversations),
      scanEntries: async ({ conversationId }) => page(entries.filter((one) => one.conversationId === conversationId)),
      scanTasks: async () => page([]),
      scanSubmissions: async () => page(submissions),
    }),
  };
  const outside = new Proxy({}, { get: (_, key) => { throw new Error(`read outside the snapshot: ${String(key)}`); } });
  const store = new Proxy(outside, { get: (target, key) => (key === "snapshot" ? (read) => read(inside) : target[key]) });
  return { store, reads };
}
const ENDED = Date.UTC(2026, 10, 19, 10, 0, 0);
const ended = (extra = {}) => ({ id: "run_1", state: "ended", endedAt: ENDED, importedFrom: null, ...extra });

test("an ended run's usage is read in one snapshot of the store, every read of it: its state, launch, rounds and journal", async () => {
  const { runUsageOverStore } = await import("../dist/run-usage.js");
  const { store, reads } = snapshotStore(ended(), { entries: [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1))] });
  const read = await runUsageOverStore(store, "run_1");
  assert.deepEqual(reads, ["run", "launch", "rounds", "journal"], "each read inside the snapshot, none outside (an outside read throws)");
  assert.equal(read.ended_at, "2026-11-19T10:00:00.000Z", "the moment the lines cover");
  assert.deepEqual(read.total, { usd: 0.01 });
  assert.equal(read.lines.length, 1);
});

test("a run at work says so with no lines and no end; an unknown run is undefined", async () => {
  const { runUsageOverStore } = await import("../dist/run-usage.js");
  const { store } = snapshotStore({ id: "run_1", state: "running", endedAt: null });
  assert.deepEqual(await runUsageOverStore(store, "run_1"), { run_id: "run_1", ended_at: null, currency: "USD", total: null, lines: null, reason: "running" });
  assert.equal(await runUsageOverStore(snapshotStore(undefined).store, "run_nope"), undefined);
});

test("not_booked: an imported run and an SDK run, whose figure is their harness's, never split into lines", async () => {
  const { runUsageOverStore } = await import("../dist/run-usage.js");
  const cases = [
    snapshotStore(ended({ importedFrom: { harness: "claude-code", session: "s" } })),
    snapshotStore(ended(), { launch: { place: { mode: "runner" }, sdk: { runtime: "claude-agent-sdk", instructions: "" } } }),
  ];
  for (const { store } of cases) {
    const read = await runUsageOverStore(store, "run_1");
    assert.deepEqual([read.lines, read.total, read.reason, read.ended_at], [null, null, "not_booked", "2026-11-19T10:00:00.000Z"]);
  }
});

test("reopened: a learning run a follow-up opened again has no lines, since its booking can't be split by round", async () => {
  const { runUsageOverStore } = await import("../dist/run-usage.js");
  const { store, reads } = snapshotStore(ended(), { rounds: 2, entries: [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1))] });
  const read = await runUsageOverStore(store, "run_1");
  assert.deepEqual([read.lines, read.reason], [null, "reopened"]);
  assert.ok(!reads.includes("journal"), "its journal is not read");
});

test("the end-of-run learning turn is not on the lines: it is the server's work for the agent, which cost.usd leaves out too", async () => {
  const { runUsageOverStore } = await import("../dist/run-usage.js");
  const job = [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1))];
  // The learning turn: its person entry opens it, the run's end closes it; its request is on the same model.
  const start = e(7, "agentrun.end-of-run.turn", { role: "person", requestId: "learn-reflect-1" });
  const learning = [start, ...reported(7, 2, "m", 0.5, usage(5000, 500)), e(1, "agentrun.end", { status: "completed" })];
  const { store } = snapshotStore(ended(), { rounds: 1, entries: [...job, ...learning] });
  const read = await runUsageOverStore(store, "run_1");
  assert.deepEqual(read.lines.map((one) => [one.model, one.requests, one.usd]), [["m", 1, 0.01]], "the job's request alone");
  assert.deepEqual(read.total, { usd: 0.01 });
});

test("served, a name on a line is cut of the server's secrets, as the run's trace serves a model's name (#3281 review)", async () => {
  const { servedRunUsage } = await import("../dist/run-usage.js");
  const secret = "sk-planted-0123456789abcdef";
  const { store } = snapshotStore(ended(), { entries: [...keys(), ...reported(7, 1, `acme/${secret}`, 0.01, usage(10, 1))] });
  // The cut reads the run's row outside the snapshot, as the trace's does.
  const served = new Proxy(store, { get: (target, key) => (key === "runs" ? { get: async () => ended(), launch: async () => { throw new Error("no launch"); } } : target[key]) });
  const read = await servedRunUsage({ serverSecrets: () => [secret] }, served, "run_1");
  assert.equal(read.lines.length, 1);
  assert.ok(!JSON.stringify(read).includes(secret), "the secret is not served");
  assert.match(read.lines[0].model, /^acme\/\[redacted\]/);
  assert.deepEqual(read.total, { usd: 0.01 }, "the figures are as read");
});
