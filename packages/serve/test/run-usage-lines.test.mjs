// A run's usage lines from its booking (run-usage.ts usageLinesOf), over journal entries written the way the runner books
// them: model requests in the harness's session, decisions in theirs, paid calls and browser time in the paid-tools
// session, browser seconds on the root. The expected lines are worked out by hand from the entries, not from the code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { usageLinesOf } from "../dist/run-usage.js";
import { StoreLaunchMissing } from "../dist/store/index.js";

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
  assert.deepEqual(sonnet, { meter: "tokens", model: "anthropic/claude-sonnet-5-5", provider: "anthropic", charged_by: null, quantity: 2700, unit: "token", basis: "reported", attempt: null, billable: true, usd: 0.05, requests: 2, tokens: { input: 1800, output: 300, cache_read: 500, cache_write: 100 }, unmetered_requests: 0 });
  const mini = line(lines, "tokens", "openai/gpt-6.1-mini");
  assert.equal(mini.basis, "estimate", "priced from a table");
  assert.equal(mini.quantity, 350);
  assert.equal(mini.provider, null, "a model the server did not route itself: no provider named");
  assert.equal(line(lines, "tokens", "jev").usd, 0.00004, "a decision is a model request on its own model");
  assert.equal(line(lines, "tokens", "jev").provider, null);

  assert.deepEqual(line(lines, "tools", "monid"), { meter: "tools", model: null, provider: "monid", charged_by: "monid", quantity: 2, unit: "call", basis: "estimate", attempt: null, billable: true, usd: 0.006 });
  assert.deepEqual(line(lines, "tools", "fake"), { meter: "tools", model: null, provider: "fake", charged_by: "fake", quantity: 1, unit: "call", basis: "estimate", attempt: null, billable: true, usd: 0.05 });
  assert.deepEqual(line(lines, "browser_time", "browserbase"), { meter: "browser_time", model: null, provider: "browserbase", charged_by: null, quantity: 75.25, unit: "second", basis: "estimate", attempt: null, billable: true, usd: 0.0025 });

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
  assert.deepEqual(lines, [{ meter: "browser_time", model: null, provider: "steel", charged_by: null, quantity: 12, unit: "second", basis: "unpriced", attempt: null, billable: true, usd: null }]);
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
  assert.deepEqual(line(lines, "tools", "fake"), { meter: "tools", model: null, provider: "fake", charged_by: "fake", quantity: 1, unit: "call", basis: "estimate", attempt: null, billable: true, usd: 0.05, not_metered_calls: 1 });
  assert.deepEqual(line(lines, "tools", "docs"), { meter: "tools", model: null, provider: "docs", charged_by: "docs", quantity: 0, unit: "call", basis: "unpriced", attempt: null, billable: true, usd: 0, not_metered_calls: 2 }, "a server its owner priced nothing on: its calls said, no charge booked");
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

