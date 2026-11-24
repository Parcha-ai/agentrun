// web_fetch's looking_for (FetchOptions.lookingFor): the agent says what it is looking for, the decider scores the
// chunks of the whole page (read once a run, from the run's pages after), and the answer holds the FOUND_CHUNKS chunks
// most likely to hold it, in page order, each at its offset in the page. The decider is asked its usual judge request,
// with the agent's need as the task. Without looking_for nothing changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as web from "../dist/index.js";
import { deciderFrom, judgeRequest, passagesOf, PAGE_CHARS, QUERY_MAX, webFetchText } from "../dist/index.js";
import { decideWeb, pagesOf, PUBLIC, scoringProvider, TASK } from "./fixtures/decide-runs.mjs";

const NEED = "the year Widgets, Inc. was registered";
/** `n` paragraphs, each its own chunk: a two-digit number, then letters to 990 characters, and a blank line. */
const pageOf = (n) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(2, "0")} ${"x".repeat(987)}\n\n`).join("");
const TWELVE = pageOf(12);
const THIRTY = pageOf(30);
/** p5 the likeliest, then p11, p2, p9; p7 refused; every other chunk 0.1. */
const SCORES = { p5: 0.95, p11: 0.9, p2: 0.8, p9: 0.6, p7: { type: "refusal" } };
const scores = (n) => ({ ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i + 1}`, 0.1])), ...SCORES });
const priced = (provider) => deciderFrom(provider, { price: { requestUsd: 0.0002 } });
const broken = { id: "fake", needs: [], decide: async () => { throw Object.assign(new Error("down"), { code: "provider_error" }); } };
const SHOWN = "fake showed the 8 of 12 chunks of the page most likely to hold what you are looking for, in page order; to read on from one, call web_fetch with its offset and no looking_for";

/** A web on the fakes whose decider scores as `table` says, reading `content` as the page; `asked` its requests, and
 *  `extracts` how many times the page was read. */
function lookingWeb(content, table, extra = {}) {
  const { asked, provider } = scoringProvider(table);
  const counted = { extracts: 0 };
  const pages = pagesOf(content);
  const send = async (url, init) => (new URL(String(url)).pathname === "/v1/extract" && counted.extracts++, pages(url, init));
  return { asked, counted, web: decideWeb({ decider: priced(provider), send: { parallel: send }, ...extra }) };
}

const chunksOf = (text) => passagesOf(text, web.FIND_CHUNKS_MAX);

test("with looking_for the decider scores the chunks of the whole page, whatever part was asked, with the agent's need as the task", async () => {
  const { asked, web: w } = lookingWeb(THIRTY, scores(30));
  await w.fetch(PUBLIC, { lookingFor: NEED, maxChars: 500, offset: 0, task: TASK });
  const chunks = chunksOf(THIRTY).map(([s, e]) => THIRTY.slice(s, e));
  assert.equal(chunks.length, 30);
  assert.deepEqual(asked.map(({ request }) => request), [judgeRequest(PUBLIC, NEED, chunks)], "the usual judge request: the need is looking_for, not the task");
  const long = lookingWeb(THIRTY, scores(30));
  await long.web.fetch(PUBLIC, { lookingFor: `  ${"y".repeat(QUERY_MAX + 50)}  ` });
  assert.equal(long.asked[0].request.state.task, "y".repeat(QUERY_MAX - 1) + "…", "trimmed, and cut at QUERY_MAX");
});

test("the answer holds the FOUND_CHUNKS likeliest chunks in page order, each at its offset, a refused one last; the record scores every chunk", async () => {
  assert.equal(web.FOUND_CHUNKS, 8);
  const { web: w } = lookingWeb(TWELVE, scores(12));
  const { answer, receipt } = await w.fetch(PUBLIC, { lookingFor: NEED });
  const spans = chunksOf(TWELVE);
  // p5, p11, p2, p9, then four of the 0.1s in page order (p1, p3, p4, p6); p7, refused, comes after every scored one.
  const shown = [1, 2, 3, 4, 5, 6, 9, 11];
  assert.deepEqual(answer.found, shown.map((n) => ({ offset: spans[n - 1][0], text: TWELVE.slice(...spans[n - 1]) })));
  assert.equal(answer.sift, SHOWN);
  assert.deepEqual([answer.ok, answer.url, answer.title, answer.via, answer.text], [true, PUBLIC, "Long", "parallel", undefined]);
  const record = receipt.classifier;
  assert.deepEqual([record.ran, record.op, record.items, record.dropped], [true, "fetch", { in: 12, kept: 8 }, []]);
  assert.deepEqual(record.scored.map((item) => [item.id, item.score, item.at]), spans.map((at, i) => [`p${i + 1}`, i === 6 ? null : scores(12)[`p${i + 1}`], at]));
});

