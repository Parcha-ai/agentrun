// Under --faux only: Parallel's search as a call node's web_search reaches it (web-search.ts webSearch over
// web-fetch.ts parallelOf), in place of Parallel's API. Each request is counted on globalThis.fauxParallelSearches (the
// runner runs in the test's own process), and answered with one result. A test that sets globalThis.fauxParallelHold (a
// promise) holds each search until it settles, and is told each arrival on globalThis.fauxParallelArrived.
export default async function fauxParallel(url, init = {}) {
  globalThis.fauxParallelSearches = (globalThis.fauxParallelSearches ?? 0) + 1;
  globalThis.fauxParallelArrived?.();
  if (globalThis.fauxParallelHold) await globalThis.fauxParallelHold;
  void url;
  void init;
  const body = { search_id: "faux-1", results: [{ url: "https://example.com/agentrun", title: "agentrun", excerpts: ["A result."] }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
