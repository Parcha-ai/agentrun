// A granted monid endpoint on the runner is one host tool of its own (runner/monid-run.ts), from its revision's pin (what
// the save stamped, monid.ts pinMonid): named `monid:<provider>/<endpoint>`, its call a paid step on the run's one ledger
// under that name, held at its pinned price (one priced by usage: at monid's estimate for the call's own input), sent with
// that hold as monid's maxCost, and settled at what monid charged; its ask card shows that price (or that estimate); an
// endpoint the pin does not hold is no tool, never sent; one over the cap parks the run unsent; one monid charges above
// its hold is booked at that charge and stops the run, in words and in the log. Faux monid, a scripted
// model origin, the real loop on a real store.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { KEY } from "./fixtures/faux-monid.mjs";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { specFor } from "./runner-spec-support.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { bookedIn } = await import("../dist/paid-calls.js");
const { FAUX_MONID_ENV } = await import("../dist/monid.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { monidSessionNames } = await import("../dist/runner/monid-run.js");
const { chosenTools } = await import("../dist/runner/subagent.js");
const { wireName } = await import("../dist/catalog.js");
const { DEFER_CATALOG_OVER } = await import("@parcha/agentrun-kernel");
const { paidBookings, toolLedger } = await import("./support.mjs");
after(closeOpenSessions);

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 9);
const RUN = "run-1";
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const CALLS_ENV = "AGENTRUN_TEST_FAUX_MONID_CALLS";
const ENRICH = "monid:faux/person/enrich";
const MATCH = "monid:apollo/people/match";
const ORGS = "monid:apollo/organizations/enrich";
const INPUT = { type: "object", additionalProperties: false, properties: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } }, required: ["body"] };
/** The pin a save stamps for these grants (monid.ts pinMonid over the faux listing). */
const PIN = {
  [ENRICH]: { description: "faux /person/enrich: enrich a person.", input: INPUT, usd: 0.003 },
  [MATCH]: { description: "apollo /people/match: enrich a person.", input: INPUT, usd: 0.026 },
  [ORGS]: { description: "apollo /organizations/enrich: enrich a person.", input: INPUT, usd: 0.01 },
};
const ARGS = { body: { name: "Ada" } };
const env = () => ({ [FAUX_ENV]: "faux", [FAUX_MONID_ENV]: FAUX_MONID });

/** The fake monid's call log for this test: each request it was sent, one line each. */
function callLog(t) {
  const file = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-monid-")), "calls.ndjson");
  writeFileSync(file, "");
  const before = process.env[CALLS_ENV];
  process.env[CALLS_ENV] = file;
  t.after(() => {
    if (before === undefined) delete process.env[CALLS_ENV]; else process.env[CALLS_ENV] = before;
    rmSync(file, { force: true });
  });
  return () => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.path === "/v1/run");
}

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("each pinned endpoint is one host tool of its own; a call books under its own name at its own price, sent once to its endpoint", async (t) => {
  const sent = callLog(t);
  const { spec } = await specFor(t, { body: { tools: [ENRICH, "monid:apollo/*"], monidPin: PIN }, keys: { MONID_API_KEY: KEY }, env: env() });
  const names = spec.mcp.tools.map((tool) => spec.mcp.catalogOf(tool.name));
  assert.deepEqual(names.sort(), [MATCH, ORGS, ENRICH].sort(), "one tool per pinned endpoint, by its catalog name");
  const match = spec.mcp.tools.find((tool) => spec.mcp.catalogOf(tool.name) === MATCH);
  assert.equal(match.name, "monid__apollo__people__match", "called by its wire name");
  assert.deepEqual(match.inputSchema, INPUT, "the pinned input");
  assert.equal(match.replay, "never");
  const paid = await toolLedger(1);
  const answer = await bookedIn({ call: "c1", paid }, () => match.call(ARGS, { callId: "c1", signal: new AbortController().signal, attempt: 0 }));
  assert.equal(answer.isError, undefined, answer.text);
  assert.match(answer.text, /"person":"Ada"/);
  const booked = paidBookings(await paid.records()).filter((row) => row.call === "c1");
  assert.deepEqual(booked.map((row) => [row.kind, row.tool, row.charged_by, row.heldUsd ?? row.usd]), [["agentrun.tool_started", MATCH, "monid", 0.026], ["agentrun.tool_cost", MATCH, "monid", 0.026]], JSON.stringify(booked));
  assert.deepEqual(sent().map((call) => call.path), ["/v1/run"], "sent once");
});

