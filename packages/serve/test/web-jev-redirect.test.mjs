// The fetch serve hands the web tools' Jev (web-run.ts jevWebOf) sends each request with redirect "error". A 307 from
// the TypeSafe host to another port fails the sift, the search still answers with its results unranked, and the other
// port never sees a request, so it never sees the key. The TypeSafe host is a loopback server reached through
// fixtures/faux-jev-redirect.mjs, and Parallel is the usual fake. The key is the faux Jev's canary.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { CANARY as JEV_KEY } from "./fixtures/faux-jev-web.mjs";
import { CANARY as PARALLEL_KEY } from "./fixtures/faux-parallel.mjs";
import { toolLedger } from "./support.mjs";

const { searchFor } = await import("../dist/web-search.js");
const { TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");
const { bookedIn } = await import("../dist/paid-calls.js");

const FAUX_JEV = new URL("./fixtures/faux-jev-redirect.mjs", import.meta.url).pathname;
const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;

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

test("Jev's requests through serve's handed fetch refuse a 307 to another port, and the other port never sees one", async (t) => {
  const { fromUrl, reached } = await redirecting(t);
  const before = process.env.AGENTRUN_TEST_FAUX_JEV_REDIRECT_FROM;
  process.env.AGENTRUN_TEST_FAUX_JEV_REDIRECT_FROM = fromUrl;
  t.after(() => (before === undefined ? delete process.env.AGENTRUN_TEST_FAUX_JEV_REDIRECT_FROM : (process.env.AGENTRUN_TEST_FAUX_JEV_REDIRECT_FROM = before)));
  const env = {
    AGENTRUN_SERVE_FAUX: "1",
    AGENTRUN_SERVE_FAUX_PARALLEL: FAUX_PARALLEL,
    AGENTRUN_SERVE_FAUX_JEV: FAUX_JEV,
    AGENTRUN_SERVE_FAUX_WEB: FAUX_WEB,
    PARALLEL_API_KEY: PARALLEL_KEY,
    TYPESAFE_API_KEY: JEV_KEY,
    [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "parallel", web_fetch: "parallel" }),
  };
  const ledger = await toolLedger();
  const found = await bookedIn({ call: "test-call", paid: { admit: (r) => ledger.admit(r), settle: (id, usd, o) => ledger.settle(id, usd, o) } }, () => searchFor(env, { query: "widgets delaware", n: 4 }));
  assert.equal(found.error, undefined, `the search still answers: ${JSON.stringify(found).slice(0, 300)}`);
  assert.ok(found.results.length > 0, "with its results");
  assert.match(found.sift ?? "", /^not run/, `Jev's sift failed on the redirect: sift ${JSON.stringify(found.sift)}`);
  assert.equal(reached.length, 0, "Jev: the redirect's target never sees a request");
  assert.ok(!JSON.stringify(reached).includes(JEV_KEY), "Jev: the redirect's target never sees the key");
});
