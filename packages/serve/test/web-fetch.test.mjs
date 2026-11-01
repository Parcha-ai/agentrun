// web_fetch: fetch_page's Page plus `via`, read through Parallel's extract where the run holds Parallel's key, else (or
// when Parallel answers no page) through the guarded direct fetch. Parallel is the tests' fake (fixtures/faux-parallel.mjs)
// and the network a table (fixtures/fake-network.mjs): no socket, no real key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { PARALLEL_EXTRACT_URL, parallelExtract, webFetch } from "../dist/web-fetch.js";
import fakeParallel, { CANARY } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;
const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const MODE = "AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT";
const PUBLIC = "http://public.example/";

/** The fake Parallel answering extract as `mode` says (each test puts its variable back), and every request it was sent. */
function parallel(mode = "") {
  process.env[MODE] = mode;
  const sent = [];
  const send = async (url, init) => {
    sent.push({ url: String(url), key: new Headers(init.headers).get("x-api-key"), body: JSON.parse(init.body) });
    return fakeParallel(url, init);
  };
  return { sent, send };
}

const withoutText = ({ text, ...rest }) => rest;

test("with a key, a public page is read through Parallel's extract: via parallel, sent once as Parallel documents it, nothing dialled", async (t) => {
  withEnv(t, {}, [MODE]);
  const { sent, send } = parallel();
  const net = network();
  const page = await webFetch(PUBLIC, { ...net, parallel: parallelExtract(CANARY, send) });
  assert.deepEqual(withoutText(page), { ok: true, url: PUBLIC, status: 200, title: "Read by Parallel", links: ["https://other.example/y"], via: "parallel" }, "the absolute links of its markdown, without fragments");
  assert.match(page.text, /^# Read by Parallel\n\nThe page at http:\/\/public\.example\//);
  assert.deepEqual(sent, [{ url: PARALLEL_EXTRACT_URL, key: CANARY, body: { urls: [PUBLIC], advanced_settings: { full_content: { max_chars_per_result: 60_000 } } } }]);
  assert.deepEqual(net.dialled, [], "the guard checked the URL without dialling it, and the direct fetch never ran");
});

test("a page's links keep the parentheses a URL holds in pairs, a wiki title's, and end at the one that closes the link", async () => {
  const full_content = "See [the function](https://en.wikipedia.org/wiki/Function_(mathematics)) and [the other page](https://other.example/y#top).";
  const send = async () => new Response(JSON.stringify({ results: [{ url: PUBLIC, title: "Links", full_content }], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
  const page = await parallelExtract(CANARY, send).read(PUBLIC);
  assert.deepEqual(page.links, ["https://en.wikipedia.org/wiki/Function_(mathematics)", "https://other.example/y"]);
});

test("a guard check whose lookup never answers does not pass within its bound: nothing goes to Parallel, the direct fetch answers", async (t) => {
  withEnv(t, {}, [MODE]);
  const { sent, send } = parallel();
  const net = network();
  // The check's lookup, the first, never settles; the direct fetch's, the next, answers from the table.
  let lookups = 0;
  const lookup = (host) => (lookups++ === 0 ? new Promise(() => {}) : net.lookup(host));
  // The bound's timer does not hold a process open: this does, as a run's door does in its process.
  const open = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(open));
  const started = performance.now();
  const page = await webFetch(PUBLIC, { ...net, lookup, parallel: parallelExtract(CANARY, send), checkMs: 50 });
  assert.ok(performance.now() - started < 2_000, "the check gave up at its bound, not at Parallel's or the fetch's timeout");
  assert.deepEqual([page.ok, page.title, page.via], [true, "Public page", "direct"], JSON.stringify(withoutText(page)));
  assert.deepEqual(sent, [], "Parallel was sent nothing");
  assert.equal(lookups, 2);
});

test("the URL in Parallel's errors, a 5xx, or a request that fails falls back to the guarded direct fetch: via direct, Parallel still tried next time", async (t) => {
  withEnv(t, {}, [MODE]);
  for (const mode of ["errors", "500", "503", "throws"]) {
    const { sent, send } = parallel(mode === "throws" ? "" : mode);
    const failing = mode === "throws" ? async () => { throw new DOMException("The operation timed out.", "TimeoutError"); } : send;
    const extract = parallelExtract(CANARY, failing);
    const net = network();
    const page = await webFetch(PUBLIC, { ...net, parallel: extract });
    assert.deepEqual([page.ok, page.title, page.via], [true, "Public page", "direct"], `${mode}: ${JSON.stringify(withoutText(page))}`);
    assert.deepEqual(net.dialled, [PUBLIC], mode);
    assert.equal(sent.length, mode === "throws" ? 0 : 1, mode);
    assert.equal(extract.live(), true, `${mode} is not the key refused`);
  }
});

test("a URL the guard refuses is never sent to Parallel: refused as fetch_page refuses it, via direct", async (t) => {
  withEnv(t, {}, [MODE]);
  const { sent, send } = parallel();
  const extract = parallelExtract(CANARY, send);
  const hostile = [
    ...["http://127.0.0.1/", "http://localhost/", "http://[::1]/", "http://[::ffff:127.0.0.1]/"],
    "http://app.localhost/",
    ...["http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/"], // key-gate: denylist the addresses the guard must refuse before Parallel is sent a URL
    ...["http://evil.example/", "http://mixed.example/", "http://public.example:8080/", "file:///etc/passwd", "ftp://public.example/"],
  ];
  for (const url of hostile) {
    const net = network();
    const page = await webFetch(url, { ...net, parallel: extract });
    assert.deepEqual([page.ok, page.via], [false, "direct"], url);
    assert.match(page.refused ?? "", /^refused: /, `${url}: ${JSON.stringify(page)}`);
    assert.deepEqual(net.dialled, [], url);
  }
  assert.equal((await webFetch("not a url", { ...network(), parallel: extract })).error, "url is not an absolute URL");
  assert.deepEqual(sent, [], "Parallel was sent none of them");
});

test("a 401 or 403 stops Parallel for the rest of the run: the next read goes straight to the direct fetch", async (t) => {
  withEnv(t, {}, [MODE]);
  for (const [key, mode] of [["not-a-secret", ""], [CANARY, "403"]]) {
    const { sent, send } = parallel(mode);
    const extract = parallelExtract(key, send);
    const pages = [await webFetch(PUBLIC, { ...network(), parallel: extract }), await webFetch(PUBLIC, { ...network(), parallel: extract })];
    assert.deepEqual(pages.map((page) => [page.ok, page.via]), [[true, "direct"], [true, "direct"]], mode || "401");
    assert.equal(sent.length, 1, `${mode || "401"}: Parallel was asked once`);
    assert.equal(extract.live(), false);
  }
});

/** The server's environment for test `t`: Parallel's key when `key`, and files for the fake Parallel's calls and the
 *  network's dials, whose lines each answer gives back. */
async function calls(t, key) {
  const dir = await scratch(t);
  const files = { parallel: join(dir, "parallel.jsonl"), web: join(dir, "dialled.txt") };
  withEnv(t, { ...(key ? { PARALLEL_API_KEY: CANARY } : {}), AGENTRUN_TEST_FAUX_PARALLEL_CALLS: files.parallel, FAUX_WEB_LOG: files.web }, ["PARALLEL_API_KEY", MODE]);
  const lines = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return async () => ({ parallel: (await lines(files.parallel)).map((line) => JSON.parse(line)), dialled: await lines(files.web) });
}

for (const key of [true, false]) {
  test(`an agentic run naming web_fetch ${key ? "reads through Parallel on the server's key" : "with no Parallel key fetches directly, and no request reaches Parallel"}`, { timeout: 60_000 }, async (t) => {
    const seen = await calls(t, key);
    const { api } = await serve(t, { fauxWeb: FAUX_WEB, fauxParallel: FAUX_PARALLEL });
    assert.equal((await api("POST", "/agents", { definition: { id: "reader", name: "reader", instructions: "Read.", tools: ["web_fetch"] } })).status, 201);
    const started = await api("POST", "/agents/reader/runs", { input: { content: `Fetch these pages with web_fetch: ${JSON.stringify([PUBLIC])}` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const { rows } = await follow(api, started.body.run_id, ["completed"]);
    const results = rows.filter((row) => row.kind === "tool_result").map((row) => row.tool_result_preview);
    assert.equal(results.length, 1, JSON.stringify(results));
    assert.match(results[0], key ? /"title":"Read by Parallel".*"via":"parallel"/s : /"title":"Public page".*"via":"direct"/s);
    const { parallel: sent, dialled } = await seen();
    assert.deepEqual(sent.map((call) => [call.path, call.authorized, call.urls]), key ? [["/v1/extract", true, [PUBLIC]]] : []);
    assert.deepEqual(dialled, key ? [] : [PUBLIC]);
  });
}
