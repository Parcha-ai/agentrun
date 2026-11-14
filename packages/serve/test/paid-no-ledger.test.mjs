// One ledger only: a paid call books on the run's one ledger (the kernel cap's RunTools, paid-calls.ts Ledger.paid) or
// is never sent. A monid endpoint's call, a search through Parallel and a browser call with no run's ledger to book them on are
// refused unsent, in words that say so, as a priced MCP call already is (mcp-gateway.ts): nothing reaches the provider,
// and no other booking stands in for the ledger.
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserSpend } from "../dist/browser-cost.js";
import { FAUX_ENV } from "../dist/model.js";
import { FAUX_MONID_ENV, MONID_KEY_ENV } from "../dist/monid.js";
import { bookedIn } from "../dist/paid-calls.js";
import { monidForClaim } from "../dist/runner/monid-run.js";
import { parallelExtract } from "../dist/web-fetch.js";
import { webSearch } from "../dist/web-search.js";
import fakeParallel, { CANARY } from "./fixtures/faux-parallel.mjs";
import { calls as monidCalls, KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const UNBOOKED = /was not sent: this call has no run to book its price under/;

test("a monid endpoint's call with no run's ledger is refused unsent: outside any call, and inside a call whose ledger has no RunTools", async () => {
  const pin = { "monid:faux/person/enrich": { description: "faux /person/enrich", input: { type: "object", properties: {} }, usd: 0.003 } };
  const { tools: [tool] } = monidForClaim(pin, { [FAUX_ENV]: "1", [FAUX_MONID_ENV]: FAUX_MONID, [MONID_KEY_ENV]: MONID_KEY }, () => assert.fail("no answer is filed"));
  const before = monidCalls.length;
  const args = { body: { name: "Ada" } };
  const context = { callId: "c1", signal: new AbortController().signal };
  for (const result of [await tool.call(args, context), await bookedIn({ call: "c1" }, () => tool.call(args, context))]) {
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(JSON.parse(result.text).error, UNBOOKED);
  }
  assert.equal(monidCalls.length, before, "nothing reached monid");
});

test("a search through Parallel inside a call whose ledger has no RunTools is refused unsent, in words that say so", async () => {
  const sent = [];
  const client = parallelExtract(CANARY, async (url, init) => (sent.push(String(url)), fakeParallel(url, init)));
  const answer = await bookedIn({ call: "c1" }, () => webSearch({ query: "widgets" }, client));
  assert.match(answer.error, UNBOOKED);
  assert.deepEqual(sent, [], "nothing reached Parallel");
});

test("a browser call and a person's time with no run's ledger are refused unsent: the tool never runs and the conversation's session is let go", async () => {
  const releases = [];
  const spend = browserSpend("browserbase", { usdPerHour: 0.12, minimumS: 60 }, 180, async (conversation) => void releases.push(conversation.id), () => {});
  let ran = false;
  const tool = spend.capped({ name: "browser_read", execute: async () => ((ran = true), { content: [{ type: "text", text: "read" }] }) });
  const result = await tool.execute({}, { callId: "c1", conversationId: 7, commit: async () => {} }, {});
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.output[0].text).error, UNBOOKED);
  assert.equal(ran, false, "the browser call was not sent");
  assert.deepEqual(releases, [7], "its conversation's session let go");
  const person = await spend.personTime("a person's take-over", 900, { pauses: false });
  assert.match(person.refused, UNBOOKED);
});
