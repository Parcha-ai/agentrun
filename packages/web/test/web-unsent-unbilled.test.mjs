// A paid request that never left this process is never billed. Keyed Exa's and Firecrawl's search and fetch, and
// Parallel's search and extract, each paid through a Pay that books as serve's paidRequest does (a 4xx settles at $0, a
// throw settles at the fee): a send that failed before the request left (the name not found, the connection refused)
// settles at $0 and its receipt line says it was not sent, the call's words unchanged; a send that failed after it may
// have left (a reset socket) settles at the fee, as before. A call already stopped asks no paid request at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { keyedClient } from "../dist/providers/keyed.js";
import { searchBreaker, searchInTurn } from "../dist/search.js";
import { network } from "./fixtures/fake-network.mjs";

const PUBLIC = "http://public.example/";
const KEY = "unsent-key-canary-5c2e";
const START = Date.parse("2026-11-24T12:00:00Z");

/** undici's failure of a fetch whose cause has `code`, as Node's fetch rejects it. */
const fetchFailed = (code, said = `connect ${code}`) => new TypeError("fetch failed", { cause: Object.assign(new Error(said), { code }) });
const DNS = () => fetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND api.example");
const RESET = () => fetchFailed("ECONNRESET", "read ECONNRESET");

/** A Pay that books as serve's paidRequest does: admitted, sent, then settled at the fee on a 2xx, a 408, a 5xx or a
 *  throw, and at $0 on any other 4xx. `settles` holds each settle; `admitted` counts the requests it was asked to pay. */
function capLike() {
  const settles = [];
  let admitted = 0;
  const billed = (status) => (status >= 200 && status < 300) || status === 408 || status >= 500;
  const pay = async (fee, send) => {
    admitted += 1;
    let response;
    try {
      response = await send();
    } catch (error) {
      settles.push([fee.name, fee.usd]);
      throw error;
    }
    settles.push([fee.name, billed(response.status) ? fee.usd : 0]);
    return response;
  };
  return { pay, settles, admitted: () => admitted };
}

/** A Web with `provider` on the run's key for both tools, its every request failing as `fails` says, paid through `cap`. */
function failingWeb(provider, fails, cap) {
  const net = network();
  const guard = { fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage };
  const send = async () => {
    throw fails();
  };
  return web.createWeb({ order: { search: [provider], fetch: [provider] }, keys: { [provider]: KEY }, send: { [provider]: send }, guard, pay: cap.pay, now: () => START });
}

const PROVIDERS = [
  ["exa", { search: "Exa's search", fetch: "Exa's contents" }],
  ["firecrawl", { search: "Firecrawl's search", fetch: "Firecrawl's scrape" }],
  ["parallel", { search: "Parallel's search", fetch: "Parallel's extract" }],
];
const call = (w, op, options = {}) => (op === "search" ? w.search("widgets", options) : w.fetch(PUBLIC, options));

for (const [provider, names] of PROVIDERS) {
  for (const op of ["search", "fetch"]) {
    test(`${provider}'s ${op}: a send that failed before it left (ENOTFOUND) settles at $0 and its receipt line says not sent; a reset socket settles at the fee; the words are the same`, async () => {
      const dns = capLike();
      const unsent = await call(failingWeb(provider, DNS, dns), op);
      const reset = capLike();
      const sent = await call(failingWeb(provider, RESET, reset), op);
      const fee = reset.settles[0]?.[1];
      assert.ok(fee > 0, `the reset request has a fee: ${JSON.stringify(reset.settles)}`);
      // The pin: a request that may have left is billed as it was.
      assert.deepEqual(reset.settles, [[names[op], fee]], "a reset socket settles at the fee");
      assert.deepEqual(sent.receipt.cost.lines.map(({ name, usd }) => [name, usd]), [[names[op], fee]]);
      assert.equal(sent.receipt.cost.usd, fee);
      // The fix: one that never left is not.
      assert.deepEqual(dns.settles, [[names[op], 0]], "a request that never left settles at $0");
      assert.deepEqual(unsent.receipt.cost.lines.map(({ name, usd, basis }) => [name, usd, basis]), [[names[op], 0, "not billed (not sent: ENOTFOUND)"]], "its receipt line is $0, saying it was not sent");
      assert.equal(unsent.receipt.cost.usd, 0);
      // What the call answers and how its turn is typed are as for any request that failed to connect.
      assert.deepEqual(unsent.answer, sent.answer, "the call's words are unchanged");
      assert.deepEqual(unsent.receipt.tries.map(({ ms: _ms, ...turn }) => turn), sent.receipt.tries.map(({ ms: _ms, ...turn }) => turn), "its turn is typed as before");
    });

    test(`${provider}'s ${op} on a call already stopped: no paid request is asked or held`, async () => {
      const cap = capLike();
      let sent = 0;
      const w = failingWeb(provider, () => (sent++, DNS()), cap);
      await call(w, op, { signal: AbortSignal.abort() });
      assert.equal(cap.admitted(), 0, "pay is never called");
      assert.equal(sent, 0, "nothing is sent");
    });
  }
}

test("a keyed client's post on a signal already stopped throws the stop's own reason, and asks no pay", async () => {
  const cap = capLike();
  const client = keyedClient({ who: "Exa", base: "https://api.example", headers: {}, feeOf: () => ({ name: "Exa's search", by: "exa", usd: 0.007, basis: "a price" }), timeoutMs: 1_000, refuseOn: [] }, async () => assert.fail("not sent"), cap.pay);
  const stop = new AbortController();
  const reason = new Error("the run was stopped");
  stop.abort(reason);
  await assert.rejects(client.post("/search", {}, stop.signal), (thrown) => thrown === reason);
  assert.equal(cap.admitted(), 0);
});