test("a decision Parallel answered on its own API is a paid call on Parallel's tools line, beside its web search; one sent through OpenRouter stays a model's tokens; the lines still join to the run's cost", async () => {
  const { runCostOf } = await import("../dist/runner/metrics.js");
  const entries = [
    ...keys(),
    ...reported(7, 1, "m", 0.01, usage(100, 10)),
    ...paid(1, "Parallel's search", "parallel", 0.001),
    ...decision(1, "d1", 0.001),
    ...decision(2, "d2", 0.001),
    ...decision(3, "d3", 0.00003),
    ...decision(4, "d4", 0.0012),
  ];
  const receipts = new Map([
    // Parallel's API: its list price, an estimate (@parcha/agentrun-decisions parallelProvider).
    ["d1", { model: "parallel-fast", provider: "parallel", cost_basis: "estimate", usage: { input_tokens: 120, output_tokens: 0 } }],
    ["d2", { model: "parallel-fast", provider: "parallel", cost_basis: "estimate" }],
    ["d3", { model: "jev-1.14.0", provider: "jev", cost_basis: "reported" }],
    // The same provider through OpenRouter: the cost OpenRouter reported, OpenRouter's to charge.
    ["d4", { model: "parallel/decisions-fast", provider: "parallel", cost_basis: "reported" }],
  ]);
  const { lines, total } = usageLinesOf(entries, undefined, receipts);
  assert.deepEqual(lines.map((one) => `${one.meter}/${nameOf(one)}`), ["tokens/jev-1.14.0", "tokens/m", "tokens/parallel/decisions-fast", "tools/parallel"]);
  // The search's $0.001 and the two decisions' $0.001 each.
  assert.deepEqual(line(lines, "tools", "parallel"), { meter: "tools", model: null, provider: "parallel", charged_by: "parallel", quantity: 3, unit: "call", basis: "estimate", attempt: null, billable: true, usd: 0.003 });
  assert.equal(line(lines, "tokens", "parallel/decisions-fast").usd, 0.0012, "OpenRouter's route is a model's cost");
  // 0.01 + 0.001 + 0.001 + 0.001 + 0.00003 + 0.0012
  assert.deepEqual(total, { usd: 0.01423 }, "nothing counted twice");
  assert.equal(micro(lines.reduce((sum, one) => sum + one.usd, 0)), micro(total.usd), "the lines sum to it");
  assert.equal(micro(runCostOf(entries).usd), micro(total.usd), "and it is the run's cost");
});

test("a Parallel decision of unknown cost (sent, its answer lost) makes Parallel's tools line unknown, its known charges beside it", () => {
  const entries = [...keys(), ...paid(1, "Parallel's search", "parallel", 0.001), e(8, "runner.request", { turn: 1, model: "decision:d1" }), e(8, "runner.turn", { turn: 1, usd: null, rule: "answered" })];
  const receipts = new Map([["d1", { model: "parallel-fast", provider: "parallel", cost_basis: "estimate" }]]);
  const { lines, total } = usageLinesOf(entries, undefined, receipts);
  assert.deepEqual(lines.map((one) => [one.meter, nameOf(one), one.quantity, one.usd, one.so_far_usd, one.unpriced]), [["tools", "parallel", 2, null, 0.001, 1]]);
  assert.deepEqual(total, { usd: null, so_far_usd: 0.001, unpriced: 1 });
});

test("bookedDecisionsOf: the decisions named, at what each was booked, every other decision and request left out", async () => {
  const { bookedDecisionsOf } = await import("../dist/runner/metrics.js");
  const entries = [...keys(), ...reported(7, 1, "m", 0.01, usage(100, 10)), ...paid(1, "x", "parallel", 0.001), ...decision(1, "d1", 0.001), ...decision(2, "d2", 0.00003)];
  const charged = bookedDecisionsOf(entries, new Set(["d1"]));
  assert.deepEqual([charged.requests, charged.usd], [1, 0.001]);
  assert.deepEqual([bookedDecisionsOf(entries, new Set()).requests, bookedDecisionsOf(entries, new Set()).usd], [0, 0]);
});

test("chargedByParallel: Parallel's own API at its list price is Parallel's charge; its model through OpenRouter, and any other provider, is not", async () => {
  const { chargedByParallel, parallelChargedDecisions } = await import("../dist/store-reads/decisions.js");
  assert.equal(chargedByParallel({ provider: "parallel", cost_basis: "estimate" }), true);
  assert.equal(chargedByParallel({ provider: "parallel", cost_basis: "reported" }), false, "OpenRouter's route reports its cost");
  assert.equal(chargedByParallel({ provider: "parallel", cost_basis: "unknown" }), false);
  assert.equal(chargedByParallel({ provider: "jev", cost_basis: "estimate" }), false);
  assert.deepEqual([...parallelChargedDecisions([{ decision_id: "a", provider: "parallel", cost_basis: "estimate" }, { id: "b", provider: "parallel", cost_basis: "estimate" }, { decision_id: "c", provider: "openrouter", cost_basis: "reported" }])], ["a", "b"]);
});

