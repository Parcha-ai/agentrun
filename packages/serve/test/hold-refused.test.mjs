// A paid call's hold and a model request's start mark, when they cannot be made durable on a run journal at synchronous
// NORMAL (pi-durable-disk barriers.ts, paidToolHold and modelRequestStarted). With no run store to sync, nothing is
// written: the hold or the mark would sit at its figure with no sync behind it. A sync that fails after the write is
// answered in the store: a hold by its settle at $0, so the cap no longer counts it, and a start mark by its unsent end.
// Either way nothing is sent, and the words say what happened: never that the mark could not be written when it was.
// The journal's level is a test's own (settleIn's `journal`): the run journal is FULL until it moves to NORMAL.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REQUEST_ENDED, REQUEST_STARTED, TOOL_COST, TOOL_STARTED } from "@parcha/pi-durable-agent/timeline";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { capToolSpend, MARK_NOT_WRITTEN, paidHolds } from "../dist/cap.js";
import { mcpGateway } from "../dist/mcp-gateway.js";
import { FAUX_ENV } from "../dist/model.js";
import { FAUX_MONID_ENV, MONID_KEY_ENV, monidRegistration } from "../dist/monid.js";
import { bookedIn, paidRequest, settleIn } from "../dist/paid-calls.js";
import { markRequests } from "../dist/request-start.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { calls as monidCalls, KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const TOKEN = `not-a-secret-${"hold-bearer"}`;
const NO_STORE = "the run's store is not open, so";

/** A run store at NORMAL whose sync fails, as a lost disk's would: its commits go through the write, never here. */
const failingStore = { synchronous: "NORMAL", database: { exec: async () => undefined, transaction: async () => { throw new Error("the disk went away"); } } };

/** The journal at NORMAL, with `store` (undefined: none open yet) for the barrier; FULL again after the test. */
function atNormal(t, store) {
  settleIn(undefined, store, "NORMAL");
  t.after(() => settleIn(undefined, undefined));
}

/** Entries as each commit wrote them, in `entries`; "sent" in `log` for a send. */
const FEE = { name: "parallel.search", tool: "web_search", by: "parallel", usd: 0.005, basis: "the price Parallel lists" };
async function paid(entries, log) {
  const ledger = { call: "c1", record: async (kind, data) => void entries.push({ kind, data }) };
  return bookedIn(ledger, () => paidRequest(FEE, async () => (log.push("sent"), new Response("{}", { status: 200 }))));
}

test("paidToolHold, no run store at NORMAL: a paid request writes no hold and is not sent, in words that say why", async (t) => {
  atNormal(t, undefined);
  const [entries, log] = [[], []];
  await assert.rejects(paid(entries, log), (error) => {
    assert.match(error.message, /^parallel\.search was not sent: the run's store is not open, so its hold cannot be made durable/);
    return true;
  });
  assert.deepEqual([entries, log], [[], []], "nothing written, nothing sent");
});

test("paidToolHold, a sync that fails after the hold was written: its $0 settle follows, the cap no longer holds it, and the words say the hold could not be made durable", async (t) => {
  atNormal(t, failingStore);
  const [entries, log] = [[], []];
  await assert.rejects(paid(entries, log), (error) => {
    assert.match(error.message, /^parallel\.search was not sent: its hold could not be made durable \(the disk went away\)$/);
    return true;
  });
  assert.deepEqual(entries.map((e) => [e.kind, e.data.heldUsd ?? e.data.usd]), [[TOOL_STARTED, FEE.usd], [TOOL_COST, 0]]);
  assert.equal(entries[1].data.call, entries[0].data.call, "settled under its call");
  assert.equal(capToolSpend(entries), 0, "a later process counts nothing for it");
  assert.equal(paidHolds(), 0, "nor does this one");
  assert.deepEqual(log, [], "nothing sent");
});

/** monid.run under a call, its entries in `entries`, and how many runs the faux monid had. */
async function monidRun(t, entries) {
  const work = await mkdtemp(join(tmpdir(), "hold-monid-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const before = monidCalls.filter((call) => call.path === "/v1/run").length;
  const tool = monidRegistration("run", { [FAUX_ENV]: "1", [FAUX_MONID_ENV]: FAUX_MONID, [MONID_KEY_ENV]: MONID_KEY }, () => work);
  const api = { callId: "c1", commit: async (change) => change({ appendEntry: async (_conversation, entry) => void entries.push(entry) }) };
  const result = await tool.execute({ provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } }, api, { abortSignal: new AbortController().signal });
  return { text: JSON.stringify(result), sent: monidCalls.filter((call) => call.path === "/v1/run").length - before };
}

test("paidToolHold (monid), no run store at NORMAL: nothing written, nothing sent to monid, and the words say why", async (t) => {
  atNormal(t, undefined);
  const entries = [];
  const { text, sent } = await monidRun(t, entries);
  assert.deepEqual([entries, sent], [[], 0]);
  assert.match(text, /was not sent: the run's store is not open, so its hold cannot be made durable/);
});

test("paidToolHold (monid), a sync that fails after the hold: its $0 settle follows, nothing is sent to monid, and the words say the hold could not be made durable", async (t) => {
  atNormal(t, failingStore);
  const entries = [];
  const { text, sent } = await monidRun(t, entries);
  assert.deepEqual(entries.map((e) => [e.kind, e.data.heldUsd ?? e.data.usd]).slice(0, 2), [[TOOL_STARTED, entries[0]?.data.heldUsd], [TOOL_COST, 0]]);
  assert.equal(capToolSpend(entries), 0);
  assert.equal(sent, 0);
  assert.match(text, /was not sent: its hold could not be made durable \(the disk went away\)/);
  assert.doesNotMatch(text, /could not be written/);
});

/** The MCP gateway's priced call, its entries in `entries`, and how many calls the server had. */
async function mcpPaid(t, entries) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const work = await mkdtemp(join(tmpdir(), "hold-mcp-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const gateway = mcpGateway({
    pin: { fake: { url: fake.url, tools: [{ name: "paid", inputSchema: { type: "object" } }], prices: { paid: 0.05 } } },
    credentials: { fake: { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } } },
    work: () => work,
    commit: () => async (change) => change({ appendEntry: async (_conversation, entry) => void entries.push(entry) }),
  });
  const result = await gateway.call("fake", "paid", { query: "ada" }, { signal: new AbortController().signal, callId: "c1" });
  return { result, sent: fake.log.filter((entry) => entry.method === "tools/call").length };
}

test("paidToolHold (MCP gateway), no run store at NORMAL: nothing written, nothing sent to the server, and the words say why", async (t) => {
  atNormal(t, undefined);
  const entries = [];
  const { result, sent } = await mcpPaid(t, entries);
  assert.deepEqual([entries, sent, result.isError], [[], 0, true]);
  assert.match(result.content[0].text, /was not sent: the run's store is not open, so its hold cannot be made durable/);
});

test("paidToolHold (MCP gateway), a sync that fails after the hold: its $0 settle follows, nothing is sent, and the words say the hold could not be made durable", async (t) => {
  atNormal(t, failingStore);
  const entries = [];
  const { result, sent } = await mcpPaid(t, entries);
  assert.deepEqual(entries.map((e) => [e.kind, e.data.heldUsd ?? e.data.usd]), [[TOOL_STARTED, 0.05], [TOOL_COST, 0]]);
  assert.equal(capToolSpend(entries), 0);
  assert.equal(sent, 0);
  assert.match(result.content[0].text, /was not sent: its hold could not be made durable \(the disk went away\)/);
});

const answer = () => ({ role: "assistant", content: [{ type: "text", text: "hi" }], api: "faux", provider: "faux", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } }, stopReason: "stop", timestamp: Date.now() });
/** pi's models, each request recorded in `log` as "sent". */
const models = (log) => ({
  streamSimple: () => {
    log.push("sent");
    const stream = createAssistantMessageEventStream();
    const message = answer();
    queueMicrotask(() => (stream.push({ type: "done", reason: "stop", message }), stream.end(message)));
    return stream;
  },
  completeSimple: async () => (log.push("sent"), answer()),
});
const MODEL = { api: "faux", provider: "faux", id: "m" };

