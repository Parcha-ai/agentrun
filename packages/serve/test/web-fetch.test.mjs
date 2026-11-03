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
  assert.deepEqual(sent, [{ url: PARALLEL_EXTRACT_URL, key: CANARY, body: { urls: [PUBLIC], advanced_settings: { full_content: { max_chars_per_result: 20_001 } } } }], "one character past the page's text it reads (20,000 by default), so a page Parallel cut shows as cut");
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

test("through Parallel a page is read in parts too: Parallel is asked for one character past the part, and the page's whole length is known only when it gave less", async () => {
  const long = `${"forty-two ".repeat(7_000)}end`;
  const asked = [];
  const send = async (_url, init) => {
    const want = JSON.parse(init.body).advanced_settings.full_content.max_chars_per_result;
    asked.push(want);
    return new Response(JSON.stringify({ results: [{ url: PUBLIC, title: "Long", full_content: long.slice(0, want) }], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const extract = parallelExtract(CANARY, send);
  const first = await webFetch(PUBLIC, { ...network(), parallel: extract });
  assert.deepEqual([first.via, first.text, first.chars, first.truncated, "original_chars" in first, first.next_offset], ["parallel", long.slice(0, 20_000), 20_000, true, false, 20_000], "cut by Parallel at what it was asked for: its whole length unknown");
  assert.equal(where(first), "Characters 0-20000 of a longer page: call web_fetch again with offset=20000 for the rest.");
  const last = await webFetch(PUBLIC, { ...network(), parallel: extract, offset: 60_000, maxChars: 20_000 });
  assert.deepEqual([last.text, last.chars, last.offset, "truncated" in last, last.original_chars], [long.slice(60_000), 10_003, 60_000, false, 70_003], "less than it was asked for: its length is known");
  assert.deepEqual(asked, [20_001, 80_001]);
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
  const later = await webFetch(PUBLIC, { ...network(), fetchImpl, offset: first.next_offset });
  assert.deepEqual(later.links, [], "a later part has none");
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