/** A store over `run` and its journal (`entries`, `submissions`), each read inside its snapshot only: a read of the store
 *  outside it throws, and `reads` says what was read inside. */
function snapshotStore(run, { entries = [], submissions = [], launch, rounds = 0, intervals = [] } = {}) {
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
    computerIntervals: { forRun: async () => (reads.push("intervals"), intervals) },
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
  assert.deepEqual(reads, ["run", "launch", "rounds", "journal", "intervals"], "each read inside the snapshot, none outside (an outside read throws)");
  assert.equal(read.ended_at, "2026-11-19T10:00:00.000Z", "the moment the lines cover");
  assert.deepEqual(read.total, { usd: 0.01 });
  assert.equal(read.lines.length, 1);
});

test("a run at work says so with no lines and no end; an unknown run is undefined", async () => {
  const { runUsageOverStore } = await import("../dist/run-usage.js");
  const { store } = snapshotStore({ id: "run_1", state: "running", endedAt: null });
  assert.deepEqual(await runUsageOverStore(store, "run_1"), { run_id: "run_1", ended_at: null, currency: "USD", total: null, lines: null, browser_sessions: null, computer_intervals: null, infra_usd: null, reason: "running" });
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
  const served = new Proxy(store, { get: (target, key) => (key === "runs" ? { get: async () => ended(), launch: async () => { throw new StoreLaunchMissing("run_1"); } } : target[key]) });
  const read = await servedRunUsage({ serverSecrets: () => [secret] }, served, "run_1");
  assert.equal(read.lines.length, 1);
  assert.ok(!JSON.stringify(read).includes(secret), "the secret is not served");
  assert.match(read.lines[0].model, /^acme\/\[redacted\]/);
  assert.deepEqual(read.total, { usd: 0.01 }, "the figures are as read");
});

test("served, a run whose launch row can't be read is withheld: it may hold what the run's caller handed it sealed", async () => {
  const { servedRunUsage } = await import("../dist/run-usage.js");
  const { store } = snapshotStore(ended(), { entries: [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1))] });
  const served = new Proxy(store, { get: (target, key) => (key === "runs" ? { get: async () => ended(), launch: async () => { throw new Error("the store failed the read"); } } : target[key]) });
  await assert.rejects(servedRunUsage({ serverSecrets: () => [] }, served, "run_1"), (error) => error.status === 403, "withheld, never cut of the server's secrets alone");
});

test("served, a browser session's words are cut of the server's secrets too: its provider's id for it and its provider's record", async () => {
  const { servedRunUsage } = await import("../dist/run-usage.js");
  const secret = "sk-planted-session-0123456789";
  const ending = e(0, "agentrun.browser_session_ended", { tag: "t1", provider: "browserbase", provider_session_id: `sess-${secret}`, started_at: "2026-11-19T10:00:00.000Z", ended_at: "2026-11-19T10:01:00.000Z", release_reason: `closed ${secret}`, provider_record: { started_at: secret, ended_at: null, proxy_bytes: 12 }, provider_record_status: "read" });
  const { store } = snapshotStore(ended(), { entries: [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1)), ending] });
  const served = new Proxy(store, { get: (target, key) => (key === "runs" ? { get: async () => ended(), launch: async () => { throw new StoreLaunchMissing("run_1"); } } : target[key]) });
  const read = await servedRunUsage({ serverSecrets: () => [secret] }, served, "run_1");
  assert.equal(read.browser_sessions.length, 1);
  assert.ok(!JSON.stringify(read).includes(secret), "the secret is not served");
  assert.match(read.browser_sessions[0].provider_session_id, /^sess-\[redacted\]/);
  assert.equal(read.browser_sessions[0].provider_record.proxy_bytes, 12, "its figures are as read");
});

/** A computer interval row as the store reads it (store.computerIntervals.forRun), its times on the test's clock. */
const interval = (providerId, extra = {}) => ({ runId: "run_1", provider: "e2b", providerId, kind: "sandbox", gpuType: null, gpuCount: null, cpus: null, memoryMb: null, diskGb: null, startedAt: ENDED - 600_000, kept: false, endedAt: null, bookedMs: 0, ...extra });