test("a pinned endpoint's call that does not fit the cap is refused unsent, in the cap's words naming it", async (t) => {
  const sent = callLog(t);
  const { spec } = await specFor(t, { body: { tools: [MATCH], monidPin: { [MATCH]: PIN[MATCH] } }, keys: { MONID_API_KEY: KEY }, env: env() });
  const [match] = spec.mcp.tools;
  const paid = await toolLedger(0.01);
  const answer = await bookedIn({ call: "c1", paid }, () => match.call(ARGS, { callId: "c1", signal: new AbortController().signal, attempt: 0 }));
  assert.equal(answer.isError, true);
  assert.match(answer.text, /Not sent: .*monid:apollo\/people\/match, could cost up to \$0\.026/, answer.text);
  assert.deepEqual(sent(), [], "never sent");
});

test("a call is sent with its hold as monid's maxCost: an endpoint monid now prices above its pinned price is refused by monid unrun, and nothing is booked past the hold", async (t) => {
  const sent = callLog(t);
  // Pinned at $0.003 when the agent was saved; monid charges $0.026 now.
  const stale = { ...PIN[MATCH], usd: 0.003 };
  const { spec } = await specFor(t, { body: { tools: [MATCH], monidPin: { [MATCH]: stale } }, keys: { MONID_API_KEY: KEY }, env: env() });
  const [match] = spec.mcp.tools;
  const paid = await toolLedger(0.01);
  const answer = await bookedIn({ call: "c1", paid }, () => match.call(ARGS, { callId: "c1", signal: new AbortController().signal, attempt: 0 }));
  assert.deepEqual(sent().map((call) => call.maxCost), [0.003], "sent once, its hold as maxCost");
  assert.equal(answer.isError, true, answer.text);
  assert.match(answer.text, /estimated cost ~\$0\.026 is above maxCost \$0\.003/, answer.text);
  assert.ok(paid.spentUsd() <= 0.003, `booked $${paid.spentUsd()} on a call held at $0.003`);
  assert.equal(paid.heldUsd(), 0, "its hold released");
});

/** faux /person/search: priced per result ($0.001 a result), so monid estimates a call from its own `limit`; a call
 *  charges $1.42 unless the test says otherwise (charging). */
const SEARCH = "monid:faux/person/search";
/** Its pin as a save stamps an endpoint priced by usage: no fixed price. */
const USAGE_PIN = { [SEARCH]: { description: "faux /person/search: enrich a person.", input: INPUT, usd: null } };
/** Three results: monid's estimate is $0.003. */
const SEARCH_ARGS = { body: { name: "Ada", limit: 3 } };

test("a call priced by usage is held at monid's estimate for its own input, sent with that estimate as maxCost, and settled at its charge", async (t) => {
  const sent = callLog(t);
  charging(t, 0.002);
  const { spec } = await specFor(t, { body: { tools: [SEARCH], monidPin: USAGE_PIN }, keys: { MONID_API_KEY: KEY }, env: env() });
  const [search] = spec.mcp.tools;
  const paid = await toolLedger(1);
  const answer = await bookedIn({ call: "c1", paid }, () => search.call(SEARCH_ARGS, { callId: "c1", signal: new AbortController().signal, attempt: 0 }));
  assert.equal(answer.isError, undefined, answer.text);
  assert.deepEqual(sent().map((call) => call.maxCost), [0, 0.003], "the estimate read (maxCost 0: monid runs and charges nothing), then the call at that estimate");
  const booked = paidBookings(await paid.records()).filter((row) => row.call === "c1");
  assert.deepEqual(booked.map((row) => [row.kind, row.tool, row.heldUsd ?? row.usd]), [["agentrun.tool_started", SEARCH, 0.003], ["agentrun.tool_cost", SEARCH, 0.002]], JSON.stringify(booked));
});

test("a call priced by usage whose estimate does not fit the cap is refused unsent, in the cap's words naming its estimate", async (t) => {
  const sent = callLog(t);
  const { spec } = await specFor(t, { body: { tools: [SEARCH], monidPin: USAGE_PIN }, keys: { MONID_API_KEY: KEY }, env: env() });
  const [search] = spec.mcp.tools;
  const paid = await toolLedger(0.002);
  const answer = await bookedIn({ call: "c1", paid }, () => search.call(SEARCH_ARGS, { callId: "c1", signal: new AbortController().signal, attempt: 0 }));
  assert.equal(answer.isError, true);
  assert.match(answer.text, /Not sent: .*monid:faux\/person\/search, could cost up to \$0\.003/, answer.text);
  assert.deepEqual(sent().map((call) => call.maxCost), [0], "only the estimate read, which runs nothing");
});

