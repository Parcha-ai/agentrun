// A paid tool call booked on the runner's one ledger (paid-calls.ts Ledger.paid: the kernel cap's paidCalls on the run's
// TOOL_SESSION, which the adapter loop sets under each host tool call) books as main books it: held at its price before it
// is sent, settled at what it charged, and a later claim, which reads the run's records, still counts it. monid.run at
// what monid reported ($0.003 for the faux /person/enrich), a priced MCP call at its owner's price ($0.05).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { BROWSER_CHARGED, browserSpend } from "../dist/browser-cost.js";
import { mcpGateway } from "../dist/mcp-gateway.js";
import { FAUX_ENV } from "../dist/model.js";
import { FAUX_MONID_ENV, MONID_KEY_ENV, monidRegistration } from "../dist/monid.js";
import { bookedIn, paidRequest, parallelSearchFee } from "../dist/paid-calls.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";

const cap = await import("../../run-adapters/dist/kernel/cap/index.js");
const { sessionSpendOf } = await import("../../run-adapters/dist/runner.js");
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const TOKEN = "mcp-token";
const T0 = Date.parse("2026-11-09T04:00:00Z");

/** The run's one ledger over `store`, as a claim opens it: its paid calls under a $1 cap. */
const claimOn = async (store) => cap.runCap({ sessions: store, capUsd: () => 1, now: () => T0, modelOf: () => undefined }).tools(await store.open(cap.TOOL_SESSION));
const near = (actual, expected, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);

test("monid.run on the run's one ledger books what monid reported, and a later claim still counts it", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "ledger-monid-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const store = memorySessionStore();
  const paid = await claimOn(store);
  const tool = monidRegistration("run", { [FAUX_ENV]: "1", [FAUX_MONID_ENV]: FAUX_MONID, [MONID_KEY_ENV]: MONID_KEY }, () => work);
  const api = { callId: "c1", commit: async () => {} };
  const result = await bookedIn({ call: "c1", record: async () => {}, paid }, () => tool.execute({ provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } }, api, { abortSignal: new AbortController().signal }));
  near(paid.spentUsd(), 0.003, `this claim's ledger (the call answered ${JSON.stringify(result?.content?.[0]?.text ?? result).slice(0, 160)})`);
  near((await claimOn(store)).spentUsd(), 0.003, "the next claim");
});