test("an ended run's computers are served beside its lines, in the store's order, each time as ISO and its machine facts null where nothing said them; its unpriced time is a compute line with no figure, and leaves total alone", async () => {
  const { runUsageOverStore } = await import("../dist/run-usage.js");
  const intervals = [
    interval("gpu-1", { provider: "daytona", gpuType: "H100", gpuCount: 1, cpus: 4, memoryMb: 8192, diskGb: 10, startedAt: ENDED - 900_000, endedAt: ENDED - 60_000 }),
    interval("sbx-2", { kind: "desktop", kept: true }),
  ];
  const { store } = snapshotStore(ended(), { entries: [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1))], intervals });
  const read = await runUsageOverStore(store, "run_1");
  assert.deepEqual(read.computer_intervals, [
    { provider: "daytona", provider_id: "gpu-1", kind: "sandbox", gpu: { type: "H100", count: 1 }, cpus: 4, memory_mb: 8192, disk_gb: 10, started_at: "2026-11-19T09:45:00.000Z", ended_at: "2026-11-19T09:59:00.000Z", kept: false, booked_seconds: 0, attempt: null, billable: true },
    { provider: "e2b", provider_id: "sbx-2", kind: "desktop", gpu: null, cpus: null, memory_mb: null, disk_gb: null, started_at: "2026-11-19T09:50:00.000Z", ended_at: null, kept: true, booked_seconds: 0, attempt: null, billable: true },
  ]);
  // No price is set and no claim booked any of it: every compute line is unpriced (usd null), all of its time unheld, and
  // the total is the run's booked cost, the model request's alone. gpu-1 lived 840 s: 4 vCPUs are 3,360 vCPU-seconds, 8 GiB
  // 6,720 GiB-seconds, one H100 840 GPU-seconds, 10 GB of disk 10 × 840 / 2,628,000 GB-months. sbx-2 said no figure.
  const compute = read.lines.filter((one) => one.meter === "compute_time").map(({ measured_to, ...one }) => one);
  const line = (provider, resource, gpu_type, quantity, unit, open = 0) => ({ meter: "compute_time", model: null, provider, charged_by: provider, quantity, unit, basis: "unpriced", attempt: null, billable: true, usd: null, resource, gpu_type, unheld_quantity: quantity, open_computers: open });
  assert.deepEqual(compute, [
    line("daytona", "vcpu", null, 3360, "vcpu_second"),
    line("daytona", "memory", null, 6720, "gib_second"),
    line("daytona", "gpu", "H100", 840, "gpu_second"),
    line("daytona", "disk", null, Math.round((10 * 840 / 2_628_000) * 1e6) / 1e6, "gb_month"),
    line("e2b", "vcpu", null, null, "vcpu_second", 1),
    line("e2b", "memory", null, null, "gib_second", 1),
  ]);
  assert.equal(read.lines[0].meter, "tokens");
  assert.deepEqual(read.total, { usd: 0.01 }, "the run's booked cost: unpriced time is in no total");
});

