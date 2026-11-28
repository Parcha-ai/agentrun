// A decision request that never left is never billed. A stop can land while a decision request's hold is still being
// admitted (a run's cap admits one paid request at a time); the provider then sends nothing (Jev's runner throws
// `aborted` before its first attempt when its signal is already stopped). The request is settled at $0 and its receipt
// line says so, as a keyed provider's unsent request is. A step on a call already stopped asks no hold at all. The
// provider here is a fake with that same pre-send check; the Pay books as serve's paidRequest does (a 4xx settles at
// $0, a throw settles at the fee).
import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionPay, deciderFrom } from "../dist/index.js";

const PRICE = { requestUsd: 0.0002 };
const TASK = "Where is Widgets, Inc. registered?";
const HITS = ["https://a.example/", "https://b.example/"].map((url) => ({ url, title: "", snippet: "" }));

/** A provider that sends nothing on a signal already stopped (it throws `aborted`, as Jev's runner does before its first
 *  attempt), and otherwise counts the request as sent and answers every question. */
function stopAwareProvider() {
  let sent = 0;
  return {
    sent: () => sent,
    provider: {
      id: "jev",
      needs: [],
      async decide(request, ctx) {
        if (ctx.signal.aborted) throw Object.assign(new Error("Jev request was cancelled."), { code: "aborted" });
        sent += 1;
        const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, q.type === "choice" ? { type: "choice", probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 1 : 0])) } : { type: "noul", noul: 0.5 }]));
        return { answers, evidence: [], model: "jev-1", usage: null, cost_usd: null, cost_basis: "unknown", provider_request_id: null };
      },
    },
  };
}

/** A Pay booked as serve's paidRequest books: `beforeSend` runs while the hold is admitted, then the request is sent
 *  and settled at the fee on a 2xx or a throw, at $0 on a 4xx. `settles` holds each settle, `admitted` the holds asked. */
function capLike(beforeSend = () => {}) {
  const settles = [];
  let admitted = 0;
  const pay = async (fee, send, _charged, settled) => {
    admitted += 1;
    await beforeSend();
    let response;
    try {
      response = await send();
    } catch (error) {
      settles.push(fee.usd);
      settled?.(true);
      throw error;
    }
    settles.push(response.status >= 400 && response.status < 500 ? 0 : fee.usd);
    settled?.(true);
    return response;
  };
  return { pay, settles, admitted: () => admitted };
}

const STEPS = [
  ["sift", (decider, ctx) => decider.sift("widgets delaware", HITS, TASK, ctx)],
  ["page guard", (decider, ctx) => decider.guard("https://a.example/", 200, "a page about widgets", ctx)],
];

for (const [step, run] of STEPS) {
  test(`a ${step} request stopped while its hold was admitted is never sent and settles at $0, its line saying so`, async () => {
    const stop = new AbortController();
    const cap = capLike(() => stop.abort(new Error("the run was stopped")));
    const { sent, provider } = stopAwareProvider();
    const lines = [];
    await assert.rejects(run(deciderFrom(provider, { price: PRICE }), { signal: stop.signal, deadlineMs: 30_000, pay: decisionPay(cap.pay, lines) }));
    assert.equal(sent(), 0, "the provider sent nothing");
    assert.equal(cap.admitted(), 1, "its hold had been asked before the stop");
    assert.deepEqual(cap.settles, [0], "a request that never left settles at $0, not at its hold");
    assert.equal(lines.length, 1, `one line: ${JSON.stringify(lines)}`);
    assert.equal(lines[0].usd, 0, "the receipt line is $0");
    assert.match(lines[0].basis, /^not billed \(/, "and says it was not billed");
  });

  test(`a ${step} on a call already stopped asks no hold and sends nothing`, async () => {
    const cap = capLike();
    const { sent, provider } = stopAwareProvider();
    const lines = [];
    await assert.rejects(run(deciderFrom(provider, { price: PRICE }), { signal: AbortSignal.abort(), deadlineMs: 30_000, pay: decisionPay(cap.pay, lines) }));
    assert.equal(cap.admitted(), 0, "no hold was asked");
    assert.equal(sent(), 0, "nothing was sent");
    assert.deepEqual(lines, [], "nothing is on the receipt");
  });
}

test("a request answered before the stop is still charged as it was: the stop changes only requests not yet sent", async () => {
  const stop = new AbortController();
  const cap = capLike();
  const { sent, provider } = stopAwareProvider();
  const lines = [];
  const got = await deciderFrom(provider, { price: PRICE }).sift("widgets delaware", HITS, TASK, { signal: stop.signal, deadlineMs: 30_000, pay: decisionPay(cap.pay, lines) });
  stop.abort();
  assert.equal(sent(), 1);
  assert.equal(got.verdicts.length, 2);
  assert.deepEqual(cap.settles, [PRICE.requestUsd], "an answer that reported no cost settles at its hold");
  assert.equal(lines[0].usd, PRICE.requestUsd);
});
