// A read for a grader (`calls`, tool_result_text) shows every row a web_search answered, its url, title and published
// date whole, and a web_fetch's url and title whole: only snippets and page text give way to CALL_RESULT_CHARS. A run
// that cites its search's 9th result is graded on a result that holds that result's url. Other tools' outputs are cut
// at their head as before, and every text still goes through the run's redaction, its URLs' query values elided.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CALL_RESULT_CHARS, timelineOf } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-lib-support.mjs";

const CITE = "Cite the URL of each result you rely on.";
/** A held key, made at runtime: no credential-shaped literal for the source export. */
const KEY = ["not-a-secret", "held-web-key", "0123456789ab"].join("-");
const redact = (text) => text.split(KEY).join("[redacted]");
const options = { calls: { result: CALL_RESULT_CHARS, redact } };

/** Ten results, each with a snippet of about 3,000 characters, as web_search answers them (searchText). */
const hits = Array.from({ length: 10 }, (_, i) => ({ url: `https://vendor.example/customers/story-${i + 1}`, title: `Customer story ${i + 1}`, snippet: `Story ${i + 1}: ${"the team closed its books faster ".repeat(94)}`, published: `2026-0${(i % 9) + 1}-01` }));
const searchText = (search) => `${JSON.stringify(search)}\n${CITE}`;
const rowOf = (rows, kind = "tool_result") => rows.find((row) => row.kind === kind && row.tool_use_id === "c1");

test("a web_search's ten long results: every url, title and date whole, its snippets cut to fit, so its 9th result's url is in the row", () => {
  const search = { provider: "parallel", query: "ramp customers", results: hits };
  const text = searchText(search);
  assert.ok(text.length > 3 * CALL_RESULT_CHARS, String(text.length));
  const rows = timelineOf([user("Find customer stories."), assistant([call("c1", "web_search", { query: "ramp customers" })]), result("c1", "web_search", text)], options);
  const shown = rowOf(rows).tool_result_text;
  assert.ok(shown.length <= CALL_RESULT_CHARS, String(shown.length));
  assert.ok(shown.includes("https://vendor.example/customers/story-9"), shown);
  const [json, ...after] = shown.split("\n");
  assert.deepEqual(after, [CITE]);
  const read = JSON.parse(json);
  assert.deepEqual(read.results.map(({ url, title, published }) => ({ url, title, published })), hits.map(({ url, title, published }) => ({ url, title, published })));
  assert.equal(read.query, "ramp customers");
  for (const [i, hit] of read.results.entries()) {
    assert.ok(hit.snippet.length < hits[i].snippet.length && hit.snippet.endsWith("…"), hit.snippet);
    assert.ok(hits[i].snippet.startsWith(hit.snippet.slice(0, -1)), "a snippet keeps its head");
  }
  // Each snippet keeps as much as the room leaves: the same length each, the room nearly filled.
  assert.equal(new Set(read.results.map((hit) => hit.snippet.length)).size, 1);
  assert.ok(shown.length > CALL_RESULT_CHARS - 200, String(shown.length));
});

test("a search that fits is served as it came, and one whose rows alone pass the room keeps every url, with no snippet", () => {
  const small = searchText({ provider: "parallel", query: "q", results: hits.slice(0, 2).map((hit) => ({ ...hit, snippet: "short" })) });
  const rows = timelineOf([user("Search."), assistant([call("c1", "web_search", { query: "q" })]), result("c1", "web_search", small)], options);
  assert.equal(rowOf(rows).tool_result_text, small);
  // 25 results whose titles are long: their rows alone pass the room, and are all shown, every snippet cut to nothing.
  const many = Array.from({ length: 25 }, (_, i) => ({ ...hits[i % 10], url: `https://vendor.example/customers/long-${i + 1}`, title: `${"A long page title ".repeat(25)}${i + 1}` }));
  const wide = timelineOf([user("Search."), assistant([call("c1", "web_search", { query: "q", n: 25 })]), result("c1", "web_search", searchText({ provider: "parallel", query: "q", results: many }))], options);
  const shown = rowOf(wide).tool_result_text;
  assert.ok(shown.length > CALL_RESULT_CHARS, String(shown.length));
  const read = JSON.parse(shown.split("\n")[0]);
  assert.deepEqual(read.results.map((hit) => [hit.url, hit.title]), many.map((hit) => [hit.url, hit.title]));
  assert.ok(read.results.every((hit) => hit.snippet === "…"), JSON.stringify(read.results[0]));
});