test("a found chunk past the first part names the offset that reads on from it", async () => {
  const { web: w } = lookingWeb(THIRTY, { ...scores(30), p25: 0.99 });
  const { answer } = await w.fetch(PUBLIC, { lookingFor: NEED });
  const far = answer.found.find((chunk) => chunk.text.startsWith("25 "));
  assert.ok(far.offset > PAGE_CHARS, String(far.offset));
  const onward = await w.fetch(PUBLIC, { offset: far.offset });
  assert.ok(onward.answer.text.startsWith(far.text), "the part at that offset begins with the chunk");
  assert.equal(answer.original_chars, THIRTY.length);
});

test("the page is read once a run: a second looking_for, and a plain part after it, come from the run's pages", async () => {
  const { asked, counted, web: w } = lookingWeb(TWELVE, scores(12));
  await w.fetch(PUBLIC, { lookingFor: NEED });
  await w.fetch(PUBLIC, { lookingFor: "the registered agent" });
  await w.fetch(PUBLIC);
  assert.equal(counted.extracts, 1);
  assert.deepEqual(asked.map(({ request }) => request.state.task), [NEED, "the registered agent"]);
});

test("a page of fewer chunks than FOUND_CHUNKS is shown whole in its chunks", async () => {
  const three = pageOf(3);
  const { web: w } = lookingWeb(three, { p1: 0.1, p2: 0.9, p3: 0.5 });
  const { answer } = await w.fetch(PUBLIC, { lookingFor: NEED });
  assert.deepEqual(answer.found.map((chunk) => chunk.text).join(""), three);
  assert.equal(answer.sift, SHOWN.replace("the 8 of 12", "the 3 of 3"));
});

test("an annotated fetch as the model reads it: the page's JSON, its found chunks and the line that says how to read on", async () => {
  const { web: w } = lookingWeb(TWELVE, scores(12));
  const { answer } = await w.fetch(PUBLIC, { lookingFor: NEED });
  assert.equal(webFetchText(answer), JSON.stringify(answer));
  assert.deepEqual(Object.keys(answer), ["ok", "url", "status", "title", "original_chars", "found", "via", "sift"]);
});

test("looking_for blank, or not a string, is no looking_for: the part as before", async () => {
  for (const lookingFor of ["   ", 42]) {
    const plain = await lookingWeb(TWELVE, scores(12)).web.fetch(PUBLIC, { task: TASK });
    const { asked, web: w } = lookingWeb(TWELVE, scores(12));
    const given = await w.fetch(PUBLIC, { task: TASK, lookingFor });
    assert.equal(JSON.stringify(given.answer), JSON.stringify(plain.answer));
    assert.equal(asked[0].request.state.task, TASK);
  }
});

test("looking_for with no classifier, or one that fails, gives the part asked for in page order and says looking_for was not applied", async () => {
  const none = await lookingWeb(THIRTY, {}, { decider: undefined }).web.fetch(PUBLIC, { lookingFor: NEED, offset: 100, maxChars: 500 });
  const part = await lookingWeb(THIRTY, {}, { decider: undefined }).web.fetch(PUBLIC, { offset: 100, maxChars: 500 });
  assert.deepEqual(none.answer, { ...part.answer, sift: "looking_for not applied (no classifier in this run); this part is in page order" });
  assert.equal(none.receipt.classifier, "off");
  const failed = await lookingWeb(THIRTY, {}, { decider: priced(broken) }).web.fetch(PUBLIC, { lookingFor: NEED, offset: 100, maxChars: 500 });
  assert.deepEqual(failed.answer, { ...part.answer, sift: "looking_for not applied (provider_error); this part is in page order" });
  assert.deepEqual([failed.receipt.classifier.ran, failed.receipt.classifier.error.code, failed.receipt.classifier.items], [false, "provider_error", { in: 30, kept: 30 }]);
});

test("looking_for on a page that was not read answers the failure, the step skipped", async () => {
  const { asked, web: w } = lookingWeb(TWELVE, scores(12));
  const { answer, receipt } = await w.fetch("http://evil.example/", { lookingFor: NEED });
  assert.equal(answer.ok, false);
  assert.equal(answer.found, undefined);
  assert.deepEqual([receipt.classifier.ran, receipt.classifier.skipped, asked.length], [false, "no page", 0]);
});
