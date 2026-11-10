// The lexical match behind byRelevance (learn/relevance.ts): a run's input as words, a code review's changed paths, and
// BM25 over the notes. No model call.
import assert from "node:assert/strict";
import { test } from "node:test";

const { bm25, changedPaths, inputText, queryOf, wordsOf } = await import("../dist/learn/relevance.js");

test("words: lowercase letters and digits, no stop word or single letter; a path's segments are words", () => {
  assert.deepEqual(wordsOf("Reconcile the invoices: src/billing/Invoice.ts, a 2nd time"), ["reconcile", "invoices", "src", "billing", "invoice", "ts", "2nd", "time"]);
});

test("a code review's changed paths: a diff's headers and a file list's paths, never /dev/null or prose", () => {
  const text = ["Please review.", "diff --git a/src/a.ts b/src/b.ts", "--- /dev/null", "+++ b/src/b.ts", "- docs/guide.md", "README.md", "a line of prose here"].join("\n");
  assert.deepEqual(changedPaths(text).sort(), ["README.md", "docs/guide.md", "src/a.ts", "src/b.ts"]);
  assert.deepEqual(queryOf({ content: "diff --git a/db/x.sql b/db/x.sql" }).filter((word) => word === "db").length, 3, "the text's words, then the path's once more");
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
