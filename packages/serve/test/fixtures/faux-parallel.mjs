// Under --faux only: the fetch serve's Parallel provider, web_fetch and web_search send their requests through, in place
// of Parallel's API (the tests' fake). It answers every question, and each extract with the URL's full content, or as
// AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT says: "errors" lists the URL in `errors`, a number answers that HTTP status. A
// search answers `max_results` results (search()), or the HTTP status AGENTRUN_TEST_FAUX_PARALLEL_SEARCH names, and a list
// of monitors (GET /v1/monitors, a saved key's check) answers none; "slow:<ms>" answers a search after that long. It counts
// as authorized only the canary key, and files one line per call (with the process that made it) in the file
// AGENTRUN_TEST_FAUX_PARALLEL_CALLS names. Like Parallel's API, it reports no cost.
import { appendFileSync } from "node:fs";

/** The Parallel key the tests set: a value a run's tools and model must never be able to read. */
export const CANARY = "par-canary-4e81b0c39a27";

export default async function fakeParallel(url, init = {}) {
  const key = new Headers(init.headers).get("x-api-key");
  const body = init.body === undefined ? {} : JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
  const path = new URL(String(url)).pathname;
  if (process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_PARALLEL_CALLS, `${JSON.stringify({ pid: process.pid, path, authorized: key === CANARY, questions: Object.keys(body.questions ?? {}), ...(body.urls ? { urls: body.urls } : {}), ...(body.search_queries ? { queries: body.search_queries } : {}) })}\n`);
  if (key !== CANARY) return new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401, headers: { "content-type": "application/json" } });
  if (path === "/v1/monitors") return new Response(JSON.stringify({ monitors: [] }), { status: 200, headers: { "content-type": "application/json" } });
  if (path === "/v1/extract") return extract(body.urls, process.env.AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT ?? "");
  if (path === "/v1/search") return search(body, process.env.AGENTRUN_TEST_FAUX_PARALLEL_SEARCH ?? "", init.signal);
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

/** A long excerpt: past the 3,000 characters a snippet keeps, and past what Parallel is asked for. */
const LONG_EXCERPT = `${"Widgets are registered in Delaware under file 1234567. ".repeat(60)}The end.`;

/** Parallel's search answer to `body`, as `mode` says: `max_results` results (10 when it asks none), the first with a
 *  null title, two excerpts (one with a markdown link) and a publish date, the rest one short excerpt and none. */
async function search(body, mode, signal) {
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  // "slow:<ms>": the answer comes after that long, as a slow Parallel's would (a fetch's abort still ends it).
  const slow = /^slow:(\d+)$/.exec(mode);
  if (slow) await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Number(slow[1]));
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason ?? new DOMException("aborted", "AbortError"))), { once: true });
  });
  if (/^\d+$/.test(mode)) return json({ type: "error", error: { ref_id: "ref-faux-2", message: `faux status ${mode}` } }, Number(mode));
  const count = body.advanced_settings?.max_results ?? 10;
  const results = Array.from({ length: count }, (_, i) => i === 0
    ? { url: "https://registry.example/widgets", title: null, publish_date: "2026-10-01", excerpts: ["See the [registry entry](https://registry.example/widgets/1234567) for\n\nWidgets, Inc.", LONG_EXCERPT] }
    : { url: `https://result.example/${i + 1}`, title: `Result ${i + 1} for ${body.search_queries[0]}`, publish_date: null, excerpts: [`Excerpt ${i + 1}.`] });
  return json({ search_id: "search-faux-1", results, warnings: null, usage: [{ name: "sku_search", count: 1 }], session_id: "session-faux-1" });
}