test("a compute line's money is what the run's ledger booked for its provider and resource, so total stays the run's booked cost; the time no claim held is said apart", async () => {
  const { usageLinesOf } = await import("../dist/run-usage.js");
  // A sandbox with 2 vCPUs and 4 GiB lived 1,000 s; a claim booked 600 s of it (the rest it was kept for a follow-up).
  // At $0.00001 a vCPU-second and $0.000002 a GiB-second, 600 s booked $0.012 of vCPU and $0.0048 of memory.
  const rows = [interval("sbx-1", { cpus: 2, memoryMb: 4096, startedAt: ENDED - 1_000_000, endedAt: ENDED, kept: true, bookedMs: 600_000 })];
  const computeStep = (turn, tag, usd) => paid(turn, "compute", "e2b", usd, { tool: "compute", tag, owed: true });
  // A stretch's hold, given back: it names no resource and books nothing.
  const hold = [e(9, "runner.request", { turn: 9, model: "paid:hold", paid: true, charged_by: "e2b", tool: "compute", hold: true }), e(9, "runner.turn", { turn: 9, usd: 0, givenBack: true, rule: "answered" })];
  const entries = [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1)), ...computeStep(1, "vcpu", 0.012), ...computeStep(2, "memory", 0.0048), ...hold];
  const { lines, total } = usageLinesOf(entries, undefined, new Map(), { rows, at: ENDED });
  const compute = lines.filter((one) => one.meter === "compute_time");
  assert.deepEqual(compute.map((one) => [one.resource, one.quantity, one.unit, one.basis, one.usd, one.unheld_quantity, one.open_computers]), [
    ["vcpu", 2000, "vcpu_second", "estimate", 0.012, 800, 0],
    ["memory", 4000, "gib_second", "estimate", 0.0048, 1600, 0],
  ]);
  assert.deepEqual(lines.filter((one) => one.meter === "tools"), [], "a computer's bookings are not tool calls");
  assert.deepEqual(total, { usd: 0.0268 }, "the model's $0.01 and the $0.0168 booked for the computer: the lines' sum");
});

test("a computer still open is counted up to the read, and says so; a provider that bills nothing is $0, never unpriced", async () => {
  const { usageLinesOf } = await import("../dist/run-usage.js");
  const rows = [interval("box-1", { provider: "docker", cpus: 1, memoryMb: 1024, startedAt: ENDED - 60_000 })];
  const { lines } = usageLinesOf([...keys()], undefined, new Map(), { rows, at: ENDED });
  assert.deepEqual(lines.map((one) => [one.resource, one.quantity, one.basis, one.usd, one.open_computers, one.measured_to]), [
    ["vcpu", 60, "estimate", 0, 1, new Date(ENDED).toISOString()],
    ["memory", 60, "estimate", 0, 1, new Date(ENDED).toISOString()],
  ]);
  // No claim books a provider that bills nothing, yet none of its time is outside the run's cost: unheld reads 0, so a
  // free run on Docker reads as free all through (the console's $0 receipt), where a paid provider's unbooked time does not.
  assert.deepEqual(lines.map((one) => one.unheld_quantity), [0, 0]);
  const paid = usageLinesOf([...keys()], undefined, new Map(), { rows: [interval("sbx-1", { provider: "e2b", cpus: 1, memoryMb: 1024, startedAt: ENDED - 60_000, endedAt: ENDED })], at: ENDED }).lines;
  assert.deepEqual(paid.map((one) => [one.basis, one.usd, one.unheld_quantity]), [["unpriced", null, 60], ["unpriced", null, 60]]);
});

test("a run that made no computer reads [] for its computers; a run with no lines reads null, as its browser sessions do", async () => {
  const { runUsageOverStore } = await import("../dist/run-usage.js");
  const none = await runUsageOverStore(snapshotStore(ended(), { entries: [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1))] }).store, "run_1");
  assert.deepEqual(none.computer_intervals, []);
  const notBooked = await runUsageOverStore(snapshotStore(ended({ importedFrom: { harness: "claude-code", session: "s" } }), { intervals: [interval("sbx-1")] }).store, "run_1");
  assert.deepEqual([notBooked.lines, notBooked.computer_intervals], [null, null]);
});

test("served, a computer's words are cut of the server's secrets: a secret planted in its provider's id, its kind or its GPU type is not served", async () => {
  const { servedRunUsage } = await import("../dist/run-usage.js");
  const secret = "sk-planted-computer-0123456789";
  const intervals = [interval(`sbx-${secret}`, { gpuType: `gpu-${secret}`, gpuCount: 2, kind: `k-${secret}` })];
  const { store } = snapshotStore(ended(), { entries: [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1))], intervals });
  const served = new Proxy(store, { get: (target, key) => (key === "runs" ? { get: async () => ended(), launch: async () => { throw new StoreLaunchMissing("run_1"); } } : target[key]) });
  const read = await servedRunUsage({ serverSecrets: () => [secret] }, served, "run_1");
  assert.equal(read.computer_intervals.length, 1);
  assert.ok(!JSON.stringify(read).includes(secret), "the secret is not served");
  assert.match(read.computer_intervals[0].provider_id, /^sbx-\[redacted\]/);
  assert.equal(read.computer_intervals[0].gpu.count, 2, "its figures are as read");
});

