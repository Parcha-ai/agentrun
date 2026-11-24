// A held value split across two strings of a web call's JSON (#3626's follow-up): withheld by a redactor that does not
// know its values when the strings' join is longer than one 8,192-character piece; read in the order the text is written
// as well as the order its object reads (an integer-like name, a name written twice); and withheld through the two
// reads that render a run's rows from the store (run-timeline-served.ts, store-view.ts), which pass the join check on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { redacted, redactedAnswer, redactedCall, withheldWhole } from "../dist/key-refusal.js";
import { answersCut } from "../dist/runner/adapter-run-spec.js";
import { secretRedactor } from "../dist/runner/redact.js";
import { CALL_RESULT_CHARS, namesTried, scrubUrls, timelineOf, webCut, webShownOf } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-lib-support.mjs";
import { storeOn, T0 } from "./store-helpers.mjs";

const { servedTimelineRows } = await import("../dist/run-timeline-served.js");
const { timelineOverStore } = await import("../dist/store-view.js");

// A held value of 32 characters in no secret's shape, made at runtime, and its two halves.
const [HEAD, REST] = [["Zq8V", "bN3x", "LmT6", "pR2w"].join(""), ["Yk9H", "sD4f", "Gj7A", "c5Ue"].join("")];
const KEY = `${HEAD}${REST}`;
const URL_A = "https://h.example/a";
const search = (title, snippet, url = URL_A) => JSON.stringify({ query: "q", results: [{ url, title, snippet }] });
const context = { callId: "c1", signal: new AbortController().signal };
const tool = (text, name = "web_search") => ({ name, description: "", inputSchema: {}, replay: "safe", call: async () => ({ text }) });
const stored = async (text, cut) => (await answersCut(tool(text), cut).call({}, context)).text;
/** The run's redactor as a plain function: it cuts `KEY` but does not say so (no heldValues). */
const plain = (text) => redactedAnswer(text, [KEY]);

/** A search answer whose values, joined by line breaks (query, url, title, snippet: the join webHeld reads), put the line
 *  break between its title and its snippet at `at`: the title's last word `tail`, the snippet's first `head`, then 120
 *  characters with no whitespace and about 12k more, so the join runs past 22k characters. */
function longSearch(at, tail, head) {
  const lead = `q\n${URL_A}\n`.length;
  const pad = at - lead - `see ${tail}`.length;
  assert.ok(pad > 0 && pad % 2 === 0, `the title's padding fits: ${pad}`);
  const title = `${"w ".repeat(pad / 2)}see ${tail}`;
  const snippet = `${head}${"x".repeat(120)} ${"v ".repeat(6000)}`;
  const joined = ["q", URL_A, title, snippet].join("\n");
  assert.equal(joined.indexOf("\n", lead), at);
  return { text: search(title, snippet), joined };
}

test("a redactor that does not know its values withholds a long web answer whose held value is split across two strings inside one piece of the join, or across a piece's edge", async () => {
  // Inside one piece: the second piece (from about 8,192 to 16,384) holds the split whole. Read in pieces, the redactor
  // withholds that piece alone, so its cut of the join is not "[redacted]", though it took the value.
  const inside = longSearch(10_000, HEAD, REST);
  const read = plain(inside.joined);
  assert.notEqual(read, "[redacted]");
  assert.ok(read.includes("[redacted]") && !read.includes(HEAD), "the piece holding the split is withheld by itself");
  assert.equal(await stored(inside.text, plain), "[redacted]", "the stored answer is withheld");
  // Across the first piece's edge: the line break between the halves is the last whitespace before 8,192, so the first
  // piece ends there; the pass over the joined pieces finds the value and withholds the join whole.
  const edge = longSearch(8150, HEAD, REST);
  assert.equal(plain(edge.joined), "[redacted]");
  assert.equal(await stored(edge.text, plain), "[redacted]", "the stored answer is withheld");
  // A redactor that knows its values reads the join whole (withheldWhole): both are withheld its way too.
  for (const { text, joined } of [inside, edge]) {
    assert.equal(withheldWhole(joined, [KEY]), true);
    assert.equal(await stored(text, secretRedactor([KEY])), "[redacted]");
  }
});