test("an endpoint monid has re-priced by usage since the save is held at monid's estimate for the call, as any call priced by usage", async (t) => {
  const sent = callLog(t);
  charging(t, 0.001);
  // Pinned at $0.01 a call when the agent was saved; monid now prices it per result and estimates one result ($0.001).
  const stale = { ...USAGE_PIN[SEARCH], usd: 0.01 };
  const { spec } = await specFor(t, { body: { tools: [SEARCH], monidPin: { [SEARCH]: stale } }, keys: { MONID_API_KEY: KEY }, env: env() });
  const [search] = spec.mcp.tools;
  const paid = await toolLedger(0.5);
  const answer = await bookedIn({ call: "c1", paid }, () => search.call(ARGS, { callId: "c1", signal: new AbortController().signal, attempt: 0 }));
  assert.equal(answer.isError, undefined, answer.text);
  assert.deepEqual(sent().map((call) => call.maxCost), [0, 0.001]);
  const booked = paidBookings(await paid.records()).filter((row) => row.call === "c1");
  assert.deepEqual(booked.map((row) => [row.kind, row.heldUsd ?? row.usd]), [["agentrun.tool_started", 0.001], ["agentrun.tool_cost", 0.001]], JSON.stringify(booked));
});

/** run-1 on a new store, its agent granted `tools` with the pin `pin`, run by a runner on the adapter spec with a
 *  scripted model; `launch` adds to its launch body (a cap). */
async function monidRun(t, { script, tools, pin, toolSettings, launch = {}, requests = [] }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-monid-run-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await putSealedKey(server, SEAL_KEY, "MONID_API_KEY", KEY);
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Run monid.", tools, monidPin: pin, ...(toolSettings ? { toolSettings } : {}) } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Run monid." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, ...launch } });
  // Someone can answer an ask (server-approvers.ts APPROVERS_KEY), so it parks.
  await server.settings.put("approvers", { approvers: true });
  await server.flush?.();
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests), price: () => 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 100 };
  const deps = { env: env(), data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped", "parked"].includes(now.state) && now.runner === null && now;
  }, "the run rests");
  const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  return { row, records, asks: records.entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data) };
}

test("a pinned endpoint's ask card names it and shows its pinned price", async (t) => {
  callLog(t);
  const one = await monidRun(t, { tools: [MATCH], pin: { [MATCH]: PIN[MATCH] }, script: [{ call: "monid__apollo__people__match", args: ARGS }, { say: "done" }] });
  assert.deepEqual(one.asks.map((ask) => [ask.tool, ask.price]), [[MATCH, 0.026]], JSON.stringify(one.asks));
});

test("a call priced by usage asks with monid's estimate for its own input on its card, the call itself unsent", async (t) => {
  const sent = callLog(t);
  const one = await monidRun(t, { tools: [SEARCH], pin: USAGE_PIN, script: [{ call: "monid__faux__person__search", args: SEARCH_ARGS }, { say: "done" }] });
  assert.equal(one.row.state, "parked", JSON.stringify(one.row));
  assert.deepEqual(one.asks.map((ask) => [ask.tool, ask.price]), [[SEARCH, { estimate_usd: 0.003 }]], JSON.stringify(one.asks));
  assert.deepEqual(sent().map((call) => call.maxCost), [0], "only the estimate read, which runs nothing");
});

test("past the deferral threshold, tools_search finds a pinned endpoint by what it does, with its pinned input", async (t) => {
  callLog(t);
  const requests = [];
  // More endpoints than DEFER_CATALOG_OVER: the run lists none of them, and offers tools_search to find them.
  const fillers = Object.fromEntries(Array.from({ length: DEFER_CATALOG_OVER }, (_, i) => [`monid:apollo/filler/${i}`, { description: `apollo filler ${i}: does nothing.`, input: INPUT, usd: 0.001 }]));
  await monidRun(t, { tools: ["monid:apollo/*"], pin: { ...PIN, ...fillers }, requests, script: [{ call: "tools_search", args: { query: "people match" } }, { say: "done" }] });
  const listed = (requests[0]?.tools ?? []).map((tool) => tool.name);
  assert.ok(listed.includes("tools_search") && !listed.some((name) => name.startsWith("monid__")), JSON.stringify(listed));
  const results = requests.flatMap((body) => body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part.type === "tool_result");
  const found = JSON.parse([results.at(-1)?.content].flat().map((part) => (typeof part === "string" ? part : part?.text ?? "")).join(""));
  assert.equal(found[0]?.name, "monid__apollo__people__match", JSON.stringify(found));
  assert.deepEqual(found[0].input_schema, INPUT);
});