test("a job's browser released at the run's end, inside the learning turn's range, keeps its end; a session the learning turn opened is not the job's (#3285 review)", async () => {
  const { runUsageOverStore } = await import("../dist/run-usage.js");
  const open = (tag) => e(0, "agentrun.browser_session_open", { tag, provider: "browserbase" });
  const end = (tag, id) => e(0, "agentrun.browser_session_ended", { tag, provider: "browserbase", provider_session_id: id, started_at: "2026-11-19T09:58:00.000Z", ended_at: "2026-11-19T10:00:00.000Z", release_reason: "run_end", provider_record: null, provider_record_status: "not_offered" });
  const job = [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1)), open("job-tab")];
  // The learning turn runs to the run's end; the run's end lets the job's browser go inside it.
  const learning = [e(7, "agentrun.end-of-run.turn", { role: "person", requestId: "learn-reflect-1" }), open("learn-tab"), end("learn-tab", "bb-learn"), end("job-tab", "bb-job"), e(1, "agentrun.end", { status: "completed" })];
  const { store } = snapshotStore(ended(), { rounds: 1, entries: [...job, ...learning] });
  const read = await runUsageOverStore(store, "run_1");
  assert.deepEqual(read.browser_sessions.map((one) => [one.tag, one.provider_session_id, one.ended_at, one.release_reason]), [["job-tab", "bb-job", "2026-11-19T10:00:00.000Z", "run_end"]]);
});