test("Parallel's post on a signal already stopped throws the stop's own reason, and asks no pay", async () => {
  const cap = capLike();
  const parallel = web.parallelExtract(KEY, async () => assert.fail("not sent"), cap.pay);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(parallel.post("https://api.parallel.ai/v1/search", { mode: "fast", search_queries: ["q"] }, stop.signal), (thrown) => thrown === stop.signal.reason);
  assert.equal(cap.admitted(), 0);
});

test("a keyed client's post: an unsent failure is rethrown as it was thrown, marked unsent; a billed one is not marked", async () => {
  for (const [fails, unsent] of [[DNS, true], [RESET, false]]) {
    const cap = capLike();
    const thrown = fails();
    const client = keyedClient({ who: "Exa", base: "https://api.example", headers: {}, feeOf: () => ({ name: "Exa's search", by: "exa", usd: 0.007, basis: "a price" }), timeoutMs: 1_000, refuseOn: [] }, async () => { throw thrown; }, cap.pay);
    await assert.rejects(client.post("/search", {}), (error) => error === thrown && error.unsent === (unsent || undefined));
    assert.deepEqual(cap.settles, [["Exa's search", unsent ? 0 : 0.007]]);
  }
});

test("searchInTurn on a signal already stopped starts no backend, and answers a stopped turn", async () => {
  const asked = [];
  const backend = (name) => ({ name, ask: async () => (asked.push(name), { answer: { error: `${name} answered` } }) });
  const made = new Map();
  const breakerOf = (name) => made.get(name) ?? made.set(name, searchBreaker(() => START)).get(name);
  const tries = [];
  const answer = await searchInTurn([backend("exa"), backend("firecrawl")], breakerOf, AbortSignal.abort(), 60_000, tries);
  assert.deepEqual(asked, [], "no backend is started");
  assert.deepEqual(answer, { error: "the search was stopped" });
  assert.deepEqual(tries.map(({ provider, outcome, failure }) => [provider, outcome, failure?.class, failure?.code]), [["exa", "error", "infra", "STOPPED"]]);
});

test("unsentWhy: a connect-phase fetch failure or a stop before the send is unsent; anything that may have left is not", async () => {
  const { unsentWhy } = await import("../dist/providers/keyed.js");
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_HANDSHAKE_TIMEOUT"]) {
    assert.equal(unsentWhy(fetchFailed(code), false), code, code);
  }
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT", "EPIPE", "ERR_TLS_RENEGOTIATION_DISABLED", "ERR_TLS_SESSION_ATTACK", "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC", undefined]) {
    assert.equal(unsentWhy(fetchFailed(code), false), undefined, String(code));
  }
  // The code alone is not enough: only undici's "fetch failed" says the cause is the connection's.
  assert.equal(unsentWhy(Object.assign(new TypeError("unexpected redirect"), { cause: { code: "ENOTFOUND" } }), false), undefined);
  assert.equal(unsentWhy(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }), false), undefined);
  assert.equal(unsentWhy(new DOMException("This operation was aborted", "AbortError"), false), undefined, "a stop after the send started");
  assert.equal(unsentWhy(new DOMException("The operation was aborted due to timeout", "TimeoutError"), false), undefined, "a timeout");
  assert.equal(unsentWhy(new DOMException("This operation was aborted", "AbortError"), true), "stopped", "a stop before the send started");
  assert.equal(unsentWhy("a thrown string", false), undefined);
});

/** A keyed client on `send`, paid through `pay`. */
const exaOn = (send, pay) => keyedClient({ who: "Exa", base: "https://api.example", headers: {}, feeOf: () => ({ name: "Exa's search", by: "exa", usd: 0.007, basis: "a price" }), timeoutMs: 60_000, refuseOn: [] }, send, pay);

test("a stop that lands while the cap admits the request (before its send) settles at $0; one after the send started settles at the fee", async () => {
  const early = capLike();
  const stopEarly = new AbortController();
  const admitting = (fee, send) => (stopEarly.abort(), early.pay(fee, send));
  const client = exaOn((_url, init) => Promise.reject(init.signal.reason), admitting);
  await assert.rejects(client.post("/search", {}, stopEarly.signal), (error) => error === stopEarly.signal.reason && error.unsent === true);
  assert.deepEqual(early.settles, [["Exa's search", 0]]);

  const late = capLike();
  const stopLate = new AbortController();
  const sending = exaOn((_url, init) => (stopLate.abort(), Promise.reject(init.signal.reason)), late.pay);
  await assert.rejects(sending.post("/search", {}, stopLate.signal), (error) => error === stopLate.signal.reason && error.unsent === undefined);
  assert.deepEqual(late.settles, [["Exa's search", 0.007]], "a stop after the send started may have been billed");
});

test("an unsent request whose settle failed: its receipt line keeps the hold, as the cap keeps it, and says why", async () => {
  const net = network();
  const guard = { fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage };
  const pay = async (_fee, send, _charged, settled) => {
    const response = await send();
    settled?.(false);
    return response;
  };
  const w = web.createWeb({ order: { search: ["exa"], fetch: ["exa"] }, keys: { exa: KEY }, send: { exa: async () => { throw DNS(); } }, guard, pay, now: () => START });
  const { receipt } = await w.search("widgets");
  assert.deepEqual(receipt.cost.lines.map(({ usd, basis }) => [usd, basis]), [[0.007, "Exa's list price for a auto search of 10 results; its settle failed, so the hold stands, not $0 (not sent: ENOTFOUND)"]]);
});