test("a subagent given a provider's wildcard gets every endpoint pinned under it, and one endpoint by its tool name; never another provider's", () => {
  const sessionNames = (grant) => monidSessionNames(grant, PIN) ?? [wireName(grant)];
  const granted = ["read", "monid:apollo/*"];
  assert.deepEqual(chosenTools(["monid:apollo/*"], { granted, sessionNames }), { catalog: ["monid:apollo/*"], names: ["monid__apollo__people__match", "monid__apollo__organizations__enrich"] });
  assert.deepEqual(chosenTools(["monid__apollo__people__match"], { granted, sessionNames }), { catalog: ["monid:apollo/*"], names: ["monid__apollo__people__match"] });
  assert.match(chosenTools(["monid__faux__person__enrich"], { granted, sessionNames }).refused, /is not one of this agent's tools/);
  assert.deepEqual(chosenTools([ENRICH], { granted: [ENRICH], sessionNames }), { catalog: [ENRICH], names: ["monid__faux__person__enrich"] });
});

test("an endpoint the agent was not granted is no tool of its run: its call is refused and never sent", async (t) => {
  const sent = callLog(t);
  const run = await monidRun(t, { tools: [MATCH], pin: { [MATCH]: PIN[MATCH] }, toolSettings: { "monid:apollo/*": { permission: "allow" } }, script: [{ call: "monid__faux__person__enrich", args: ARGS }, { say: "done" }] });
  assert.equal(run.row.state, "ended", JSON.stringify(run.row));
  assert.deepEqual(run.asks, [], "nothing asked");
  assert.deepEqual(sent(), [], "never sent");
});

/** The fake monid charges each run `usd` from here on in this test, past its estimate when `usd` is above it. */
function charging(t, usd) {
  const before = process.env.AGENTRUN_TEST_FAUX_MONID_CHARGE;
  process.env.AGENTRUN_TEST_FAUX_MONID_CHARGE = String(usd);
  t.after(() => {
    if (before === undefined) delete process.env.AGENTRUN_TEST_FAUX_MONID_CHARGE; else process.env.AGENTRUN_TEST_FAUX_MONID_CHARGE = before;
  });
}
/** A run whose model calls the endpoint twice, a turn each, then answers: allowed, under a $1 cap. */
const twice = (t, requests) => monidRun(t, { tools: [MATCH], pin: { [MATCH]: PIN[MATCH] }, toolSettings: { [MATCH]: { permission: "allow" } }, launch: { max_cost_usd: 1 }, requests, script: [{ call: "monid__apollo__people__match", args: ARGS }, { call: "monid__apollo__people__match", args: ARGS }, { say: "done" }] });
/** The error lines logged about a monid charge above its hold. */
const overHoldLines = (errors) => errors.mock.calls.map((call) => call.arguments.join(" ")).filter((line) => line.includes("more than the"));

test("a monid charge above its call's hold is booked at what monid charged, and the run stops at once in words that say so, logged", async (t) => {
  const sent = callLog(t);
  // Pinned (and held) at $0.026, its maxCost; monid re-priced it after the read and charges $0.05.
  charging(t, 0.05);
  const errors = t.mock.method(console, "error", () => {});
  const requests = [];
  const run = await twice(t, requests);
  const WORDS = "monid charged $0.05, more than the $0.026 held; the run stopped";
  const booked = paidBookings(run.records.entries).filter((row) => row.tool === MATCH);
  assert.deepEqual(booked.map((row) => [row.kind, row.heldUsd ?? row.usd]), [["agentrun.tool_started", 0.026], ["agentrun.tool_cost", 0.05]], `the real charge, never the hold: ${JSON.stringify(booked)}`);
  assert.deepEqual(sent().length, 1, "no further tool call after its result");
  assert.equal(requests.length, 1, "no further model turn after its result");
  assert.deepEqual([run.row.state, run.row.summary], ["failed", WORDS], JSON.stringify(run.row));
  const lines = overHoldLines(errors);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  for (const part of [RUN, MATCH, "$0.026", "$0.05"]) assert.ok(lines[0].includes(part), `${part} in ${lines[0]}`);
});

test("a monid charge above its hold inside a script stops the script's next call too: nothing runs after it", async (t) => {
  const sent = callLog(t);
  charging(t, 0.05);
  t.mock.method(console, "error", () => {});
  const requests = [];
  const call = "await tools.monid__apollo__people__match({ body: { name: 'Ada' } });";
  const run = await monidRun(t, { tools: [MATCH], pin: { [MATCH]: PIN[MATCH] }, toolSettings: { [MATCH]: { permission: "allow" } }, launch: { max_cost_usd: 1 }, requests, script: [{ call: "codemode", args: { script: `${call} ${call} return 'both ran';` } }, { say: "done" }] });
  assert.equal(sent().length, 1, "the script's second call is never sent");
  assert.equal(requests.length, 1, "no further model turn");
  assert.deepEqual([run.row.state, run.row.summary], ["failed", "monid charged $0.05, more than the $0.026 held; the run stopped"], JSON.stringify(run.row));
});

test("a monid charge above both its hold and the run's cap ends the run in the charge's words, not the cap's", async (t) => {
  callLog(t);
  charging(t, 0.05);
  t.mock.method(console, "error", () => {});
  // Held at $0.026 under a $0.04 cap; charged $0.05, past both.
  const run = await monidRun(t, { tools: [MATCH], pin: { [MATCH]: PIN[MATCH] }, toolSettings: { [MATCH]: { permission: "allow" } }, launch: { max_cost_usd: 0.04 }, script: [{ call: "monid__apollo__people__match", args: ARGS }, { say: "done" }] });
  assert.deepEqual([run.row.state, run.row.summary], ["failed", "monid charged $0.05, more than the $0.026 held; the run stopped"], JSON.stringify(run.row));
});

test("a call priced by usage that monid charges above its estimate is booked at its charge, and the run stops at once in words that say so", async (t) => {
  const sent = callLog(t);
  t.mock.method(console, "error", () => {});
  const requests = [];
  // Estimated (and held) at $0.003 for three results; monid charges $1.42.
  const run = await monidRun(t, { tools: [SEARCH], pin: USAGE_PIN, toolSettings: { [SEARCH]: { permission: "allow" } }, launch: { max_cost_usd: 1 }, requests, script: [{ call: "monid__faux__person__search", args: SEARCH_ARGS }, { call: "monid__faux__person__search", args: SEARCH_ARGS }, { say: "done" }] });
  const booked = paidBookings(run.records.entries).filter((row) => row.tool === SEARCH);
  assert.deepEqual(booked.map((row) => [row.kind, row.heldUsd ?? row.usd]), [["agentrun.tool_started", 0.003], ["agentrun.tool_cost", 1.42]], JSON.stringify(booked));
  assert.deepEqual(sent().map((call) => call.maxCost), [0, 0.003], "no further call after its result");
  assert.equal(requests.length, 1, "no further model turn after its result");
  assert.deepEqual([run.row.state, run.row.summary], ["failed", "monid charged $1.42, more than the $0.003 held; the run stopped"], JSON.stringify(run.row));
});

test("a monid charge at its call's hold is booked and the run goes on, as before", async (t) => {
  const sent = callLog(t);
  charging(t, 0.026);
  const errors = t.mock.method(console, "error", () => {});
  const requests = [];
  const run = await twice(t, requests);
  const booked = paidBookings(run.records.entries).filter((row) => row.kind === "agentrun.tool_cost" && row.tool === MATCH);
  assert.deepEqual(booked.map((row) => row.usd), [0.026, 0.026]);
  assert.equal(sent().length, 2, "its second call is sent");
  assert.equal(requests.length, 3, "and the model's turns after it are taken");
  assert.equal(run.row.state, "ended", JSON.stringify(run.row));
  assert.deepEqual(overHoldLines(errors), []);
});

test("a pinned endpoint's call over the run's cap parks the run on its cap, the call unsent", async (t) => {
  const sent = callLog(t);
  const run = await monidRun(t, { tools: [MATCH], pin: { [MATCH]: PIN[MATCH] }, toolSettings: { [MATCH]: { permission: "allow" } }, launch: { max_cost_usd: 0.01 }, script: [{ call: "monid__apollo__people__match", args: ARGS }, { say: "done" }] });
  assert.equal(run.row.state, "parked", JSON.stringify(run.row));
  assert.deepEqual(sent(), [], "never sent");
});
