// web_fetch: a Page plus `via`: the guarded direct fetch, or, where Parallel is picked and the run holds its
// key, read through Parallel's extract (and the direct fetch when Parallel answers no page). Parallel is the tests' fake
// (fixtures/faux-parallel.mjs) and the network a table (fixtures/fake-network.mjs): no socket, no real key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import * as pages from "../dist/fetch-page.js";
import * as web from "../dist/web-fetch.js";
import { fetchFor, PARALLEL_EXTRACT_URL, parallelExtract, webFetch } from "../dist/web-fetch.js";
import fakeParallel, { CANARY } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { TOOLS } from "../dist/tools.js";
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
  assert.deepEqual(withoutText(page), { ok: true, url: PUBLIC, status: 200, title: "Read by Parallel", chars: page.text.length, links: ["https://other.example/y"], via: "parallel" }, "the absolute links of its markdown, without fragments");
  assert.match(page.text, /^# Read by Parallel\n\nThe page at http:\/\/public\.example\//);
  assert.deepEqual(sent, [{ url: PARALLEL_EXTRACT_URL, key: CANARY, body: { urls: [PUBLIC], advanced_settings: { full_content: { max_chars_per_result: 1_000_001 } } } }], "the most of a page web_fetch reads and one character, so a page Parallel cut there shows as cut");
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

test("the URL in Parallel's errors, a 5xx, or a request that fails falls back to the guarded direct fetch: via direct, saying why, Parallel still tried next time", async (t) => {
  withEnv(t, {}, [MODE]);
  const why = { errors: "listed the URL in errors", 500: "answered 500", 503: "answered 503", throws: "timed out" };
  for (const mode of ["errors", "500", "503", "throws"]) {
    const { sent, send } = parallel(mode === "throws" ? "" : mode);
    const failing = mode === "throws" ? async () => { throw new DOMException("The operation timed out.", "TimeoutError"); } : send;
    const extract = parallelExtract(CANARY, failing);
    const net = network();
    const page = await webFetch(PUBLIC, { ...net, parallel: extract });
    assert.deepEqual([page.ok, page.title, page.via, page.parallel], [true, "Public page", "direct", why[mode]], `${mode}: ${JSON.stringify(withoutText(page))}`);
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
    assert.deepEqual([page.ok, page.via, page.parallel], [false, "direct", "not tried: the URL did not pass the public-host guard"], url);
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
    assert.deepEqual(pages.map((page) => [page.ok, page.via, page.parallel]), [[true, "direct", `refused the key (${mode || "401"})`], [true, "direct", "not tried: refused earlier in this run"]], mode || "401");
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

for (const [key, picked, mode] of [[true, true, ""], [true, true, "errors"], [true, false, ""], [false, false, ""]]) {
  const what = picked && mode ? "with Parallel picked, when Parallel lists the URL in its errors, fetches directly and says so to the model" : picked ? "with Parallel picked reads through Parallel on the server's key" : key ? "with the server's Parallel key but Parallel not picked fetches directly, and no request reaches Parallel" : "with no Parallel key fetches directly, and no request reaches Parallel";
  test(`an agentic run naming web_fetch ${what}`, { timeout: 60_000 }, async (t) => {
    const seen = await calls(t, key);
    process.env[MODE] = mode;
    const { api } = await serve(t, { fauxWeb: FAUX_WEB, fauxParallel: FAUX_PARALLEL });
    const tool_settings = picked ? { tool_settings: { web_fetch: { provider: "parallel" } } } : {};
    assert.equal((await api("POST", "/agents", { definition: { id: "reader", name: "reader", instructions: "Read.", tools: ["web_fetch"], ...tool_settings } })).status, 201);
    const started = await api("POST", "/agents/reader/runs", { input: { content: `Fetch these pages with web_fetch: ${JSON.stringify([PUBLIC])}` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const { rows } = await follow(api, started.body.run_id, ["completed"]);
    const results = rows.filter((row) => row.kind === "tool_result").map((row) => row.tool_result_preview);
    assert.equal(results.length, 1, JSON.stringify(results));
    if (picked && mode) assert.match(results[0], /"title":"Public page".*"via":"direct","parallel":"listed the URL in errors"\}\nParallel was picked for web_fetch and gave no page \(listed the URL in errors\); this one was fetched directly\.$/s);
    else assert.match(results[0], picked ? /"title":"Read by Parallel".*"via":"parallel"\}$/s : /"title":"Public page".*"via":"direct"\}$/s, "no word of Parallel where it read the page or was never picked");
    const { parallel: sent, dialled } = await seen();
    assert.deepEqual(sent.map((call) => [call.path, call.authorized, call.urls]), picked ? [["/v1/extract", true, [PUBLIC]]] : []);
    assert.deepEqual(dialled, picked && !mode ? [] : [PUBLIC]);
  });
}

/** The line after a page's JSON that tells the model where it is in the page, if any. */
const where = (page, name = "web_fetch") => web.webFetchText(page, name).slice(JSON.stringify(page).length + 1) || undefined;

test("a long page is read in parts: max_chars characters from offset (20,000 by default), each saying which of how many and the offset that reads on; the last says it is the end", async () => {
  const long = `${"forty-two ".repeat(4_700)}end`;
  const fetchImpl = async () => new Response(long, { status: 200, headers: { "content-type": "text/plain" } });
  const read = (window) => webFetch(PUBLIC, { ...network(), fetchImpl, ...window });
  const first = await read({});
  assert.deepEqual(withoutText(first), { ok: true, url: PUBLIC, status: 200, title: "", chars: 20_000, truncated: true, original_chars: 47_003, next_offset: 20_000, links: [], via: "direct" });
  assert.equal(first.text, long.slice(0, 20_000));
  assert.equal(pages.PAGE_CHARS, 20_000);
  assert.equal(where(first), "Characters 0-20000 of 47003: call web_fetch again with offset=20000 for the rest.");
  assert.equal(where(first, "fetch_page"), "Characters 0-20000 of 47003: call fetch_page again with offset=20000 for the rest.", "by the name it was called");
  const next = await read({ offset: 20_000, maxChars: 25_000 });
  assert.deepEqual([next.text, next.chars, next.offset, next.truncated, next.original_chars, next.next_offset], [long.slice(20_000, 45_000), 25_000, 20_000, true, 47_003, 45_000]);
  const last = await read({ offset: 45_000 });
  assert.deepEqual(withoutText(last), { ok: true, url: PUBLIC, status: 200, title: "", chars: 2_003, offset: 45_000, original_chars: 47_003, links: [], via: "direct" }, "nothing after it: not truncated");
  assert.equal(last.text, long.slice(45_000));
  assert.equal(where(last), "Characters 45000-47003 of 47003: the end of the page.");
  const past = await read({ offset: 50_000 });
  assert.deepEqual([past.ok, past.text, past.chars, past.offset, past.original_chars, "truncated" in past], [true, "", 0, 50_000, 47_003, false]);
  assert.equal(where(past), "Nothing at offset=50000: the page has 47003 characters.");
  const most = await webFetch(PUBLIC, { ...network(), fetchImpl: async () => new Response("x".repeat(60_000), { status: 200, headers: { "content-type": "text/plain" } }), maxChars: 1_000_000 });
  assert.deepEqual([most.chars, most.next_offset, pages.TEXT_CAP], [50_000, 50_000, 50_000], "max_chars is at most 50,000");
  const short = await webFetch(PUBLIC, network());
  assert.deepEqual(["truncated" in short, "original_chars" in short, "offset" in short, "next_offset" in short, short.chars], [false, false, false, false, short.text.length], "a page read whole says nothing of parts");
  assert.equal(where(short), undefined, "and no line about them");
});

test("max_chars counts the text as the answer holds it: a quote or a line break takes two, a control character six, and a cut never splits a character", async () => {
  const read = async (body, maxChars) => webFetch(PUBLIC, { ...network(), fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }), maxChars });
  const quoted = await read('"a\n'.repeat(10_000), 1_001);
  assert.ok(JSON.stringify(quoted.text).length - 2 <= 1_001, `the text takes ${JSON.stringify(quoted.text).length - 2}`);
  assert.deepEqual([quoted.chars, quoted.next_offset], [600, 600], "five characters each three: 200 of them, the next would pass 1,001");
  const control = await read("\u0001".repeat(1_000), 100);
  assert.deepEqual([control.chars, JSON.stringify(control.text).length - 2], [16, 96]);
  const smiles = await read("😀".repeat(1_000), 1_001);
  assert.deepEqual([smiles.chars, smiles.text, smiles.next_offset], [1_000, "😀".repeat(500), 1_000], "500 whole pairs, not 500 and a half");
});

test("max_chars below its minimum (200) is refused before anything is fetched, saying the minimum, and so is an offset below 0; a smaller part read directly still advances by a whole character, never stuck at its offset", async () => {
  assert.equal(pages.MAX_CHARS_MIN, 200);
  assert.equal(pages.URL_PARAMETERS.properties.max_chars.minimum, 200, "the tool's schema says it");
  for (const [part, said] of [[{ maxChars: 1 }, "max_chars must be at least 200 (it was 1)"], [{ maxChars: 199.5 }, "max_chars must be at least 200 (it was 199.5)"], [{ offset: -1 }, "offset must be a whole number, 0 or more (it was -1)"]]) {
    const net = network();
    const page = await fetchFor({}, PUBLIC, { ...net, ...part });
    assert.deepEqual([page.ok, page.error, net.dialled], [false, said, []], JSON.stringify(part));
  }
  assert.equal((await fetchFor({}, PUBLIC, { ...network(), maxChars: 200 })).ok, true, "200 reads");
  // The finding: a part of one character whose next is a quote, a line break, a backslash or a pair came back empty, its
  // next_offset where it started, and a caller following it never moved on.
  for (const body of ['"rest', "\nrest", "\\rest", "😀rest"]) {
    const page = await webFetch(PUBLIC, { ...network(), fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }), maxChars: 1 });
    const first = body.codePointAt(0) > 0xffff ? 2 : 1;
    assert.deepEqual([page.text, page.chars, page.next_offset], [body.slice(0, first), first, first], JSON.stringify(body));
  }
  assert.deepEqual([pages.partEnd('"x', 0, 1), pages.partEnd("😀x", 0, 1), pages.partEnd("\u0001x", 0, 3), pages.partEnd("x", 1, 1)], [1, 2, 1, 1], "one whole character at least, while one is left");
});

