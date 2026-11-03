// A web call's one row says what happened in the person's words: what was asked, what came back, where it came from
// and what it cost when it cost anything; its preview has the detail. Every provider answers one normalized search
// result ({provider, via?, query, results?, error?, cost_usd?}; Claude's and Codex's own searches are
// mapped to it before the timeline), so the row has one code path. A search that found nothing is a quiet `missing`;
// one whose provider reports no results at all shows the query and the provider, with no count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runMetricsOf, timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-support.mjs";

const CITE = "Cite the URL of each result you rely on.";
const hit = (url, title = "A page") => ({ url, title, snippet: `About ${title}.\nMore about it.\nAnd more.` });
/** A search's result as a host tool answers it: its JSON, the cite line, and the object as its details. */
const searched = (id, answer, t = 1) => result(id, "web_search", "error" in answer ? JSON.stringify(answer) : `${JSON.stringify(answer)}\n${CITE}`, t, { details: answer, isError: "error" in answer });
const fetched = (id, page, t = 1) => result(id, "web_fetch", JSON.stringify(page), t, { details: page });
const rowOf = (entries) => timelineOf([user("Go.", 0), ...entries], { settled: true }).find((row) => row.kind === "tool_use");
const search = (answer, query = "node lts") => rowOf([assistant([call("s1", "web_search", { query })], 1), searched("s1", answer)]);
const fetch = (page, url = "https://nodejs.org/en/about/previous-releases") => rowOf([assistant([call("f1", "web_fetch", { url })], 1), fetched("f1", page)]);

