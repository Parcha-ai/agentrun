// Why a provider ahead gave no page is said on a page the guarded direct fetch answered (or on the answer that no
// provider read it), never on a page a provider behind it read: the line after the page's JSON says the page was
// fetched directly, which only such a page was.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { EXA_CANARY, exaPage, keyedServer } from "./fixtures/fake-keyed.mjs";
import { CANARY } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";

const PUBLIC = "http://public.example/";
const guardOf = (net) => ({ fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage });

test("[parallel, exa, direct]: Parallel fails and Exa reads the page; the page carries no reason of Parallel's and no line says it was fetched directly", async (t) => {
  const exa = await keyedServer(t, (_path, body) => exaPage(body.urls[0], "The answer is forty-two."));
  const send = async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  const w = web.createWeb({ order: { search: [], fetch: ["parallel", "exa", "direct"] }, keys: { parallel: CANARY, exa: EXA_CANARY }, endpoints: { exa: exa.url }, send: { parallel: send }, guard: guardOf(network()) });
  const page = await w.fetch(PUBLIC);
  assert.deepEqual([page.answer.ok, page.answer.via, page.answer.parallel], [true, "exa", undefined]);
  assert.deepEqual(page.receipt.tries.map((one) => [one.provider, one.outcome]), [["parallel", "error"], ["exa", "ok"]], "Parallel's turn stays on the receipt");
  assert.doesNotMatch(web.webFetchText(page.answer), /fetched directly/);
});

test("[parallel, direct]: Parallel fails and the direct fetch reads the page; the page says why, as before", async () => {
  const send = async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  const w = web.createWeb({ order: { search: [], fetch: ["parallel", "direct"] }, keys: { parallel: CANARY }, send: { parallel: send }, guard: guardOf(network()) });
  const page = await w.fetch(PUBLIC);
  assert.deepEqual([page.answer.via, page.answer.parallel], ["direct", "answered 500"]);
  assert.match(web.webFetchText(page.answer), /\nParallel gave no page \(answered 500\); this one was fetched directly\.$/);
});
