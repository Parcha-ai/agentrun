// A keyed request never follows a redirect: every request that carries a provider's key (Exa's and Parallel's
// x-api-key, Firecrawl's bearer) is sent with redirect "error". A 307 from the provider's address to another port is
// refused as a failed request, and the other port never sees a request, so never the key. Both servers are on
// loopback; no socket leaves the machine, and the keys are canaries.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { exaClient } from "../dist/providers/exa.js";
import { firecrawlClient } from "../dist/providers/firecrawl.js";
import { parallelExtract } from "../dist/providers/parallel.js";

const KEY = "keyed-redirect-canary-0123456789";

/** Two loopback servers: `from` answers every request with a 307 to `to`, which records what reaches it. */
async function redirecting(t) {
  const reached = [];
  const listen = (handler) => new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
    t.after(() => new Promise((done) => server.close(done)));
  });
  const to = await listen((req, res) => {
    reached.push({ url: req.url, headers: req.headers });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const toUrl = `http://127.0.0.1:${to.address().port}`;
  const from = await listen((req, res) => {
    req.resume();
    res.writeHead(307, { location: `${toUrl}${req.url}` }).end();
  });
  return { fromUrl: `http://127.0.0.1:${from.address().port}`, reached };
}

const unreached = (reached, who) => {
  assert.equal(reached.length, 0, `${who}: the redirect's target never sees a request`);
  assert.ok(!JSON.stringify(reached).includes(KEY), `${who}: the redirect's target never sees the key`);
};

test("Exa's keyed requests refuse a 307 to another port, and the other port never sees the key", async (t) => {
  const { fromUrl, reached } = await redirecting(t);
  const exa = exaClient(KEY, fetch, undefined, fromUrl);
  await assert.rejects(exa.post("/search", { query: "q", type: "auto", numResults: 1 }), "Exa: a redirect is an error, never followed");
  unreached(reached, "Exa");
});

test("Firecrawl's keyed requests refuse a 307 to another port, and the other port never sees the key", async (t) => {
  const { fromUrl, reached } = await redirecting(t);
  const firecrawl = firecrawlClient(KEY, fetch, undefined, fromUrl);
  await assert.rejects(firecrawl.post("/v2/search", { query: "q", limit: 1 }), "Firecrawl: a redirect is an error, never followed");
  unreached(reached, "Firecrawl");
});

test("Parallel's keyed search and extract refuse a 307 to another port, and the other port never sees the key", async (t) => {
  const { fromUrl, reached } = await redirecting(t);
  // Parallel's own URLs, sent to the loopback server with the request as the provider made it.
  const send = (url, init) => fetch(`${fromUrl}${new URL(url).pathname}`, init);
  const parallel = parallelExtract(KEY, send);
  const read = await parallel.extract("https://example.com/");
  assert.ok("error" in read, "Parallel's extract: a redirect is a failed read");
  unreached(reached, "Parallel's extract");
  await assert.rejects(parallel.post("https://api.parallel.ai/v1/search", { objective: "o", search_queries: ["q"], mode: "fast", advanced_settings: { max_results: 1 } }), "Parallel's search: a redirect is an error, never followed");
  unreached(reached, "Parallel");
});
