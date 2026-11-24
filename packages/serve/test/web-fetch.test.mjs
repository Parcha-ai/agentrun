// web_fetch as serve runs it: web's webFetch (@parcha/agentrun-web) bound to serve's guard and log, its provider taken
// from the run's plane (fetchFor), its Parallel requests booked on the run's ledger, and the agent's tool and a call
// node's sharing the run's pages. Parallel is the tests' fake (fixtures/faux-parallel.mjs) and the network a table
// (fixtures/fake-network.mjs): no socket, no real key. web's own cases (parts, Parallel's extract, the run's pages) are
// packages/web/test/web-fetch.test.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { PARALLEL_EXTRACT_USD } from "@parcha/agentrun-web";
import { fetchFor, parallelExtract, webFetch } from "../dist/web-fetch.js";
import { bookedIn } from "../dist/paid-calls.js";
import { CANARY } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { TOOLS } from "../dist/tools.js";
import { follow, paidBookings, scratch, serve, toolLedger, withEnv } from "./support.mjs";

const pages = { ...(await import("@parcha/agentrun-web")), ...(await import("../dist/web-fetch-direct.js")) };
const web = { ...(await import("@parcha/agentrun-web")), ...(await import("../dist/web-fetch.js")) };

const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;
const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const MODE = "AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT";
const PUBLIC = "http://public.example/";

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