test("browser time on the run's one ledger, as main bills it: each charge booked once, the release's included; a claim lost after call 2 counts calls 1 and 2 and gives call 3's hold and the reserve back; its reopen books the release once, as main's total", async () => {
  // Each charge through its own instant, as a session's charges are (its ref is its session and time).
  let tick = 0;
  const charge = (usd, seconds, final = false) => ({ state: "priced", usd, seconds, tag: "s1", conversationId: 1, provider: "browserbase", at: new Date(Date.now() + (tick += 1)).toISOString(), final });
  /** A run's browser on the ledger over `store`: Browserbase at $0.12 an hour, its 60 s minimum, a 180 s idle window. Its
   *  `tx`: a charge's commit, which lands at once and is published to the browser's watch, as the claim's Harness does
   *  (a charge is booked on the ledger once its commit is in); `root`, the entries the commits put on the root. */
  const browserOn = async (store, root = []) => {
    const spend = browserSpend("browserbase", { usdPerHour: 0.12, minimumS: 60 }, 180, async () => {}, () => {}, { paid: await claimOn(store) });
    let listener;
    spend.watch({ observeCommits: (given) => void (listener = given), closed: new Promise(() => {}) });
    return Object.assign(spend, { root, tx: { appendEntry: async (_conversation, value) => (root.push(value), listener.advance({ changes: [{ type: "entry", value }] })) } });
  };
  /** A browser call charged `usd` for its `seconds`, under call `callId`; `never`: it is still under way when the claim is lost. */
  const call = (spend, callId, usd, seconds, never = false) => spend.capped({ name: "browser_read", execute: async () => (never ? new Promise(() => {}) : (await spend.onCharge(charge(usd, seconds), spend.tx, { callId }), { content: [{ type: "text", text: "read" }] })) }).execute({}, { callId, conversationId: 1, commit: async () => {} }, {});
  /** A reopen of the run's browser on `spend`'s claim: its session still kept, its root's charges read back. */
  const reopen = (spend, root) => spend.reopened({
    snapshot: async (doc) => (doc === "inventory" ? { rows: { s1: { tag: "s1", conversationId: 1, state: "kept", resourceId: "bb-1" } } } : { sessions: [{ tag: "s1", spent: { chargedThrough: new Date().toISOString() } }] }),
    conversation: async () => ({ entries: async () => ({ items: root, next: undefined }) }),
  }, { Inventory: "inventory", Sessions: "sessions" }, {});

  // A three-call session and its release: main's total, each call at its charge and the release at its top-up to the minute.
  const whole = memorySessionStore();
  const spend = await browserOn(whole);
  await call(spend, "c1", 0.0003, 9);
  await call(spend, "c2", 0.0002, 6);
  await call(spend, "c3", 0.0001, 3);
  await spend.onCharge(charge(0.0014, 42, true), spend.tx);
  await spend.ledgerIdle?.();
  near((await claimOn(whole)).spentUsd(), 0.0003 + 0.0002 + 0.0001 + 0.0014, "the session's total, read by the next claim");

  // A claim lost after call 2, call 3 under way: the next claim counts calls 1 and 2 at their charges; call 3's hold and
  // the session's reserve are holds, given back (never booked as cut).
  const cut = memorySessionStore();
  const lost = await browserOn(cut);
  await call(lost, "c1", 0.0003, 9);
  await call(lost, "c2", 0.0002, 6);
  void call(lost, "c3", 0, 0, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const next = await browserOn(cut, lost.root);
  // Read off the records (a claim of its own would fence this one's ledger, as a newer claim does).
  const spentOn = async (store) => sessionSpendOf(await store.read(cap.TOOL_SESSION)).spentUsd;
  near(await spentOn(cut), 0.0003 + 0.0002, "the next claim: the charges, never the holds");
  // Its reopen holds the session again and books nothing twice; the release charge is booked once: main's $0.0019.
  await reopen(next, lost.root);
  await next.onCharge(charge(0.0014, 42, true), next.tx);
  await next.ledgerIdle?.();
  await reopen(next, next.root.length ? [...lost.root, ...next.root] : lost.root);
  await next.ledgerIdle?.();
  near(await spentOn(cut), 0.0003 + 0.0002 + 0.0014, "every charge once, the release's included; a second reopen books nothing more");
});

test("a charge whose commit lands and whose booking does not (its claim lost between the two) is booked by the next claim's reopen, once", async () => {
  const store = memorySessionStore();
  // The first claim's root holds a release charge its ledger never saw (the process was lost after the commit).
  const root = [{ kind: BROWSER_CHARGED, data: { tool: "browser", charged_by: "browserbase", call: "c1", usd: 0.0014, seconds: 42, tag: "s1", conversation: 1, at: new Date().toISOString(), final: true } }];
  // The claim's booking, every settle noted: a ref booked already opens no step, so none is settled for it.
  const tools = await claimOn(store);
  const settled = [];
  const paid = { admit: (request) => tools.admit(request), settle: (id, usd, options) => (settled.push(id), tools.settle(id, usd, options)) };
  const spend = browserSpend("browserbase", { usdPerHour: 0.12, minimumS: 60 }, 180, async () => {}, () => {}, { paid });
  const harness = { snapshot: async () => ({ rows: {} }), conversation: async () => ({ entries: async () => ({ items: root, next: undefined }) }) };
  await spend.reopened(harness, { Inventory: "inventory", Sessions: "sessions" }, {});
  await spend.reopened(harness, { Inventory: "inventory", Sessions: "sessions" }, {});
  await spend.ledgerIdle?.();
  assert.equal(settled.length, 1, `one step settled, none for the second reopen's admit: ${JSON.stringify(settled)}`);
  near((await claimOn(store)).spentUsd(), 0.0014, "booked once");
  const requests = (await store.read(cap.TOOL_SESSION)).filter((r) => r.kind === "runner.request").map((r) => r.data);
  assert.deepEqual(requests.map(({ call, tool, tag, owed }) => ({ call, tool, tag, owed })), [{ call: "c1", tool: "browser", tag: "s1", owed: true }], "one owed step, under its call, for the browser's session");
});

test("a charge whose commit fails books nothing on the ledger", async () => {
  const store = memorySessionStore();
  const spend = browserSpend("browserbase", { usdPerHour: 0.12, minimumS: 60 }, 180, async () => {}, () => {}, { paid: await claimOn(store) });
  let listener;
  spend.watch({ observeCommits: (given) => void (listener = given), closed: new Promise(() => {}) });
  const failing = { appendEntry: async () => { throw new Error("the commit failed"); } };
  await assert.rejects(spend.onCharge({ state: "priced", usd: 0.0014, seconds: 42, tag: "s1", conversationId: 1, provider: "browserbase", at: new Date().toISOString(), final: true }, failing), /the commit failed/);
  await spend.ledgerIdle?.();
  assert.ok(listener, "watched");
  near((await claimOn(store)).spentUsd(), 0, "nothing booked");
  assert.deepEqual((await store.read(cap.TOOL_SESSION)).filter((r) => r.kind === "runner.request"), [], "no step");
});

// The run view puts a paid request's charge under the tool call it ran in (main's "Tool cost: <server> charged $…" and
// "Not metered" rows), so its journaled request record names that call. A model request's record names none (its shape is
// held-bound-unanswered.test.mjs's first test).
test("a paid web search's request record on the run's one ledger names the tool call it was booked under", async () => {
  const store = memorySessionStore();
  const paid = await claimOn(store);
  const response = await bookedIn({ call: "call-7", record: async () => {}, paid }, () => paidRequest(parallelSearchFee(10), async () => new Response("{}", { status: 200 })));
  assert.equal(response.status, 200, "the search was sent");
  const requests = (await store.read(cap.TOOL_SESSION)).filter((r) => r.kind === "runner.request").map((r) => r.data);
  assert.equal(requests.length, 1, `one paid request: ${JSON.stringify(requests)}`);
  assert.equal(requests[0].call, "call-7", `its record names its call: ${JSON.stringify(requests[0])}`);
});

test("a priced MCP call on the run's one ledger books its owner's price, and a later claim still counts it", async (t) => {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const work = await mkdtemp(join(tmpdir(), "ledger-mcp-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const store = memorySessionStore();
  const paid = await claimOn(store);
  const gateway = mcpGateway({
    pin: { fake: { url: fake.url, tools: [{ name: "paid", inputSchema: { type: "object" } }], prices: { paid: 0.05 } } },
    credentials: { fake: { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } } },
    work: () => work,
    commit: () => async () => {},
  });
  const result = await bookedIn({ call: "c1", record: async () => {}, paid }, () => gateway.call("fake", "paid", { query: "ada" }, { signal: new AbortController().signal, callId: "c1" }));
  assert.equal(result.content?.[0]?.text, "paid for ada", "the call was answered");
  near(paid.spentUsd(), 0.05, "this claim's ledger");
  near((await claimOn(store)).spentUsd(), 0.05, "the next claim");
});