test("a search's row: its query, how many sources, the first three distinct domains and its provider; the preview lists each result, then the provider", () => {
  const results = [
    hit("https://nodejs.org/en/about/previous-releases", "Node.js Releases"), hit("https://www.nodejs.org/en/blog", "Blog"), hit("https://endoflife.date/nodejs", "Node.js EOL"),
    hit("https://github.com/nodejs/release", "Release schedule"), hit("https://nodejs.org/api", "API"), hit("https://stackoverflow.com/q/1", "A question"),
  ];
  const row = search({ provider: "exa-keyless", query: "node lts", results });
  assert.deepEqual([row.summary, row.tool_status], ['Searched the web for "node lts": 6 sources · nodejs.org, endoflife.date, github.com · Exa keyless', "success"]);
  assert.match(row.tool_result_preview, /^1\. Node\.js Releases — nodejs\.org\nAbout Node\.js Releases\.\nhttps:\/\/nodejs\.org\/en\/about\/previous-releases\n2\. Blog — nodejs\.org\n/);
  assert.doesNotMatch(row.tool_result_preview, /^\{|More about it\./m, "no raw JSON, and one line of each snippet");
  const two = search({ provider: "exa-keyless", query: "node lts", results: results.slice(2, 4) });
  assert.equal(two.tool_result_preview, "1. Node.js EOL — endoflife.date\nAbout Node.js EOL.\nhttps://endoflife.date/nodejs\n2. Release schedule — github.com\nAbout Release schedule.\nhttps://github.com/nodejs/release\nProvider: Exa keyless");
});

test("a running search reads as running; one that found nothing is a quiet missing, never an error", () => {
  const reducer = timelineReducer({ conversationId: 1 });
  reducer.apply([{ type: "message_end", entry: assistant([call("s1", "web_search", { query: "q" })], 1) }]);
  assert.equal(reducer.rows().find((row) => row.kind === "tool_use").summary, 'Searching the web for "q"');
  const entries = [user("Go.", 0), assistant([call("s1", "web_search", { query: "q" })], 1), searched("s1", { provider: "exa-keyless", query: "q", results: [] })];
  const row = timelineOf(entries, { settled: true }).find((r) => r.kind === "tool_use");
  assert.deepEqual([row.summary, row.tool_status], ['Searched the web for "q": no results · Exa keyless', "missing"]);
  assert.deepEqual(runMetricsOf(entries).tools, { web_search: { calls: 1, errors: 0 } });
});

test("a provider's own search that reports no results shows the query and the provider, no count and no missing; an empty list is the real zero", () => {
  const codex = search({ provider: "native", via: "codex", query: "q" }, "q");
  assert.deepEqual([codex.summary, codex.tool_status], ['Searched the web for "q" · Codex\'s own search', "success"]);
  const claude = search({ provider: "native", via: "claude", query: "q", results: [hit("https://x.example/a")], cost_usd: 0.01 }, "q");
  assert.deepEqual([claude.summary, claude.tool_status], ['Searched the web for "q": 1 source · x.example · Claude · $0.01', "success"]);
  const none = search({ provider: "native", via: "claude", query: "q", results: [] }, "q");
  assert.deepEqual([none.summary, none.tool_status], ['Searched the web for "q": no results · Claude', "missing"]);
});

test("a search that failed says why in our words: free search rate-limited names the fix", () => {
  const limited = search({ error: "Exa's keyless search is rate-limited (429); it says to wait 30 s: answer without searching, or try later" }, "q");
  assert.deepEqual([limited.summary, limited.tool_status], ['Searched the web for "q": free search is rate-limited, add a Parallel key in Settings → Tool keys', "failed"]);
  const timeout = search({ error: "Exa's search did not answer within 60 s" }, "q");
  assert.deepEqual([timeout.summary, timeout.tool_status], ['Searched the web for "q": failed, Exa\'s search did not answer within 60 s', "failed"]);
});

test("a page's row: its host and path, its title and the size of the text kept; running it is being read", () => {
  const page = { ok: true, url: "https://nodejs.org/en/about/previous-releases", status: 200, title: "Node.js Releases", text: "x".repeat(12_288), links: [], via: "direct" };
  const row = fetch(page);
  assert.deepEqual([row.summary, row.tool_status], ['Read nodejs.org/en/about/previous-releases: "Node.js Releases" · 12 KB', "success"]);
  assert.equal(fetch({ ...page, text: "short", chars: 12_288 }).summary, 'Read nodejs.org/en/about/previous-releases: "Node.js Releases" · 12 KB', "the result's own count of characters, when it gives one");
  assert.equal(fetch({ ...page, via: "parallel" }).summary, 'Read nodejs.org/en/about/previous-releases: "Node.js Releases" · 12 KB · via Parallel');
  assert.equal(fetch({ ...page, text: "x".repeat(60_000), truncated: true, original_chars: 312_450 }).summary, 'Read nodejs.org/en/about/previous-releases: "Node.js Releases" · first 60,000 of 312,450 characters');
  const reducer = timelineReducer({ conversationId: 1 });
  reducer.apply([{ type: "message_end", entry: assistant([call("f1", "web_fetch", { url: "https://nodejs.org/en/about/previous-releases" })], 1) }]);
  assert.equal(reducer.rows().find((r) => r.kind === "tool_use").summary, "Reading nodejs.org/en/about/previous-releases");
});

test("a page that was not read says why: refused by the guard, an HTTP error, a timeout; each a failure", () => {
  const refused = fetch({ ok: false, url: "http://127.0.0.1/", status: 0, title: "", text: "", links: [], refused: "refused: 127.0.0.1 is not a public host" }, "http://127.0.0.1/");
  assert.deepEqual([refused.summary, refused.tool_status], ["Read 127.0.0.1: refused, 127.0.0.1 is not a public host", "failed"]);
  const missing = fetch({ ok: true, url: "https://x.example/gone", status: 404, title: "Not Found", text: "gone", links: [], via: "direct" }, "https://x.example/gone");
  assert.deepEqual([missing.summary, missing.tool_status], ["Read x.example/gone: 404 Not Found", "failed"]);
  const slow = fetch({ ok: false, url: "https://x.example/slow", status: 0, title: "", text: "", links: [], error: "timed out after 15000 ms" }, "https://x.example/slow");
  assert.deepEqual([slow.summary, slow.tool_status], ["Read x.example/slow: timed out after 15 s", "failed"]);
});
