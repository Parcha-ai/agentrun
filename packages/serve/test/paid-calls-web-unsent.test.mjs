// A web tool's paid request that never left this process, booked through the real paidRequest on the run's one ledger
// (the kernel cap's paid tool calls, as the adapter loop sets it under a host tool call): keyed Exa's search whose name
// did not resolve books $0; one whose socket was reset after it was sent books Exa's fee, as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { createWeb } from "@parcha/agentrun-web";
import { bookedIn, paidRequest } from "../dist/paid-calls.js";

const cap = await import("../../run-adapters/dist/kernel/cap/index.js");
const T0 = Date.parse("2026-11-09T04:00:00Z");
/** Exa's list price for the auto search of 10 results web_search asks by default. */
const EXA_AUTO_USD = 0.007;

/** The run's one ledger over `store`, as a claim opens it: its paid calls under a $1 cap. */
const claimOn = async (store) => cap.runCap({ sessions: store, capUsd: () => 1, now: () => T0, modelOf: () => undefined }).tools(await store.open(cap.TOOL_SESSION));
const near = (actual, expected, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);
const fetchFailed = (code) => new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });

/** One web_search through keyed Exa whose every request fails with `code`, booked under call "c1" on a fresh ledger. */
async function searchFailing(code) {
  const store = memorySessionStore();
  const paid = await claimOn(store);
  const w = createWeb({ order: { search: ["exa"], fetch: ["exa"] }, keys: { exa: "exa-key-canary-ledger" }, send: { exa: async () => { throw fetchFailed(code); } }, pay: paidRequest });
  const found = await bookedIn({ call: "c1", paid }, () => w.search("widgets"));
  const requests = (await store.read(cap.TOOL_SESSION)).filter((r) => r.kind === "runner.request").map((r) => r.data);
  return { found, paid, store, requests };
}

test("keyed Exa's search that failed resolving its host (ENOTFOUND) books $0 on the run's ledger; a reset socket (ECONNRESET) books its fee", async () => {
  const dns = await searchFailing("ENOTFOUND");
  assert.equal(dns.requests.length, 1, `one paid request held: ${JSON.stringify(dns.requests)}`);
  near(dns.paid.spentUsd(), 0, "this claim's ledger, a request that never left");
  near((await claimOn(dns.store)).spentUsd(), 0, "the next claim");
  assert.deepEqual(dns.found.receipt.cost.lines.map(({ usd, basis }) => [usd, basis]), [[0, "not billed (not sent: ENOTFOUND)"]]);

  const reset = await searchFailing("ECONNRESET");
  near(reset.paid.spentUsd(), EXA_AUTO_USD, "this claim's ledger, a request that may have been billed");
  near((await claimOn(reset.store)).spentUsd(), EXA_AUTO_USD, "the next claim");
  assert.deepEqual(reset.found.receipt.cost.lines.map(({ usd }) => usd), [EXA_AUTO_USD]);
  assert.deepEqual(dns.found.answer, reset.found.answer, "the call's words are the same");
});
