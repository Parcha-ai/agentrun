// A run's labels in the one store: written once with the queued run (runs.create, runs.createInline), read on every run
// row ({} when none), and matched by runs.list's `labels` (every one held, key and value, each bound as a parameter). On
// SQLite the column is schema version 12: a store an earlier release set up (version 11, no labels column) is refused by a
// server and by a runner of this build, so neither ever reads or writes runs without the column.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SchemaVersionUnknown } from "../dist/store/index.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";
import { sqliteOnly } from "./store-target.mjs";

const run = (id, labels) => ({ id, agentId: "agent-1", revisionId: "rev-1", ...(labels ? { labels } : {}) });

test("a run keeps the labels it was created with, read back on every row; a run given none reads {}", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  const made = await store.runs.create(run("run-a", { tenant: "t-1", "job/id": "42" }), { body: { input: { content: "hi" } } });
  assert.deepEqual(made.labels, { "job/id": "42", tenant: "t-1" });
  assert.deepEqual((await store.runs.get("run-a")).labels, { "job/id": "42", tenant: "t-1" });
  assert.deepEqual(Object.keys((await store.runs.get("run-a")).labels), ["job/id", "tenant"], "kept with its keys sorted");
  const bare = await store.runs.create(run("run-b"));
  assert.deepEqual(bare.labels, {});
  assert.deepEqual((await store.runs.get("run-b")).labels, {});
  assert.deepEqual((await store.runs.create(run("run-c", {}))).labels, {}, "an empty map is none");
});

test("list matches every label asked for, key and value; a key or value that reads as SQL or a JSON path is only text", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create(run("run-1", { tenant: "t-1", job: "a" }));
  await store.runs.create(run("run-2", { tenant: "t-1", job: "b" }));
  await store.runs.create(run("run-3", { tenant: "t-2", job: "a" }));
  await store.runs.create(run("run-4"));
  await store.runs.create(run("run-5", { "a.b": "x' OR '1'='1", "$.tenant": "t-1" }));
  const ids = async (labels) => (await store.runs.list({ labels })).map((row) => row.id).sort();
  assert.deepEqual(await ids({ tenant: "t-1" }), ["run-1", "run-2"]);
  assert.deepEqual(await ids({ tenant: "t-1", job: "a" }), ["run-1"], "every label, not any");
  assert.deepEqual(await ids({ job: "a" }), ["run-1", "run-3"]);
  assert.deepEqual(await ids({ tenant: "t-3" }), []);
  assert.deepEqual(await ids({ tenant: "T-1" }), [], "a value matches exactly");
  assert.deepEqual(await ids({ "a.b": "x' OR '1'='1" }), ["run-5"], "a quote in a value is text");
  assert.deepEqual(await ids({ a: "x' OR '1'='1" }), [], "a dot in a key is no path");
  assert.deepEqual(await ids({ "$.tenant": "t-1" }), ["run-5"], "a key shaped like a JSON path is a key");
  assert.deepEqual(await ids({}), ["run-1", "run-2", "run-3", "run-4", "run-5"], "no labels asked for: every run");
  assert.deepEqual((await store.runs.list({ labels: { tenant: "t-1" }, agentId: "agent-1", limit: 1 })).length, 1, "with the other filters and the limit");
});

test("a label value holding a lone UTF-16 surrogate is refused at the write, nothing kept, and every later search still answers", async (t) => {
  // JSON.stringify keeps a lone surrogate as a \ud800 escape, which Postgres' json check takes but json_each_text cannot
  // decode: kept, it would fail every later search that scans the run, whatever label it asked for.
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create(run("run-1", { tenant: "t-1" }));
  for (const [id, value] of [["run-hi", "a\ud800"], ["run-lo", "\udc00b"]]) {
    await assert.rejects(store.runs.create(run(id, { tenant: value })), TypeError, `${JSON.stringify(value)} is refused`);
    assert.equal(await store.runs.get(id), undefined, "no run written");
  }
  await assert.rejects(store.runs.createInline({
    agent: { id: "agent-x", name: "Expert", description: null, ref: "src:expert:1" },
    revision: { id: "rev-x", version: "1", kind: "agentic", body: { instructions: "Answer.", tools: [], skills: {} }, skills: {} },
    run: { id: "run-x", labels: { turn: "\ud800" } },
    launch: { body: { input: { content: "hi" }, title: "hi", place: { mode: "runner" } } },
  }), TypeError);
  assert.equal(await store.runs.get("run-x"), undefined, "no inline run written");
  await store.runs.create(run("run-2", { mood: "😀" }));
  assert.deepEqual((await store.runs.list({ labels: { tenant: "t-1" } })).map((row) => row.id), ["run-1"]);
  assert.deepEqual((await store.runs.list({ labels: { mood: "😀" } })).map((row) => row.id), ["run-2"], "a surrogate pair is one character, kept and matched");
});

test("an inline agent's run keeps its labels too", async (t) => {
  const { store } = await storeOn(t);
  const made = await store.runs.createInline({
    agent: { id: "agent-x", name: "Expert", description: null, ref: "src:expert:1" },
    revision: { id: "rev-x", version: "1", kind: "agentic", body: { instructions: "Answer.", tools: [], skills: {} }, skills: {} },
    run: { id: "run-x", labels: { turn: "t1" } },
    launch: { body: { input: { content: "hi" }, title: "hi", place: { mode: "runner" } } },
  });
  assert.deepEqual(made.labels, { turn: "t1" });
  assert.deepEqual((await store.runs.list({ labels: { turn: "t1" } })).map((row) => row.id), ["run-x"]);
});

test("a store an earlier release set up (schema version 11, no labels column) is refused by a runner and by a server of this build, unchanged", sqliteOnly("an earlier release's store file"), async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  const first = await openSqliteStore({ file, role: "server", now: () => T0 });
  await agentWithRevision(first);
  await first.runs.create(run("run-old"));
  await first.close();
  // The store as the release before labels set it up: version 11, its runs table with no labels column.
  const db = new DatabaseSync(file);
  try {
    db.exec("ALTER TABLE runs DROP COLUMN labels");
    db.exec("UPDATE store_meta SET schema_version = 11");
  } finally {
    db.close();
  }
  // A runner upgraded before its server is refused: it would read and write runs through a column the store lacks.
  await assert.rejects(openSqliteStore({ file, role: "runner" }), (error) => error instanceof SchemaVersionUnknown && error.found === 11 && error.known > 11);
  await assert.rejects(openSqliteStore({ file, role: "server", now: () => T0 }), (error) => error instanceof SchemaVersionUnknown && error.found === 11);
  const after = new DatabaseSync(file);
  try {
    assert.equal(after.prepare("SELECT name FROM pragma_table_info('runs') WHERE name = 'labels'").get(), undefined, "nothing added to the refused store");
    assert.equal(after.prepare("SELECT schema_version FROM store_meta").get().schema_version, 11, "its version as it was");
  } finally {
    after.close();
  }
});
