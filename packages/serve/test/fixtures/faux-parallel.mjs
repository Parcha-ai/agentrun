// Under --faux only: the fetch serve's Parallel provider sends decision requests through, in place of Parallel's API (the
// tests' fake). It answers every question, counts as authorized only the canary key, and files one line per call (with the
// process that made it) in the file AGENTRUN_TEST_FAUX_PARALLEL_CALLS names. Like Parallel's API, it reports no cost.
import { appendFileSync } from "node:fs";

/** The Parallel key the tests set: a value a run's tools and model must never be able to read. */
export const CANARY = "par-canary-4e81b0c39a27";

export default async function fakeParallel(url, init = {}) {
  const key = new Headers(init.headers).get("x-api-key");
  const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
  if (process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS, `${JSON.stringify({ pid: process.pid, path: new URL(String(url)).pathname, authorized: key === CANARY, questions: Object.keys(body.questions ?? {}) })}\n`);
  if (key !== CANARY) return new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401, headers: { "content-type": "application/json" } });
  const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, q]) => {
    if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      return [id, { type: "choice", choice: options[0], probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.9 : 0.1 / Math.max(1, options.length - 1)])) }];
    }
    if (q.type === "score") return [id, { type: "score", score: 0, legend: Object.fromEntries(q.criteria.map((v, i) => [i, v])), probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i === 0 ? 1 : 0])) }];
    return [id, { type: "noul", noul: 0.31 }];
  }));
  return new Response(JSON.stringify({ decision_id: "dec-faux-1", mode: "fast", answers, citations: [{ url: "https://registry.example.test/widgets", title: "Example Widgets, Inc.", excerpts: ["Incorporated in Delaware."] }] }), { status: 200, headers: { "content-type": "application/json" } });
}