test("a redactor that does not know its values keeps a long web answer with no split value as its JSON: a held value whole in one string is cut in place, every url kept", async () => {
  // The same 22k layout with no value split across strings: its JSON parses, its url and snippet are whole.
  const clean = longSearch(10_000, "q1", "r1");
  const kept = JSON.parse(await stored(clean.text, plain));
  assert.equal(kept.results[0].url, URL_A);
  assert.equal(kept.results[0].snippet, JSON.parse(clean.text).results[0].snippet);
  // A held value whole inside the title, inside the join's second piece: cut there, the rest kept.
  const whole = longSearch(10_000, KEY, "r1");
  const cut = JSON.parse(await stored(whole.text, plain));
  assert.equal(cut.results[0].url, URL_A);
  assert.ok(cut.results[0].title.endsWith("see [redacted]") && !cut.results[0].title.includes(HEAD), cut.results[0].title.slice(-40));
});

/** A call's tool_result row as a served read shows it (run-timeline-served.ts): the rows' redactor, the strings' join read
 *  (`holds`), and with `calls` redactedCall per string. */
const resultRowOf = (text, calls) => {
  const options = { redact: (part) => redacted(part, [KEY]), holds: (joined) => withheldWhole(joined, [KEY]), ...(calls ? { calls: { result: CALL_RESULT_CHARS, redact: (part) => redactedCall(part, [KEY], CALL_RESULT_CHARS, scrubUrls) } } : {}) };
  const rows = timelineOf([user("Run it."), assistant([call("c1", "web_search", { query: "q" })]), result("c1", "web_search", text)], options);
  return rows.find((row) => row.kind === "tool_result" && row.tool_use_id === "c1");
};

/** A web_search answer written by hand, so its names stay in the order written: `hit`'s members, each [name, value]. */
const written = (hit) => `{"query":"q","results":[{${hit.map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`).join(",")}}]}`;

test("a held value split across two strings side by side as the text is written, not as its object reads (an integer-like name, a name written twice), withholds the row's preview, a calls read and the stored answer", async () => {
  const cases = {
    // Object.entries reads "7" first: as the object reads, the halves are apart; as written, side by side.
    "integer-like name": written([["url", URL_A], ["title", "t"], ["z", `see ${HEAD}`], ["7", `${REST} more`]]),
    // JSON.parse keeps the second "title" alone: the first, with the value's head, is in the text only.
    "name written twice": written([["url", URL_A], ["title", `see ${HEAD}`], ["snippet", `${REST} more`], ["title", "t"]]),
  };
  for (const [what, text] of Object.entries(cases)) {
    // The text as written holds both halves, a quote and a name between them: the preview, read as it came, showed them.
    assert.ok(text.includes(HEAD) && text.includes(REST), what);
    assert.equal(resultRowOf(text, false).tool_result_preview, "[redacted]", `${what}: the preview`);
    const row = resultRowOf(text, true);
    assert.equal(row.tool_result_preview, "[redacted]", `${what}: the preview, with calls`);
    assert.equal(row.tool_result_text, "[redacted]", `${what}: the calls read`);
    assert.ok(!row.summary.includes(HEAD) && !row.summary.includes(REST), `${what}: ${row.summary}`);
    assert.equal(await stored(text, secretRedactor([KEY])), "[redacted]", `${what}: the stored answer`);
    assert.equal(await stored(text, plain), "[redacted]", `${what}: the stored answer, a redactor that does not know its values`);
  }
});

test("a held value split across two strings side by side as the object reads, not as written (an integer-like name moved first), still withholds the stored answer and the calls read", async () => {
  // As written, the halves are apart (REST first); as the object reads, and as JSON.stringify writes it back, "5" comes
  // first and the halves sit side by side.
  const text = written([["title", `${REST} more`], ["5", `see ${HEAD}`], ["url", URL_A]]);
  assert.equal(await stored(text, secretRedactor([KEY])), "[redacted]");
  assert.equal(resultRowOf(text, true).tool_result_text, "[redacted]");
});

test("a web call's property names that cut to one are all kept, the later ones numbered from the lowest free number, a name already written so kept as written", () => {
  // `cut` makes every name that starts with "k" one name; "[redacted] (2)" is written so in the answer.
  const cut = (text) => (text.startsWith("k") ? "[redacted]" : text);
  const text = written([["url", URL_A], ["k1", "a"], ["[redacted] (2)", "b"], ["k2", "c"], ["k3", "d"], ["k4", "e"]]);
  const hit = JSON.parse(webCut("web_search", text, cut)).results[0];
  assert.deepEqual(Object.entries(hit), [["url", URL_A], ["[redacted]", "a"], ["[redacted] (2)", "b"], ["[redacted] (3)", "c"], ["[redacted] (4)", "d"], ["[redacted] (5)", "e"]]);
  // Many names that cut to one: each kept, each number once.
  const many = written([["url", URL_A], ...Array.from({ length: 3000 }, (_, i) => [`k${i}`, `v${i}`])]);
  const names = Object.keys(JSON.parse(webCut("web_search", many, cut)).results[0]);
  assert.equal(names.length, 3001);
  assert.equal(new Set(names).size, 3001);
  assert.equal(names.at(-1), "[redacted] (3000)");
});

test("a fetched page's names that read as one once their URLs' query values are elided cost one try each, not one per earlier name", () => {
  // Any page can write these: no held value is needed, the timeline's read elides each name's query value (scrubUrls).
  const names = 3000;
  const page = JSON.stringify({ url: URL_A, title: "t", text: "x", ...Object.fromEntries(Array.from({ length: names }, (_, i) => [`https://pages.invalid/a?q=${i}`, i])) });
  namesTried.count = 0;
  const shown = webShownOf("web_fetch", page, scrubUrls);
  assert.ok(shown);
  assert.equal(Object.keys(JSON.parse(shown(100))).filter((name) => name.startsWith("https://pages.invalid/")).length, names);
  // Counted from 2 for each name, the n-th tries n names: about names²/2 in all.
  assert.ok(namesTried.count <= 3 * (names + 3), `${namesTried.count} names tried for ${names + 3} names, over ${3 * (names + 3)}`);
});

