// A web_fetch whose Parallel read the run's cap refuses is no page from Parallel: the read says why it read nothing, and the
// page is fetched directly, saying why Parallel gave none (`parallel`), never a silent fallback.
import assert from "node:assert/strict";
import { test } from "node:test";
import { webFetch } from "../dist/web-fetch.js";
import { network } from "./fixtures/fake-network.mjs";

const URL_ = "http://public.example/";
const WORDS = "Not sent: this run has spent $0 of its $0.0005 cap, and the next step, Parallel's extract, could cost up to $0.001. Raise the cap to at least $0.001 to continue.";

/** Parallel, as the run's extract, refused by the cap: the read says why it read nothing. */
const refused = {
  live: () => true,
  post: async () => { throw new Error("not used"); },
  read: async () => `was not sent: spend_cap_reached: ${WORDS}`,
};

test("a read the cap refuses still reads the page directly, saying why Parallel gave none (a pin)", async () => {
  const net = network();
  const read = await webFetch(URL_, { parallel: refused, pages: new Map(), lookup: net.lookup, fetchImpl: net.fetchImpl });
  assert.deepEqual([read.ok, read.via, net.dialled], [true, "direct", [URL_]]);
  assert.match(read.parallel, /spend_cap_reached/);
});
