// A workflow call node's web_fetch whose Parallel read the run's cap refuses is held at the cap (app.ts CAP_HELD): the
// read is no page, so it never falls back to a direct fetch, and nothing is kept in the run's pages. Raised, the call runs
// again and reads through Parallel, as it would have. Outside a call node (no listener for the cap's refusals) a refused
// read still says why and reads the page directly, as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capRefusals } from "../dist/cap.js";
import { webFetch } from "../dist/web-fetch.js";
import { network } from "./fixtures/fake-network.mjs";

const URL_ = "http://public.example/";
const WORDS = "Not sent: this run has spent $0 of its $0.0005 cap, and the next step, Parallel's extract, could cost up to $0.001. Raise the cap to at least $0.001 to continue.";

/** Parallel, as the run's extract: refused by the cap until `raised`, then reading the page. */
function parallelOf(state) {
  return {
    live: () => true,
    post: async () => { throw new Error("not used"); },
    async read(url) {
      state.reads += 1;
      if (!state.raised) {
        // As paidRequest does on a refusal for room: the call is told, and the read says why it read nothing.
        capRefusals.getStore()?.({ words: WORDS, room: true, capUsd: 0.0005 });
        return `was not sent: spend_cap_reached: ${WORDS}`;
      }
      return { ok: true, url, status: 200, title: "From Parallel", text: "Parallel's read of the page.", links: [] };
    },
  };
}

test("a call node's Parallel read the cap refuses is no page: no direct fetch, nothing kept in the run's pages; raised, the call reads through Parallel", async () => {
  const net = network();
  const pages = new Map();
  const state = { reads: 0, raised: false };
  const parallel = parallelOf(state);
  const told = [];
  const held = await capRefusals.run((refusal) => void told.push(refusal), () => webFetch(URL_, { parallel, pages, lookup: net.lookup, fetchImpl: net.fetchImpl }));
  assert.deepEqual([told.length, held.ok, net.dialled, pages.size], [1, false, [], 0]);
  state.raised = true;
  const again = await capRefusals.run(() => undefined, () => webFetch(URL_, { parallel, pages, lookup: net.lookup, fetchImpl: net.fetchImpl }));
  assert.deepEqual([state.reads, again.ok, again.via, again.title, net.dialled], [2, true, "parallel", "From Parallel", []]);
});

test("outside a call node a read the cap refuses still reads the page directly, saying why Parallel gave none (a pin)", async () => {
  const net = network();
  const read = await webFetch(URL_, { parallel: parallelOf({ reads: 0, raised: false }), pages: new Map(), lookup: net.lookup, fetchImpl: net.fetchImpl });
  assert.deepEqual([read.ok, read.via, net.dialled], [true, "direct", [URL_]]);
  assert.match(read.parallel, /spend_cap_reached/);
});

test("two call nodes reading the same URL at once share the read, and the cap's refusal of it holds both: neither gets an unread page as its answer; raised, both read through Parallel", async () => {
  const net = network();
  const pages = new Map();
  const state = { reads: 0, raised: false };
  const parallel = parallelOf(state);
  const toldA = [];
  const toldB = [];
  const both = () => Promise.all([
    capRefusals.run((refusal) => void toldA.push(refusal), () => webFetch(URL_, { parallel, pages, lookup: net.lookup, fetchImpl: net.fetchImpl })),
    capRefusals.run((refusal) => void toldB.push(refusal), () => webFetch(URL_, { parallel, pages, lookup: net.lookup, fetchImpl: net.fetchImpl })),
  ]);
  const [a, b] = await both();
  assert.deepEqual({ reads: state.reads, toldA: toldA.length, toldB: toldB.length, okA: a.ok, okB: b.ok, dialled: net.dialled, kept: pages.size }, { reads: 1, toldA: 1, toldB: 1, okA: false, okB: false, dialled: [], kept: 0 }, "one shared read, refused: each call is told, so each is held");
  state.raised = true;
  const [againA, againB] = await both();
  assert.deepEqual([state.reads, againA.ok, againA.via, againB.ok, againB.via, net.dialled, toldA.length, toldB.length], [2, true, "parallel", true, "parallel", [], 1, 1]);
});