/** A store holding run-1, whose journal is one web_search call answered `text`, then a final answer. */
async function webRun(t, text) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Search." }, title: "Search", place: { mode: "runner" } } });
  const journal = store.journal(await store.claim("run-1", "runner-a", { leaseMs: 60_000 }));
  const entry = async (kind, model) => ({ id: await journal.mintId(), conversationId: 1, kind, model: [{ ...model, timestamp: T0 }] });
  const entries = [
    await entry("pi.user", { role: "user", content: "Search." }),
    await entry("pi.assistant", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "web_search", arguments: { query: "q" } }] }),
    await entry("pi.tool-result", { role: "toolResult", toolCallId: "c1", toolName: "web_search", content: [{ type: "text", text }], isError: false }),
    await entry("pi.assistant", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] }),
  ];
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }, ...entries.map((value) => ({ type: "entry", value }))], BACKGROUND_CONTEXT);
  return store;
}

/** The run's rows as each store read renders them, the server holding `secrets`: the served timeline, with and without
 *  `calls`, and the run view's rows. */
async function storeReads(store, secrets) {
  const served = { serverSecrets: () => secrets, keyEnv: () => ({}) };
  return {
    "served timeline": await servedTimelineRows(served, store, "run-1", BACKGROUND_CONTEXT),
    "served timeline, calls": await servedTimelineRows(served, store, "run-1", BACKGROUND_CONTEXT, true),
    "run view": await timelineOverStore(store, "run-1", { origin: "https://run.test", serverSecrets: () => secrets }),
  };
}
const resultRow = (rows) => rows?.find((row) => row.kind === "tool_result" && row.tool_use_id === "c1");

test("the served timeline and the run view withhold a web call's result whose held value is split across two of its strings, in every row", async (t) => {
  const store = await webRun(t, search(`see ${HEAD}`, `${REST} more`));
  // The plant reaches each read's rows: with no held value, the halves show.
  for (const [what, rows] of Object.entries(await storeReads(store, []))) {
    assert.ok(resultRow(rows)?.tool_result_preview?.includes(HEAD), `${what}: the result row shows the plant when nothing is held`);
  }
  for (const [what, rows] of Object.entries(await storeReads(store, [KEY]))) {
    const row = resultRow(rows);
    assert.equal(row?.tool_result_preview, "[redacted]", `${what}: the preview`);
    if (what.endsWith("calls")) assert.equal(row.tool_result_text, "[redacted]", `${what}: the calls read`);
    const all = JSON.stringify(rows);
    assert.ok(!all.includes(HEAD) && !all.includes(REST), `${what}: no row shows a half`);
  }
});

test("the served timeline and the run view cut a held value whole in one string of a web call's result in place: the row keeps its JSON and url", async (t) => {
  const store = await webRun(t, search(`see ${KEY}`, `${REST} more`));
  for (const [what, rows] of Object.entries(await storeReads(store, [KEY]))) {
    const preview = resultRow(rows)?.tool_result_preview ?? "";
    assert.ok(preview.startsWith('{"query":"q"') && preview.includes("see [redacted]") && !preview.includes(HEAD), `${what}: ${preview}`);
  }
});
