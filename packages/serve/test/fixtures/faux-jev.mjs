// Under --faux only: the fetch serve's Jev runner sends System One requests through, in place of TypeSafe's API (the
// tests' fake). It answers every question, counts as authorized only the canary key, and files one line per call (with the
// process that made it and the descriptor it was handed the key on) in the file AGENTRUN_TEST_FAUX_JEV_CALLS names. It
// reports no cost unless a test sets one.
import { appendFileSync } from "node:fs";

/** The decision key the tests set: a value a run's tools and model must never be able to read. */
export const CANARY = "ts-canary-9f2c41d7e0b6";

export default async function fakeJev(url, init = {}) {
  const auth = new Headers(init.headers).get("authorization");
  const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
  if (process.env.AGENTRUN_TEST_FAUX_JEV_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_JEV_CALLS, `${JSON.stringify({ pid: process.pid, key_fd: process.env.AGENTRUN_SERVE_DECISION_KEY_FD, path: new URL(String(url)).pathname, authorized: auth === `Bearer ${CANARY}`, questions: Object.keys(body.questions ?? {}) })}\n`);
  // AGENTRUN_TEST_FAUX_JEV_HANG: every call is received and never answered; it ends only when its request is aborted.
  if (process.env.AGENTRUN_TEST_FAUX_JEV_HANG) {
    return new Promise((_, reject) => {
      const abort = () => reject(init.signal.reason ?? new DOMException("aborted", "AbortError"));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  // AGENTRUN_TEST_FAUX_JEV_STATUS: every call is received, then fails with that status (a 503 after sending).
  const failWith = Number(process.env.AGENTRUN_TEST_FAUX_JEV_STATUS);
  if (failWith) return new Response(JSON.stringify({ detail: "unavailable" }), { status: failWith, headers: { "content-type": "application/json" } });
  if (auth !== `Bearer ${CANARY}`) return new Response(JSON.stringify({ detail: "invalid key" }), { status: 401, headers: { "content-type": "application/json" } });
  const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, q]) => {
    if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      return [id, { type: "choice", choice: options[0], confidence: 0.8, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.85 : 0.15 / Math.max(1, options.length - 1)])) }];
    }
    if (q.type === "score") return [id, { type: "score", score: 0, confidence: 0.8, legend: Object.fromEntries(q.criteria.map((v, i) => [i, v])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === 0 ? 1 : 0])) }];
    return [id, { type: "noul", noul: 0.92 }];
  }));
  // AGENTRUN_TEST_FAUX_JEV_COST: a cost the provider reports for each call, in USD (live Jev reports about $0.00003).
  const cost = process.env.AGENTRUN_TEST_FAUX_JEV_COST ? { cost: Number(process.env.AGENTRUN_TEST_FAUX_JEV_COST) } : {};
  // AGENTRUN_TEST_FAUX_JEV_NO_USAGE: the answer counts no tokens, so its cost is unknown even at a published price.
  const usage = process.env.AGENTRUN_TEST_FAUX_JEV_NO_USAGE ? {} : { usage: { input_tokens: 120, output_tokens: 0, ...cost } };
  return new Response(JSON.stringify({ model: "jev-1.14.0", answers, ...usage }), { status: 200, headers: { "content-type": "application/json", "x-typesafe-request-id": "req-faux-1" } });
}