test("a run with a cut attempt: only the request the cut attempt never finished is not billable (the claim after it sends it again); its answered request, its paid call and its computer are the task's, reused", async () => {
  const { usageLinesOf, computerIntervalsOf, infraUsdOf, attemptTags } = await import("../dist/run-usage.js");
  // Attempt 1 (entries from id 1) was cut by a drain; attempt 2 (entries from id 100) took the turn over; a later turn (a
  // follow-up, entries from id 200) ran once. Each claim's first journal id is the run's next id when it claimed.
  const attempts = [
    { runId: "run_1", epoch: 1, turn: 1, attempt: 1, cause: null, cut: "drain", runner: "a", from: "queued", journalFrom: 1, claimedAt: ENDED - 900_000 },
    { runId: "run_1", epoch: 3, turn: 1, attempt: 2, cause: "drain", cut: null, runner: "b", from: "running", journalFrom: 100, claimedAt: ENDED - 600_000 },
    { runId: "run_1", epoch: 5, turn: 2, attempt: 1, cause: null, cut: null, runner: "b", from: "running", journalFrom: 200, claimedAt: ENDED - 300_000 },
  ];
  const at = (from, entries) => entries.map((one, i) => ({ ...one, id: String(from + i) }));
  // Attempt 1: one answered request and one paid call (saved: attempt 2 resumes past them), then a request the drain cut
  // (booked as cut, no answer), and a crash-cut one (sent, nothing booked after): attempt 2 sends the turn's next request.
  const entries = [
    ...at(1, [...keys(), ...reported(7, 1, "m", 0.01, usage(100, 10)), ...paid(1, "monid:faux/person/enrich", "monid", 0.003), e(1, "agentrun.browser_session_open", { tag: "s1", provider: "browserbase" }), e(7, "runner.request", { turn: 2, model: "m" }), e(7, "runner.turn", { turn: 2, cut: true, usd: null }), e(7, "runner.request", { turn: 3, model: "m" })]),
    ...at(100, [...reported(7, 4, "m", 0.02, usage(200, 20)), ...paid(2, "monid:faux/person/enrich", "monid", 0.003)]),
    ...at(200, reported(7, 5, "m", 0.04, usage(400, 40))),
  ];
  const { lines, total } = usageLinesOf(entries, undefined, new Map(), { rows: [], at: 0 }, attempts);
  assert.deepEqual(lines.map((one) => [one.meter, nameOf(one), one.attempt, one.billable, one.requests, one.usd === null ? null : micro(one.usd)]), [
    ["tokens", "m", 1, false, 2, null],
    ["tokens", "m", 1, true, 2, micro(0.05)],
    ["tokens", "m", 2, true, 1, micro(0.02)],
    ["tools", "monid", 1, true, undefined, micro(0.003)],
    ["tools", "monid", 2, true, undefined, micro(0.003)],
  ], "the cut attempt's two unfinished requests apart; its answered request with the later turn's first attempt, billable");
  assert.equal(infraUsdOf(lines), null, "the unfinished requests have no known cost: infra_usd is unknown, never a guess");
  assert.equal(total.usd, null, "nor is the total, as before attempts were kept");
  assert.equal(micro(infraUsdOf(lines.map((one) => (one.billable ? one : { ...one, usd: 0.005 })))), micro(0.005), "infra_usd is the non-billable lines' sum when each is known");
  // A computer is its maker's attempt, and billable: its time is the task's whatever claim made it.
  const computers = computerIntervalsOf([interval("sbx-1", { startedAt: ENDED - 800_000 }), interval("sbx-2", { startedAt: ENDED - 500_000 })], attempts);
  assert.deepEqual(computers.map((one) => [one.provider_id, one.attempt, one.billable]), [["sbx-1", 1, true], ["sbx-2", 2, true]]);
  const tags = attemptTags(attempts);
  assert.deepEqual([tags.atEntry("5"), tags.atEntry("150"), tags.atEntry("250")], [{ attempt: 1, billable: true }, { attempt: 2, billable: true }, { attempt: 1, billable: true }]);
  assert.deepEqual([tags.redoneAt("5"), tags.redoneAt("150"), tags.redoneAt("250")], [{ attempt: 1, billable: false }, { attempt: 2, billable: true }, { attempt: 1, billable: true }], "redone: only attempt 1 of turn 1, which attempt 2 worked again");
  assert.deepEqual(attemptTags([]).atEntry("5"), { attempt: null, billable: true }, "a run from before attempts were kept: every part billable");
});

/** A claim's attempt row as the store reads it (store.runAttempts.forRun). */
const claimRow = (epoch, turn, attempt, journalFrom, claimedAt, extra = {}) => ({ runId: "run_1", epoch, turn, attempt, cause: attempt > 1 ? "drain" : null, cut: null, runner: "r", from: epoch === 1 ? "queued" : "running", journalFrom, claimedAt, ...extra });
const ids = (from, entries) => entries.map((one, i) => ({ ...one, id: String(from + i) }));

test("a browser charge whose booking the next claim recovered (its ref) stays one line, the attempt's that wrote the charge, its total known (#3351 review)", async () => {
  const { usageLinesOf, infraUsdOf } = await import("../dist/run-usage.js");
  // Attempt 1 (cut by a drain) committed the charge on the root, then lost its process before the booking; attempt 2's
  // reopen booked it by its ref (bookRootCharges).
  const attempts = [claimRow(1, 1, 1, 1, ENDED - 900_000, { cut: "drain" }), claimRow(3, 1, 2, 100, ENDED - 600_000)];
  const charge = { tool: "browser", charged_by: "browserbase", seconds: 60, tag: "s1", at: "2026-11-19T09:50:00.000Z" };
  const entries = [
    ...ids(1, [...keys(), e(1, "agentrun.browser_charged", charge)]),
    ...ids(100, [...paid(1, "browser", "browserbase", 0.002, { tool: "browser", tag: "s1", ref: "browser:s1@2026-11-19T09:50:00.000Z" }), ...reported(7, 1, "m", 0.01, usage(10, 1))]),
  ];
  const { lines, total } = usageLinesOf(entries, undefined, new Map(), { rows: [], at: 0 }, attempts);
  const browser = lines.filter((one) => one.meter === "browser_time");
  assert.deepEqual(browser.map((one) => [one.quantity, one.usd, one.attempt, one.billable]), [[60, 0.002, 1, true]], "its seconds and its money on one line, the cut attempt's, billable: a finished charge is the task's");
  assert.equal(micro(total.usd), micro(0.012), "the total is known");
  assert.equal(infraUsdOf(lines), 0, "nothing was sent again");
});