/** The marked models, the run's marks in `entries` and its sends in `log`, on `store`. */
async function marked(entries, log, store) {
  const { models: wrapped, open } = await markRequests(models(log));
  open({ harness: { commit: async (change) => change({ appendEntry: async (_conversation, entry) => void entries.push(entry) }) }, store });
  return wrapped;
}

for (const [what, send] of [["a pi model request", (m) => m.streamSimple(MODEL, { messages: [] }, {}).result()], ["a compaction request", (m) => m.completeSimple(MODEL, { messages: [] }, {})]]) {
  test(`modelRequestStarted, no run store at NORMAL: ${what} writes no start mark and is not sent, in words that say why`, async (t) => {
    atNormal(t, undefined);
    const [entries, log] = [[], []];
    const result = await send(await marked(entries, log, undefined));
    assert.equal(result.stopReason, "error");
    assert.ok(result.errorMessage.startsWith(`${MARK_NOT_WRITTEN} (${NO_STORE}`), result.errorMessage);
    assert.deepEqual([entries, log], [[], []], "nothing written, nothing sent");
  });

  test(`modelRequestStarted, a sync that fails after the start mark: ${what} is ended unsent in the store and not sent`, async (t) => {
    atNormal(t, failingStore);
    const [entries, log] = [[], []];
    const result = await send(await marked(entries, log, failingStore));
    assert.equal(result.stopReason, "error");
    assert.ok(result.errorMessage.startsWith(MARK_NOT_WRITTEN) && result.errorMessage.includes("the disk went away"), result.errorMessage);
    assert.deepEqual(entries.map((e) => [e.kind, e.data.unsent ?? null]), [[REQUEST_STARTED, null], [REQUEST_ENDED, true]]);
    assert.equal(entries[1].data.requestId, entries[0].data.requestId, "the end answers its own start");
    assert.deepEqual(log, [], "nothing sent");
  });
}

test("the journal's level is a test's own: app.ts never passes settleIn a third argument", async () => {
  const source = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  const calls = [...source.matchAll(/settleIn\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g)].map((match) => match[1]);
  assert.ok(calls.length >= 3, `app.ts's settleIn calls: ${calls.length}`);
  const topLevelCommas = (args) => [...args].reduce((state, c) => (c === "(" ? { ...state, depth: state.depth + 1 } : c === ")" ? { ...state, depth: state.depth - 1 } : c === "," && state.depth === 0 ? { ...state, commas: state.commas + 1 } : state), { depth: 0, commas: 0 }).commas;
  assert.deepEqual(calls.filter((args) => topLevelCommas(args) !== 1), [], "every call passes the record and the store, never a level");
});
