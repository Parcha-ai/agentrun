// A paid call's hold, when it cannot be made durable on a run journal at synchronous NORMAL (pi-durable-disk barriers.ts,
// paidToolHold). With no run store to sync, nothing is written: the hold would sit at its figure with no sync behind it.
// A sync that fails after the write is answered in the store by its settle at $0, so the cap no longer counts it. Either
// way nothing is sent, and the words say what happened: never that the hold could not be written when it was.
// The journal's level is a test's own (settleIn's `journal`): the run journal is FULL until it moves to NORMAL.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TOOL_COST, TOOL_STARTED } from "@parcha/pi-durable-agent/timeline";
import { capToolSpend, paidHolds } from "../dist/cap.js";
import { mcpGateway } from "../dist/mcp-gateway.js";
import { FAUX_ENV } from "../dist/model.js";
import { FAUX_MONID_ENV, MONID_KEY_ENV, monidRegistration } from "../dist/monid.js";
import { bookedIn, paidRequest, settleIn } from "../dist/paid-calls.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { calls as monidCalls, KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const TOKEN = `not-a-secret-${"hold-bearer"}`;

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
