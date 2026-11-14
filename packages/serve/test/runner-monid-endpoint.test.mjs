// A granted monid endpoint on the runner is one host tool of its own (runner/monid-run.ts), from its revision's pin (what
// the save stamped, monid.ts pinMonid): named `monid:<provider>/<endpoint>`, its call a paid step on the run's one ledger
// under that name, held at its pinned price and settled at what monid charged; its ask card shows that price; an
// endpoint the pin does not hold is no tool, never sent; one over the cap parks the run unsent. Faux monid, a scripted
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
const { FAUX_MONID_ENV, MONID_USAGE_CEILING_USD } = await import("../dist/monid.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { monidSessionNames } = await import("../dist/runner/monid-run.js");
const { chosenTools } = await import("../dist/runner/subagent.js");
const { wireName } = await import("../dist/catalog.js");
const { paidBookings, toolLedger } = await import("./support.mjs");
after(closeOpenSessions);

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 9);
const RUN = "run-1";
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const CALLS_ENV = "AGENTRUN_TEST_FAUX_MONID_CALLS";
const ENRICH = "monid:faux/person/enrich";
const MATCH = "monid:apollo/people/match";
const NEWS = "monid:apollo/news_articles/search";
const INPUT = { type: "object", additionalProperties: false, properties: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } }, required: ["body"] };
/** The pin a save stamps for these grants (monid.ts pinMonid over the faux listing). */
const PIN = {
  [ENRICH]: { description: "faux /person/enrich: enrich a person.", input: INPUT, usd: 0.003 },
  [MATCH]: { description: "apollo /people/match: enrich a person.", input: INPUT, usd: 0.026 },
  [NEWS]: { description: "apollo /news_articles/search: enrich a person.", input: INPUT, usd: MONID_USAGE_CEILING_USD, usage: true },
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
  assert.deepEqual(names.sort(), [MATCH, NEWS, ENRICH].sort(), "one tool per pinned endpoint, by its catalog name");
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

test("an endpoint priced by usage is held at the declared ceiling and settled at what monid charged", async (t) => {
  callLog(t);
  const { spec } = await specFor(t, { body: { tools: [NEWS], monidPin: { [NEWS]: PIN[NEWS] } }, keys: { MONID_API_KEY: KEY }, env: env() });
  const [news] = spec.mcp.tools;
  assert.equal(spec.mcp.priceOf(NEWS), MONID_USAGE_CEILING_USD, "its card shows the ceiling");
  const paid = await toolLedger(5);
  await bookedIn({ call: "c1", paid }, () => news.call(ARGS, { callId: "c1", signal: new AbortController().signal, attempt: 0 }));
  const booked = paidBookings(await paid.records()).filter((row) => row.call === "c1");
  assert.deepEqual(booked.map((row) => [row.kind, row.tool, row.heldUsd ?? row.usd]), [["agentrun.tool_started", NEWS, MONID_USAGE_CEILING_USD], ["agentrun.tool_cost", NEWS, 0.004]], JSON.stringify(booked));
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

test("a pinned endpoint's ask card names it and shows its pinned price; one priced by usage, the ceiling", async (t) => {
  callLog(t);
  const one = await monidRun(t, { tools: [MATCH], pin: { [MATCH]: PIN[MATCH] }, script: [{ call: "monid__apollo__people__match", args: ARGS }, { say: "done" }] });
  assert.deepEqual(one.asks.map((ask) => [ask.tool, ask.price]), [[MATCH, 0.026]], JSON.stringify(one.asks));
  const usage = await monidRun(t, { tools: [NEWS], pin: { [NEWS]: PIN[NEWS] }, script: [{ call: "monid__apollo__news_articles__search", args: ARGS }, { say: "done" }] });
  assert.deepEqual(usage.asks.map((ask) => [ask.tool, ask.price]), [[NEWS, MONID_USAGE_CEILING_USD]], JSON.stringify(usage.asks));
});

test("tools_search finds a pinned endpoint by what it does, with its pinned input", async (t) => {
  callLog(t);
  const requests = [];
  await monidRun(t, { tools: [MATCH, NEWS], pin: PIN, requests, script: [{ call: "tools_search", args: { query: "people match" } }, { say: "done" }] });
  const results = requests.flatMap((body) => body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part.type === "tool_result");
  const found = JSON.parse([results.at(-1)?.content].flat().map((part) => (typeof part === "string" ? part : part?.text ?? "")).join(""));
  assert.equal(found[0]?.name, "monid__apollo__people__match", JSON.stringify(found));
  assert.deepEqual(found[0].input_schema, INPUT);
});

test("a subagent given a provider's wildcard gets every endpoint pinned under it, and one endpoint by its tool name; never another provider's", () => {
  const sessionNames = (grant) => monidSessionNames(grant, PIN) ?? [wireName(grant)];
  const granted = ["read", "monid:apollo/*"];
  assert.deepEqual(chosenTools(["monid:apollo/*"], { granted, sessionNames }), { catalog: ["monid:apollo/*"], names: ["monid__apollo__people__match", "monid__apollo__news_articles__search"] });
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

test("a pinned endpoint's call over the run's cap parks the run on its cap, the call unsent", async (t) => {
  const sent = callLog(t);
  const run = await monidRun(t, { tools: [MATCH], pin: { [MATCH]: PIN[MATCH] }, toolSettings: { [MATCH]: { permission: "allow" } }, launch: { max_cost_usd: 0.01 }, script: [{ call: "monid__apollo__people__match", args: ARGS }, { say: "done" }] });
  assert.equal(run.row.state, "parked", JSON.stringify(run.row));
  assert.deepEqual(sent(), [], "never sent");
});