test("a computer kept across a park is billed by the claims that held it: each claim's window of its time sits with that claim's bookings, never a line of unknown quantity (#3351 review)", async () => {
  const { usageLinesOf } = await import("../dist/run-usage.js");
  // Made under claim 1 (turn 1, parked), kept; claim 2 (turn 2) resumed it and was cut; claim 3 (turn 2, attempt 2)
  // ended the run. 1 vCPU, 1,000 s: 200 s in claim 1's window, 300 s in claim 2's, 500 s in claim 3's.
  const attempts = [claimRow(1, 1, 1, 1, ENDED - 1_000_000), claimRow(3, 2, 1, 100, ENDED - 800_000, { cut: "drain" }), claimRow(5, 2, 2, 200, ENDED - 500_000)];
  const rows = [interval("sbx-1", { cpus: 1, startedAt: ENDED - 1_000_000, endedAt: ENDED, kept: true, bookedMs: 1_000_000 })];
  const computeStep = (turn, usd) => paid(turn, "compute", "e2b", usd, { tool: "compute", tag: "vcpu", owed: true });
  const entries = [...ids(1, [...keys(), ...computeStep(1, 0.002)]), ...ids(100, computeStep(2, 0.003)), ...ids(200, computeStep(3, 0.005))];
  const { lines, total } = usageLinesOf(entries, undefined, new Map(), { rows, at: ENDED }, attempts);
  // Its vCPU lines (its memory said no figure: those lines have no quantity, and no booking).
  const compute = lines.filter((one) => one.meter === "compute_time" && one.resource === "vcpu");
  // Claim 1's and claim 2's windows are both an attempt 1 (of turns 1 and 2), billable: one line, 200 s + 300 s.
  assert.deepEqual(compute.map((one) => [one.attempt, one.billable, one.quantity, one.usd, one.unheld_quantity]), [
    [1, true, 500, 0.005, 0],
    [2, true, 500, 0.005, 0],
  ], "a line per attempt, each window's quantity with its own bookings' money");
  assert.equal(micro(total.usd), micro(0.01));
});

test("a run that took its first attempt row after its earlier work (an older run's follow-up): what came before is no attempt's, billable, even when that follow-up is cut (#3351 review)", async () => {
  const { usageLinesOf, infraUsdOf, attemptTags } = await import("../dist/run-usage.js");
  const attempts = [claimRow(7, 2, 1, 100, ENDED - 600_000, { from: "running", cut: "drain" }), claimRow(9, 2, 2, 200, ENDED - 300_000)];
  // The cut follow-up answered one request and was cut in its next (sent, never answered), which attempt 2 sent again.
  const entries = [...ids(1, [...keys(), ...reported(7, 1, "m", 0.01, usage(10, 1))]), ...ids(100, [...reported(7, 2, "m", 0.02, usage(10, 1)), e(7, "runner.request", { turn: 3, model: "m" })]), ...ids(200, reported(7, 4, "m", 0.04, usage(10, 1)))];
  const { lines } = usageLinesOf(entries, undefined, new Map(), { rows: [], at: 0 }, attempts);
  assert.deepEqual(lines.map((one) => [one.attempt, one.billable, one.usd === null ? null : micro(one.usd)]), [[null, true, micro(0.01)], [1, false, null], [1, true, micro(0.02)], [2, true, micro(0.04)]]);
  assert.equal(infraUsdOf(lines), null, "only the cut follow-up's unfinished request, of no known cost");
  assert.deepEqual(attemptTags(attempts).atTime(ENDED - 700_000), { attempt: null, billable: true }, "a computer made before it too");
});
