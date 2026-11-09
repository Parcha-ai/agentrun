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
import { browserSpend } from "../dist/browser-cost.js";
import { mcpGateway } from "../dist/mcp-gateway.js";
import { FAUX_ENV } from "../dist/model.js";
import { FAUX_MONID_ENV, MONID_KEY_ENV, monidRegistration } from "../dist/monid.js";
import { bookedIn } from "../dist/paid-calls.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";

const cap = await import("../../run-adapters/dist/kernel/cap/index.js");
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

test("browser time on the run's one ledger, as main bills it: each call one paid request held at its expected charge and settled at its charge, the release one more settled at its top-up; a claim lost after call 2 still counts calls 1 and 2 and holds call 3", async () => {
  const tx = { appendEntry: async () => {} };
  const charge = (usd, seconds, final = false) => ({ state: "priced", usd, seconds, tag: "s1", conversationId: 1, provider: "browserbase", at: new Date(T0).toISOString(), final });
  /** A run's browser on the ledger over `store`: Browserbase at $0.12 an hour, its 60 s minimum, a 180 s idle window. */
  const browserOn = async (store) => browserSpend("browserbase", { usdPerHour: 0.12, minimumS: 60 }, 180, async () => {}, () => {}, { paid: await claimOn(store) });
  /** A browser call charged `usd` for its `seconds`, under call `callId`; `never`: it is still under way when the claim is lost. */
  const call = (spend, callId, usd, seconds, never = false) => spend.capped({ name: "browser_read", execute: async () => (never ? new Promise(() => {}) : (await spend.onCharge(charge(usd, seconds), tx, { callId }), { content: [{ type: "text", text: "read" }] })) }).execute({}, { callId, conversationId: 1, commit: async () => {} }, {});

  // A three-call session and its release: main's total, each call at its charge and the release at its top-up to the minute.
  const whole = memorySessionStore();
  const spend = await browserOn(whole);
  await call(spend, "c1", 0.0003, 9);
  await call(spend, "c2", 0.0002, 6);
  await call(spend, "c3", 0.0001, 3);
  await spend.onCharge(charge(0.0014, 42, true), tx);
  await spend.ledgerIdle?.();
  near((await claimOn(whole)).spentUsd(), 0.0003 + 0.0002 + 0.0001 + 0.0014, "the session's total, read by the next claim");

  // A claim lost after call 2, call 3 under way: calls 1 and 2 at their charges, call 3 at its hold. A call's hold is the
  // time its session ran since its last charge (none here) and twice the next stretch, at the list price, to the
  // millionth of a dollar up (browser-cost.ts capped).
  const cut = memorySessionStore();
  const lost = await browserOn(cut);
  await call(lost, "c1", 0.0003, 9);
  await call(lost, "c2", 0.0002, 6);
  void call(lost, "c3", 0, 0, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const hold = Math.ceil(Math.round(2 * lost.stretch * 1e12) / 1e6) / 1e6;
  near((await claimOn(cut)).spentUsd(), 0.0003 + 0.0002 + hold, "the next claim");
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