test("at the minimum, a page whose parts end before a quote, a line break, a backslash and a pair is read whole by following next_offset: every part advances, none repeats, none skips", async () => {
  const min = pages.MAX_CHARS_MIN;
  assert.equal(min, 200);
  const fill = (n) => "a".repeat(n);
  // Each part takes 199 characters of 'a's (or a special and 197), and the next special (taking two) does not fit.
  const body = `${fill(199)}"${fill(197)}\n${fill(197)}\\${fill(197)}😀${fill(197)}${'"\n\\😀b'.repeat(300)}end`;
  const fetchImpl = async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  const parts = [];
  for (let offset = 0, guard = 0; ; guard++) {
    assert.ok(guard < 1_000, "the parts end");
    const page = await webFetch(PUBLIC, { ...network(), fetchImpl, offset, maxChars: min });
    assert.ok(JSON.stringify(page.text).length - 2 <= min, `part ${parts.length} takes ${JSON.stringify(page.text).length - 2}`);
    parts.push(page.text);
    if (!page.truncated) break;
    assert.ok(page.next_offset > offset, `part ${parts.length} advances from ${offset} (next_offset ${page.next_offset})`);
    assert.equal(page.next_offset, offset + page.chars, "next_offset is where this part ends");
    offset = page.next_offset;
  }
  assert.deepEqual(parts.slice(1, 5).map((part) => [...part][0]), ['"', "\n", "\\", "😀"], "parts begin at each special");
  assert.equal(parts.join(""), body, "the whole page, no repeats, no gaps");
});

