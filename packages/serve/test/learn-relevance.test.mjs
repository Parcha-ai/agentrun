// The lexical match behind byRelevance (learn/relevance.ts): a run's input as words, a code review's changed paths, and
// BM25 over the notes. No model call.
import assert from "node:assert/strict";
import { test } from "node:test";

const { bm25, changedPaths, inputText, queryOf, wordsOf } = await import("../dist/learn/relevance.js");

test("words: lowercase letters and digits, no stop word, single letter or bare number; a path's segments are words", () => {
  assert.deepEqual(wordsOf("Reconcile the invoices: src/billing/Invoice.ts, a 2nd time"), ["reconcile", "invoices", "src", "billing", "invoice", "ts", "2nd", "time"]);
  assert.deepEqual(wordsOf("Step 6 and step 46, line 0042 of v2"), ["step", "step", "line", "v2"], "a bare number is no word; one in a word stays");
});

test("a code review's changed paths: a diff's headers and a file list's paths, never /dev/null or prose", () => {
  const text = ["Please review.", "diff --git a/src/a.ts b/src/b.ts", "--- /dev/null", "+++ b/src/b.ts", "- docs/guide.md", "README.md", "a line of prose here"].join("\n");
  assert.deepEqual(changedPaths(text).sort(), ["README.md", "docs/guide.md", "src/a.ts", "src/b.ts"]);
  const query = queryOf({ content: "Review the db.\ndiff --git a/db/x.sql b/db/x.sql" });
  assert.deepEqual([query.get("review"), query.get("db"), query.get("sql")], [1, 3, 3], "a prose word weighs 1, a changed path's word PATH_WEIGHT");
});

test("an input's text: a string, an object's content, else every string field", () => {
  assert.equal(inputText("hi"), "hi");
  assert.equal(inputText({ content: "the message", other: "x" }), "the message");
  assert.equal(inputText({ question: "a", nested: { list: ["b", 3] } }), "a\nb");
  assert.equal(inputText(undefined), "");
});

test("BM25: a note holding the input's rarer words scores above one holding its common ones; none of them, 0", () => {
  const docs = [
    { name: "Invoices", description: "Reconcile invoices", body: "Match the ledger." },
    { name: "Tables", description: "Answer with tables", body: "One row per option." },
    { name: "Ledger", description: "The ledger", body: "Ledger ledger." },
  ];
  const [invoices, tables, ledger] = bm25(docs, wordsOf("reconcile the invoices against the ledger"));
  assert.ok(invoices > ledger && ledger > 0 && tables === 0, JSON.stringify({ invoices, tables, ledger }));
  assert.deepEqual(bm25(docs, []), [0, 0, 0]);
});

test("a code review's changed paths outweigh its prose: a diff touching db/migrations whose message talks about the refund window ranks the migrations notes above the refunds notes (#2274)", async () => {
  const { topical } = await import("./note-selector-cases.mjs");
  const { activeOf } = await import("../dist/learning.js");
  const notes = activeOf(topical(20));
  const input = ["Please review. The refund window copy changed too.", "diff --git a/db/migrations/0042.sql b/db/migrations/0042.sql", "--- a/db/migrations/0042.sql", "+++ b/db/migrations/0042.sql"].join("\n");
  const scores = bm25(notes, queryOf({ content: input }));
  const top = (topic) => Math.max(...notes.map((note, i) => (note.file.startsWith(`${topic}-`) ? scores[i] : 0)));
  assert.ok(top("migrations") > top("refunds"), `migrations ${top("migrations")} above refunds ${top("refunds")}`);
  // Prose alone, said twice, counts once: the boost is the paths', never a word repeated.
  assert.deepEqual(bm25(notes, queryOf({ content: "refund refund refund" })), bm25(notes, queryOf({ content: "refund" })));
});