test("a web_fetch's long page: its url and title whole, its text cut, the line after its JSON kept", () => {
  const page = { ok: true, url: "https://vendor.example/blog/switched", status: 200, title: "Customers who switched", text: `# Customers who switched\n\n${"Each team moved its cards over in a week. ".repeat(800)}`, chars: 33_600, truncated: true, original_chars: 90_000, offset: 0, next_offset: 33_600, links: Array.from({ length: 40 }, (_, i) => `https://vendor.example/customers/linked-${i + 1}`), via: "parallel" };
  const where = "Characters 0-33600 of 90000: call web_fetch again with offset=33600 for the rest.";
  const rows = timelineOf([user("Read it."), assistant([call("c1", "web_fetch", { url: page.url })]), result("c1", "web_fetch", `${JSON.stringify(page)}\n${where}`)], options);
  const shown = rowOf(rows).tool_result_text;
  assert.ok(shown.length <= CALL_RESULT_CHARS, String(shown.length));
  const [json, line] = shown.split("\n");
  assert.equal(line, where);
  const read = JSON.parse(json);
  assert.deepEqual([read.url, read.title, read.status, read.next_offset], [page.url, page.title, 200, 33_600]);
  assert.ok(read.text.length < page.text.length && read.text.endsWith("…") && page.text.startsWith(read.text.slice(0, -1)));
  assert.deepEqual(read.links, page.links, "its links fit beside the text cut to the same length");
  // Room for little: its links give way with its text, those cut counted.
  const small = timelineOf([user("Read it."), assistant([call("c1", "web_fetch", { url: page.url })]), result("c1", "web_fetch", JSON.stringify(page))], { calls: { result: 1200, redact } });
  const cut = JSON.parse(rowOf(small).tool_result_text);
  assert.ok(cut.links.length < 40 && cut.links.length + cut.links_cut === 40, JSON.stringify([cut.links.length, cut.links_cut]));
  assert.deepEqual([cut.url, cut.title], [page.url, page.title]);
});

test("a web call's output still goes through the run's redaction and its URLs' query values are elided; another tool's is cut at its head as before", () => {
  const leaky = hits.map((hit, i) => (i === 8 ? { ...hit, url: `${hit.url}?token=${KEY}`, snippet: `${KEY} ${hit.snippet}` } : hit));
  const rows = timelineOf([user("Search."), assistant([call("c1", "web_search", { query: "q" })]), result("c1", "web_search", searchText({ provider: "parallel", query: "q", results: leaky }))], options);
  const shown = rowOf(rows).tool_result_text;
  assert.ok(!shown.includes(KEY), shown);
  assert.ok(shown.includes("https://vendor.example/customers/story-9?token=…"), shown);
  const bash = "x".repeat(CALL_RESULT_CHARS * 2);
  const other = timelineOf([user("Run it."), assistant([call("c1", "bash", { command: "yes" })]), result("c1", "bash", bash)], options);
  assert.equal(rowOf(other).tool_result_text, `${"x".repeat(CALL_RESULT_CHARS - 3)}...`);
  // An output that is not its tool's JSON (a search's error words) is cut at its head, as any other.
  const words = timelineOf([user("Search."), assistant([call("c1", "web_search", { query: "q" })]), result("c1", "web_search", `not json ${"y".repeat(CALL_RESULT_CHARS)}`)], options);
  assert.equal(rowOf(words).tool_result_text.length, CALL_RESULT_CHARS);
});
