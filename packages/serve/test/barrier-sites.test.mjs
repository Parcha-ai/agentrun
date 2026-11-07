// The run journal's barriers on serve's own effect paths (pi-durable-disk barriers.ts): a model request's start mark
// (modelRequestStarted) and a paid tool call's hold (paidToolHold: paid calls, monid, the MCP gateway) are synced to disk
// after their own commit and before the request or the call is sent, so a box loss can never cause it to go twice or be
// under-counted. On a store at NORMAL the sync is one commit at FULL; here the store is a stand-in that records when it
// synced, beside the commit and the send. A sync that fails sends nothing.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { REQUEST_STARTED, TOOL_STARTED } from "@parcha/pi-durable-agent/timeline";
import { MARK_NOT_WRITTEN } from "../dist/cap.js";
import { mcpGateway } from "../dist/mcp-gateway.js";
import { FAUX_ENV } from "../dist/model.js";
import { FAUX_MONID_ENV, MONID_KEY_ENV, monidRegistration } from "../dist/monid.js";
import { bookedIn, paidRequest, settleIn } from "../dist/paid-calls.js";
import { markRequests } from "../dist/request-start.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { calls as monidCalls, KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const TOKEN = `not-a-secret-${"barrier-bearer"}`;

/** A run store at NORMAL as syncNow takes it, its sync recorded in `log` ("sync"), or failing as a lost disk would. */
const store = (log, { fails = false } = {}) => ({
  synchronous: "NORMAL",
  database: {
    exec: async () => undefined,
    async transaction(callback) {
      if (fails) throw new Error("the disk went away");
      await callback({ exec: async () => undefined, run: async () => undefined });
      log.push("sync");
    },
  },
});

/** A commit to the run's root, each entry recorded in `log` as "commit <kind>". */
const committing = (log) => async (change) => change({ appendEntry: async (_conversation, entry) => void log.push(`commit ${entry.kind}`) });

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

async function marked(log, fails) {
  const { models: wrapped, open } = await markRequests(models(log));
  open({ harness: { commit: committing(log) }, store: store(log, { fails }) });
  return wrapped;
}

const MODEL = { api: "faux", provider: "faux", id: "m" };

test("modelRequestStarted: a pi model request is sent only after its start mark is committed and synced", async () => {
  const log = [];
  const result = await (await marked(log, false)).streamSimple(MODEL, { messages: [] }, {}).result();
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(log.slice(0, 3), [`commit ${REQUEST_STARTED}`, "sync", "sent"]);
});

test("modelRequestStarted: a compaction request is sent only after its start mark is committed and synced", async () => {
  const log = [];
  const result = await (await marked(log, false)).completeSimple(MODEL, { messages: [] }, {});
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(log.slice(0, 3), [`commit ${REQUEST_STARTED}`, "sync", "sent"]);
});

test("modelRequestStarted: a sync that fails sends no model request, and the request fails as a mark that was not written", async () => {
  const log = [];
  const result = await (await marked(log, true)).streamSimple(MODEL, { messages: [] }, {}).result();
  assert.equal(result.stopReason, "error");
  assert.ok(result.errorMessage.startsWith(MARK_NOT_WRITTEN), result.errorMessage);
  assert.ok(!log.includes("sent"), `nothing sent: ${log.join(", ")}`);
});

test("modelRequestStarted: a sync that fails sends no compaction request", async () => {
  const log = [];
  const result = await (await marked(log, true)).completeSimple(MODEL, { messages: [] }, {});
  assert.equal(result.stopReason, "error");
  assert.ok(result.errorMessage.startsWith(MARK_NOT_WRITTEN), result.errorMessage);
  assert.ok(!log.includes("sent"), `nothing sent: ${log.join(", ")}`);
});

const FEE = { name: "parallel.search", tool: "web_search", by: "parallel", usd: 0.005, basis: "the price Parallel lists" };

/** A paid request under a call's ledger, its hold and settle recorded in `log`, its send as "sent". */
async function paid(t, log, fails) {
  settleIn(undefined, store(log, { fails }));
  t.after(() => settleIn(undefined, undefined));
  const ledger = { call: "c1", record: async (kind) => void log.push(`commit ${kind}`) };
  return bookedIn(ledger, () => paidRequest(FEE, async () => (log.push("sent"), new Response("{}", { status: 200 }))));
}