test("a fetched URL with an apostrophe in its path shows no query value on its timeline row: the preview the API serves scrubs the query after the apostrophe too", { timeout: 60_000 }, async (t) => {
  await calls(t, false);
  const { api } = await serve(t, { fauxWeb: FAUX_WEB, fauxParallel: FAUX_PARALLEL });
  assert.equal((await api("POST", "/agents", { definition: { id: "quoted", name: "quoted", instructions: "Read.", tools: ["web_fetch"] } })).status, 201);
  const asked = "http://public.example/O'Reilly?token=held-query-value";
  const started = await api("POST", "/agents/quoted/runs", { input: { content: `Fetch these pages with web_fetch: ${JSON.stringify([asked])}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"]);
  const results = rows.filter((row) => row.kind === "tool_result").map((row) => row.tool_result_preview);
  assert.equal(results.length, 1, JSON.stringify(results));
  assert.ok(results[0].includes(`"url":"http://public.example/O'Reilly?token=…"`), results[0]);
  // The person's own message keeps its URL whole; every row of the call scrubs it.
  const tools = JSON.stringify(rows.filter((row) => row.kind.startsWith("tool")));
  assert.equal(tools.includes("held-query-value"), false, tools);
});

/** The line after a page's JSON that tells the model where it is in the page, if any. */
const where = (page, name = "web_fetch") => web.webFetchText(page, name).slice(JSON.stringify(page).length + 1) || undefined;

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

test("web_fetch takes its provider from the run's plane: none or kernel is the direct fetch, a pick with no key a failed page saying so, never a fetch of another kind", async () => {
  const plane = (web_fetch) => ({ AGENTRUN_SERVE_TOOL_PLANE: JSON.stringify({ web_fetch }) });
  for (const env of [{}, plane("kernel")]) {
    const net = network();
    const page = await fetchFor(env, PUBLIC, net);
    assert.deepEqual([page.via, "parallel" in page, net.dialled], ["direct", false, [PUBLIC]], "a kernel fetch says nothing of Parallel");
  }
  const net = network();
  assert.deepEqual(await fetchFor(plane("unavailable: parallel picked, no PARALLEL_API_KEY"), PUBLIC, net), { ok: false, url: PUBLIC, status: 0, title: "", text: "", links: [], error: "web_fetch does not run here: parallel is picked, and it needs a Parallel key: save one in Settings → API Keys (or set PARALLEL_API_KEY where the server starts)" }, "no via: nothing was read");
  assert.deepEqual(net.dialled, [], "nothing fetched");
});

/** Call `call`'s ledger on the run's one ledger `paid` (capped, so a hold is held at its price), and what it booked
 *  there: [kind, call, the held or charged USD]. */
function recording(paid, call) {
  return { ledger: { call, paid }, rows: async () => paidBookings(await paid.records()).filter((row) => row.call === call).map((row) => [row.kind, row.call, row.heldUsd ?? row.usd]) };
}
const BOOKED = (call) => [["agentrun.tool_started", call, PARALLEL_EXTRACT_USD], ["agentrun.tool_cost", call, PARALLEL_EXTRACT_USD]];

test("a page through Parallel is one booked extract a run, at $0.001: three parts in three calls book it once, in the call that read it, and the parts from what the run read book nothing", async () => {
  const long = `${"booked ".repeat(8_000)}end`;
  const { asked, send } = paging(() => ({ text: long }));
  const extract = parallelExtract(CANARY, send);
  const held = new Map();
  const paid = await toolLedger(1);
  const calls = ["c1", "c2", "c3"].map((call) => recording(paid, call));
  const parts = [];
  for (const [n, { ledger }] of calls.entries()) parts.push(await bookedIn(ledger, () => webFetch(PUBLIC, { ...network(), parallel: extract, pages: held, offset: n * 20_000 })));
  assert.deepEqual(parts.map((page) => page.via), ["parallel", "parallel", "parallel"]);
  assert.deepEqual(asked, [1_000_001], "one extract");
  assert.deepEqual(await Promise.all(calls.map((call) => call.rows())), [BOOKED("c1"), [], []], "booked once, at Parallel's price for one URL, in the first call");
});

test("two calls for one page at once: one extract, booked once, in the call whose read the other shares; and so when the first call stops before the page is read", async () => {
  const text = `${"shared ".repeat(3_000)}end`;
  const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const stopFirst of [false, true]) {
    const asked = [];
    const send = async (_url, init) => {
      asked.push(JSON.parse(init.body).advanced_settings.full_content.max_chars_per_result);
      await later(150);
      return new Response(JSON.stringify({ results: [{ url: PUBLIC, title: "Shared", full_content: text }], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const extract = parallelExtract(CANARY, send);
    const held = new Map();
    const paid = await toolLedger(1);
    const [first, second] = ["c1", "c2"].map((call) => recording(paid, call));
    const soon = new AbortController();
    const [a, b] = await Promise.all([
      bookedIn(first.ledger, () => webFetch(PUBLIC, { ...network(), parallel: extract, pages: held, ...(stopFirst ? { signal: soon.signal } : {}) })),
      later(10).then(() => bookedIn(second.ledger, () => webFetch(PUBLIC, { ...network(), parallel: extract, pages: held }))),
      stopFirst ? later(40).then(() => soon.abort()) : undefined,
    ]);
    // The first call's read settles after it returned when it stopped: wait for the read the run keeps.
    await held.get(PUBLIC);
    const what = stopFirst ? "the first call stopped" : "both waited";
    assert.deepEqual([a.ok, b.ok], [!stopFirst, true], what);
    assert.deepEqual(asked, [1_000_001], `${what}: one extract`);
    assert.deepEqual([await first.rows(), await second.rows()], [BOOKED("c1"), []], `${what}: booked once, in the call that started the read`);
  }
});

// Moved from cap-models.test.mjs, onto the run's one ledger: the extract's hold is the run's RunTools step, and the model
// request beside it is judged by the same run's rule (kernel runCap.before).
test("under a cap, a page's one Parallel extract is held on the run's ledger as any Parallel request: a model request that fits only without its $0.001 waits while the read is under way, is refused once the read is charged its $0.001, and the page's later parts hold and ask nothing", async (t) => {
  // A model at $1 a million input tokens: 1,000 tokens in is $0.001, which a $0.0015 cap holds beside nothing else.
  const paid = await toolLedger(0.0015, { model: { id: "m", api: "anthropic", price: { input: 1, output: 0 }, outputCeiling: 100 } });
  let arrived, release;
  const reached = new Promise((resolve) => (arrived = resolve));
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const asked = [];
  const text = `${"capped ".repeat(6_000)}end`;
  const send = async (_url, init) => {
    asked.push(JSON.parse(init.body).advanced_settings.full_content.max_chars_per_result);
    arrived();
    await held;
    return new Response(JSON.stringify({ results: [{ url: PUBLIC, title: "Capped", full_content: text }], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const ledger = { call: "c1", paid };
  const extract = parallelExtract(CANARY, send);
  const pages = new Map();
  const net = network();
  const first = bookedIn(ledger, () => webFetch(PUBLIC, { ...net, parallel: extract, pages: pages }));
  await reached;
  // It would fit once the extract's hold settles (the cap's wait for room): it waits for it, neither sent nor refused.
  let answered = false;
  const beside = paid.modelRequest(1_000).then((verdict) => ((answered = true), verdict));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(answered, false, "the model request waits while the extract is under way");
  assert.ok(Math.abs(paid.heldUsd() - PARALLEL_EXTRACT_USD) < 1e-12, `the extract held at its fee: ${paid.heldUsd()}`);
  release();
  assert.equal((await first).via, "parallel");
  // The extract is charged its whole $0.001: spent, it leaves no room, so the request that waited is refused then.
  const refused = await beside;
  assert.ok(refused && "refuse" in refused && !refused.waits, `refused once the extract was charged: ${JSON.stringify(refused)}`);
  const later = await bookedIn(ledger, () => webFetch(PUBLIC, { ...net, parallel: extract, pages: pages, offset: 20_000 }));
  assert.deepEqual([later.via, later.offset, asked], ["parallel", 20_000, [1_000_001]], "a later part from what the run read: no request");
  assert.deepEqual(paidBookings(await paid.records()).map((row) => [row.kind, row.heldUsd ?? row.usd]), [["agentrun.tool_started", PARALLEL_EXTRACT_USD], ["agentrun.tool_cost", PARALLEL_EXTRACT_USD]], "held and charged once");
});
