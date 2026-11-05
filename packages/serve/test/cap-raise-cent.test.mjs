// A refusal names the cap that would run what it refused: the cent above the total, rounded within the very tail the
// cap's fit check allows (FIT_TOLERANCE), no wider. A total a hair (5e-12) past a whole cent is past it, so the named
// raise is the next cent; rounded within a wider slack it was that cent itself, which the same request is refused at
// again. The raise each path names, on the model path (capBefore) and on a paid call's (paidCall), passes that path's
// own fit check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capBefore, paidCall, raiseTo, useSpend } from "../dist/cap.js";

// Output at $100 a million: 3,072 tokens, a request's least, are $0.3072.
const model = { id: "gpt-6-luna", name: "gpt-6-luna", api: "openai-responses", provider: "p", maxTokens: 64000, contextWindow: 400000, cost: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 } };
const named = (refusal) => Number(/Raise the cap to at least \$(\d+\.\d\d) to run it\.$/.exec(refusal ?? "")?.[1]);

test("a total a hair past a whole cent names the cent above it: raiseTo(0.30, 0.31 + 5e-12) is $0.32", () => {
  assert.equal(raiseTo(0.3, 0.31 + 5e-12), "$0.32");
  // A float's own tail past a cent is that cent: 0.0028 + 0.3072 is 0.31000000000000005.
  assert.equal(raiseTo(0.3, 0.0028 + 3072 * (100 / 1e6)), "$0.31");
});

test("the raise a model request's refusal names admits that request", async () => {
  const spentUsd = 0.0028 + 5e-12;
  const request = { spentUsd, inFlight: [], inputTokensMax: 0, outputTokensLeast: 3072 };
  const refused = (await capBefore(0.3, model)).beforeRequest(request)?.refuse;
  const cap = named(refused);
  assert.equal(cap, 0.32, refused);
  assert.equal((await capBefore(cap, model)).beforeRequest(request)?.refuse, undefined, `under the named $${cap}`);
});

test("the raise a paid call's refusal names admits that call", async (t) => {
  t.after(() => useSpend(undefined));
  const spent = 0.21 + 5e-12;
  const hold = { usd: 0.1, basis: "the price quoted" };
  useSpend({ cap: 0.3, spent: () => spent, add: () => {} });
  const refused = (await paidCall("monid_run", async () => 0, (charged) => charged, hold)).refused;
  const cap = named(refused);
  assert.equal(cap, 0.32, refused);
  useSpend({ cap, spent: () => spent, add: () => {} });
  assert.equal((await paidCall("monid_run", async () => 0, (charged) => charged, hold)).refused, undefined, `under the named $${cap}`);
});