test("paidToolHold (paid calls): a paid request is sent only after its hold is committed and synced", async (t) => {
  const log = [];
  await paid(t, log, false);
  assert.deepEqual(log.slice(0, 3), [`commit ${TOOL_STARTED}`, "sync", "sent"]);
});

test("paidToolHold (paid calls): a sync that fails sends nothing", async (t) => {
  const log = [];
  await assert.rejects(paid(t, log, true), /was not sent/);
  assert.ok(!log.includes("sent"), `nothing sent: ${log.join(", ")}`);
});

/** monid.run under a call: its hold and settle recorded in `log`, and how many runs the fake monid had when it synced. */
async function monidRun(t, log, fails) {
  const work = await mkdtemp(join(tmpdir(), "barrier-monid-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const target = store(log, { fails });
  const runs = () => monidCalls.filter((call) => call.path === "/v1/run").length;
  const before = runs();
  const synced = [];
  const watched = { ...target, database: { ...target.database, transaction: async (callback) => (synced.push(runs() - before), target.database.transaction(callback)) } };
  settleIn(undefined, watched);
  t.after(() => settleIn(undefined, undefined));
  // The faux monid in place of monid itself (fauxFetch takes it only beside the faux model's setting): no network.
  const tool = monidRegistration("run", { [FAUX_ENV]: "1", [FAUX_MONID_ENV]: FAUX_MONID, [MONID_KEY_ENV]: MONID_KEY }, () => work);
  const api = { callId: "c1", commit: committing(log) };
  const result = await tool.execute({ provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } }, api, { abortSignal: new AbortController().signal });
  return { result, sent: runs() - before, synced };
}

test("paidToolHold (monid): monid.run is sent only after its hold is committed and synced", async (t) => {
  const log = [];
  const { sent, synced } = await monidRun(t, log, false);
  assert.deepEqual(log.slice(0, 2), [`commit ${TOOL_STARTED}`, "sync"]);
  assert.deepEqual([synced, sent], [[0], 1], "synced before monid was called, then called once");
});

test("paidToolHold (monid): a sync that fails sends nothing to monid", async (t) => {
  const log = [];
  const { result, sent } = await monidRun(t, log, true);
  assert.equal(sent, 0, "monid was never called");
  assert.match(JSON.stringify(result), /was not sent/);
});

/** The MCP gateway's paid tool, its hold and settle recorded in `log`, and how many calls the server had when it synced. */
async function mcpPaid(t, log, fails) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const work = await mkdtemp(join(tmpdir(), "barrier-mcp-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const calls = () => fake.log.filter((entry) => entry.method === "tools/call").length;
  const target = store(log, { fails });
  const synced = [];
  settleIn(undefined, { ...target, database: { ...target.database, transaction: async (callback) => (synced.push(calls()), target.database.transaction(callback)) } });
  t.after(() => settleIn(undefined, undefined));
  const gateway = mcpGateway({
    pin: { fake: { url: fake.url, tools: [{ name: "paid", inputSchema: { type: "object" } }], prices: { paid: 0.05 } } },
    credentials: { fake: { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } } },
    work: () => work,
    commit: () => committing(log),
  });
  const result = await gateway.call("fake", "paid", { query: "ada" }, { signal: new AbortController().signal, callId: "c1" });
  return { result, sent: calls(), synced };
}

test("paidToolHold (MCP gateway): a priced MCP call is sent only after its hold is committed and synced", async (t) => {
  const log = [];
  const { result, sent, synced } = await mcpPaid(t, log, false);
  assert.equal(result.content?.[0]?.text, "paid for ada");
  assert.deepEqual(log.slice(0, 2), [`commit ${TOOL_STARTED}`, "sync"]);
  assert.deepEqual([synced, sent], [[0], 1], "synced before the server was called, then called once");
});

test("paidToolHold (MCP gateway): a sync that fails sends nothing to the server", async (t) => {
  const log = [];
  const { result, sent } = await mcpPaid(t, log, true);
  assert.equal(sent, 0, "the server was never called");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /was not sent/);
});
