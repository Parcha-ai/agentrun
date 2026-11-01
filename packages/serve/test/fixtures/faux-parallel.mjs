// Under --faux only: the fetch serve's Parallel provider and web_fetch send their requests through, in place of Parallel's
// API (the tests' fake). It answers every question, and each extract with the URL's full content, or as
// AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT says: "errors" lists the URL in `errors`, a number answers that HTTP status. It counts
// as authorized only the canary key, and files one line per call (with the process that made it) in the file
// AGENTRUN_TEST_FAUX_PARALLEL_CALLS names. Like Parallel's API, it reports no cost.
import { appendFileSync } from "node:fs";

/** The Parallel key the tests set: a value a run's tools and model must never be able to read. */
export const CANARY = "par-canary-4e81b0c39a27";

export default async function fakeParallel(url, init = {}) {
  const key = new Headers(init.headers).get("x-api-key");
  const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
  const path = new URL(String(url)).pathname;
  if (process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS, `${JSON.stringify({ pid: process.pid, path, authorized: key === CANARY, questions: Object.keys(body.questions ?? {}), ...(body.urls ? { urls: body.urls } : {}) })}\n`);
  if (key !== CANARY) return new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401, headers: { "content-type": "application/json" } });
  if (path === "/v1/extract") return extract(body.urls, process.env.AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT ?? "");
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

/** Parallel's extract answer for `urls`, as `mode` says. */
function extract(urls, mode) {
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  if (/^\d+$/.test(mode)) return json({ type: "error", error: { ref_id: "ref-faux-1", message: `faux status ${mode}` } }, Number(mode));
  const answer = { extract_id: "extract-faux-1", warnings: null, usage: [{ name: "sku_extract_full_content", count: urls.length }], session_id: "session-faux-1" };
  if (mode === "errors") return json({ ...answer, results: [], errors: urls.map((url) => ({ url, error_type: "fetch_failed", http_status_code: 403, content: null })) });
  const page = (url) => ({ url, title: "Read by Parallel", publish_date: null, excerpts: [], full_content: `# Read by Parallel\n\nThe page at ${url}, with [a link](https://other.example/y#top) and [another](/relative).` });
  return json({ ...answer, results: urls.map(page), errors: [] });
}