/** A Parallel that answers each extract with `pages[url]` up to what it was asked for (a function of the call's number
 *  gives each call its own answer), and every max_chars_per_result it was asked for. */
function paging(pages) {
  const asked = [];
  const send = async (_url, init) => {
    const body = JSON.parse(init.body);
    const want = body.advanced_settings.full_content.max_chars_per_result;
    asked.push(want);
    const page = pages(asked.length, body.urls[0]);
    if (typeof page === "number") return new Response(JSON.stringify({ error: { message: "faux" } }), { status: page, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ results: [{ url: page.url ?? body.urls[0], title: "Long", full_content: page.text.slice(0, want) }], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { asked, send };
}

test("through Parallel a page is one billed extract a run, asked for its first 1,000,001 characters: every later part comes from what the run read, with no request, and from Parallel's text however Parallel answers later", async () => {
  const long = `${"forty-two ".repeat(5_000)}end`;
  // Parallel answers the first extract, and would fail any other.
  const { asked, send } = paging((n) => (n === 1 ? { text: long, url: `${PUBLIC}final` } : 500));
  assert.equal(pages.PAGE_READ_MAX_CHARS, 1_000_000);
  const extract = parallelExtract(CANARY, send);
  const held = new Map();
  const parts = [];
  for (const offset of [0, 20_000, 40_000]) parts.push(await webFetch(PUBLIC, { ...network(), parallel: extract, pages: held, offset }));
  assert.deepEqual(asked, [1_000_001], "three parts, one billed extract");
  assert.deepEqual(parts.map((page) => [page.via, page.parallel, page.url, page.chars, page.offset, page.truncated, page.original_chars, page.next_offset]), [
    ["parallel", undefined, `${PUBLIC}final`, 20_000, undefined, true, 50_003, 20_000],
    ["parallel", undefined, `${PUBLIC}final`, 20_000, 20_000, true, 50_003, 40_000],
    ["parallel", undefined, `${PUBLIC}final`, 10_003, 40_000, undefined, 50_003, undefined],
  ], "every part Parallel's, the page's whole length known from the first: Parallel gave less than it was asked for");
  assert.equal(parts.map((page) => page.text).join(""), long, "the parts are the page, no repeats, no gaps");
  assert.equal((await webFetch(PUBLIC, { ...network(), parallel: extract, pages: held, offset: 10_000 })).text, long.slice(10_000, 30_000), "any part, again");
  assert.equal(asked.length, 1);
  // Without the run's pages, each call reads the page again: one extract each.
  const again = paging(() => ({ text: long }));
  const fresh = parallelExtract(CANARY, again.send);
  for (const offset of [0, 20_000]) await webFetch(PUBLIC, { ...network(), parallel: fresh, offset });
  assert.deepEqual(again.asked, [1_000_001, 1_000_001]);
});

test("the run keeps what it read of its last 8 pages: a page used since stays, the oldest goes and is read again", async () => {
  assert.equal(web.PAGES_HELD, 8);
  const reads = [];
  const fetchImpl = async (url) => (reads.push(url.href), new Response(`page ${url.href}`, { status: 200, headers: { "content-type": "text/plain" } }));
  const held = new Map();
  const read = (n) => webFetch(`${PUBLIC}${n}`, { ...network(), fetchImpl, pages: held });
  for (let n = 0; n < 8; n++) await read(n);
  await read(0);
  await read(8);
  assert.deepEqual([held.size, reads.length], [8, 9], "page 0 was used again, so page 1 went");
  await read(0);
  await read(1);
  assert.deepEqual(reads.slice(9), [`${PUBLIC}1`], "page 0 from what was read; page 1 read again");
});

test("a page fetched directly is fetched once a run too, and so is one Parallel gave none of: its parts are all the direct page's, each saying why, Parallel asked once", async () => {
  const body = `${"plain ".repeat(9_000)}end`;
  let fetched = 0;
  const fetchImpl = async () => (fetched++, new Response(body, { status: 200, headers: { "content-type": "text/plain" } }));
  const failing = paging(() => 503);
  for (const parallel of [undefined, parallelExtract(CANARY, failing.send)]) {
    fetched = 0;
    const held = new Map();
    const parts = [];
    for (let offset = 0, guard = 0; offset !== undefined; guard++) {
      assert.ok(guard < 10, "the parts end");
      const page = await webFetch(PUBLIC, { ...network(), fetchImpl, parallel, pages: held, offset });
      assert.deepEqual([page.via, page.parallel, page.offset ?? 0], ["direct", parallel ? "answered 503" : undefined, offset], `the part at ${offset}`);
      parts.push(page.text);
      offset = page.next_offset;
    }
    assert.equal(parts.join(""), body, "the whole page, no repeats, no gaps");
    assert.equal(fetched, 1, "one fetch for its three parts");
  }
  assert.deepEqual(failing.asked, [1_000_001], "Parallel asked once, for the first part");
});

test("a part near a page's millionth character, through Parallel: the page asked for once at 1,000,001, the part says the page goes on past what web_fetch reads", async () => {
  const huge = "y".repeat(1_000_050);
  const { asked, send } = paging(() => ({ text: huge }));
  const extract = parallelExtract(CANARY, send);
  const held = new Map();
  const before = await webFetch(PUBLIC, { ...network(), parallel: extract, pages: held, offset: 900_000, maxChars: 50_000 });
  const last = await webFetch(PUBLIC, { ...network(), parallel: extract, pages: held, offset: 980_000, maxChars: 50_000 });
  assert.deepEqual(asked, [1_000_001], "once, never past the most a read reaches and one");
  assert.deepEqual([before.chars, before.truncated, before.next_offset, "original_chars" in before], [50_000, true, 950_000, false], "Parallel cut it: its whole length unknown");
  assert.deepEqual([last.via, last.chars, last.offset, "truncated" in last, "original_chars" in last, last.beyond_read], ["parallel", 20_000, 980_000, false, false, true]);
  assert.equal(where(last), "Characters 980000-1000000: the page goes on, but web_fetch reads only a page's first 1,000,000 characters.");
});

test("web_fetch reads a page's first 1,000,000 characters: an offset at or past them is refused before anything is fetched, and the part that reaches them says the page goes on", async () => {
  const net = network();
  const past = await fetchFor({}, PUBLIC, { ...net, offset: 1_000_000 });
  assert.deepEqual([past.ok, past.error, net.dialled], [false, "offset must be under 1,000,000: web_fetch reads a page's first 1,000,000 characters (it was 1000000)", []]);
  const body = "x".repeat(1_000_050);
  const last = await webFetch(PUBLIC, { ...network(), fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }), offset: 980_000, maxChars: 50_000 });
  assert.deepEqual([last.chars, last.offset, "truncated" in last, last.original_chars, last.beyond_read], [20_000, 980_000, false, 1_000_050, true]);
  assert.equal(where(last), "Characters 980000-1000000 of 1000050: the page goes on, but web_fetch reads only a page's first 1,000,000 characters.");
});

test("in a run, web_fetch's agent tool and a call node's web_fetch share what the run read: a page is fetched once for both", async (t) => {
  const dir = await scratch(t);
  const log = join(dir, "dialled.txt");
  withEnv(t, { FAUX_WEB_LOG: log }, []);
  const env = { AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_WEB: FAUX_WEB };
  const url = "http://public.example/notes.txt";
  const tool = web.webFetchTool(env);
  const first = await tool.execute({ url }, {}, {});
  const later = await tool.execute({ url, offset: 6 }, {}, {});
  const node = await TOOLS.web_fetch.effect({ url, offset: 3 }, { signal: AbortSignal.timeout(10_000), env, work: dir });
  assert.deepEqual([first.details.text, later.details.text, node.text], ["Plain notes.", "notes.", "in notes."]);
  assert.deepEqual((await readFile(log, "utf8")).split("\n").filter(Boolean), [url], "one fetch, for the run");
});

test("a page's links come with its first part only, at most 200 of them in 20,000 characters; a URL longer than 4,096 characters is refused before anything is fetched", async () => {
  const links = Array.from({ length: 400 }, (_, i) => `<a href="https://l.example/${i}/${"q".repeat(i === 3 ? 30_000 : 80)}">${i}</a>`).join(" ");
  const html = `<html><head><title>Links</title></head><body><p>${"word ".repeat(10_000)}</p>${links}</body></html>`;
  const fetchImpl = async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  const first = await webFetch(PUBLIC, { ...network(), fetchImpl });
  assert.deepEqual([pages.LINKS_CAP, pages.LINKS_CHARS, pages.URL_MAX], [200, 20_000, 4_096]);
  assert.ok(first.links.length > 100 && first.links.length <= 200, `${first.links.length} links`);
  assert.ok(first.links.reduce((n, link) => n + JSON.stringify(link).length + 1, 0) <= 20_000, "in 20,000 characters of the answer");
  assert.ok(!first.links.some((link) => link.includes("/3/")), "one too long for them is left out");
  assert.deepEqual(first.links.slice(0, 3), [0, 1, 2].map((i) => `https://l.example/${i}/${"q".repeat(80)}`), "in page order");
  assert.equal(first.links_omitted, 400 - first.links.length, "the links left out are counted");
  const later = await webFetch(PUBLIC, { ...network(), fetchImpl, offset: first.next_offset });
  assert.deepEqual([later.links, "links_omitted" in later], [[], false], "a later part has none, and counts none");
  assert.equal("links_omitted" in (await webFetch(PUBLIC, network())), false, "a page whose links all fit counts none");
  const net = network();
  const long = await webFetch(`${PUBLIC}${"a".repeat(4_097 - PUBLIC.length)}`, net);
  assert.deepEqual([long.ok, long.error, long.url.length <= 4_096], [false, "url is longer than 4,096 characters", true]);
  assert.deepEqual(net.dialled, []);
  assert.equal((await webFetch(`${PUBLIC}${"a".repeat(4_096 - PUBLIC.length)}`, network())).error, "the page answered 404", "4,096 is fetched");
});

test("web_fetch takes its provider from the run's plane: none or kernel is the direct fetch, a pick with no key a failed page saying so, never a fetch of another kind", async () => {
  const plane = (web_fetch) => ({ AGENTRUN_SERVE_TOOL_PLANE: JSON.stringify({ web_fetch }) });
  for (const env of [{}, plane("kernel")]) {
    const net = network();
    const page = await fetchFor(env, PUBLIC, net);
    assert.deepEqual([page.via, "parallel" in page, net.dialled], ["direct", false, [PUBLIC]], "a kernel fetch says nothing of Parallel");
  }
  const net = network();
  assert.deepEqual(await fetchFor(plane("unavailable: parallel picked, no PARALLEL_API_KEY"), PUBLIC, net), { ok: false, url: PUBLIC, status: 0, title: "", text: "", links: [], error: "web_fetch does not run here: parallel picked, no PARALLEL_API_KEY" }, "no via: nothing was read");
  assert.deepEqual(net.dialled, [], "nothing fetched");
});
