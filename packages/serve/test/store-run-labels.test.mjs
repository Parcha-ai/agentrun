// A run's labels in the one store: written once with the queued run (runs.create, runs.createInline), read on every run
// row ({} when none), and matched by runs.list's `labels` (every one held, key and value, each bound as a parameter). On
// SQLite a store an earlier build of this version made, with no labels column, gets it at the server's open (the version
// kept), its runs reading as given none; a runner refuses that store until its server has added the column.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SCHEMA_VERSION } from "../dist/store/schema.js";
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

test("a store an earlier build of this version made (no runs.labels) opens at its version: a runner refuses it until the server adds the column, its runs read as given none", sqliteOnly("an earlier build's store file"), async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  const first = await openSqliteStore({ file, role: "server", now: () => T0 });
  await agentWithRevision(first);
  await first.runs.create(run("run-old"));
  await first.close();
  // The store as the build before labels made it: the same version, its runs table with no labels column.
  const db = new DatabaseSync(file);
  try {
    db.exec("ALTER TABLE runs DROP COLUMN labels");
  } finally {
    db.close();
  }
  const columnOf = () => {
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      const column = check.prepare("SELECT name, type, \"notnull\" FROM pragma_table_info('runs') WHERE name = 'labels'").get();
      return { column: column && { ...column }, version: check.prepare("SELECT schema_version FROM store_meta").get().schema_version };
    } finally {
      check.close();
    }
  };
  // A runner upgraded before its server is refused in words, the store unchanged: it reads every run through the column.
  await assert.rejects(openSqliteStore({ file, role: "runner" }), /Start the AgentRun server to add each run's labels before opening a runner/);
  assert.deepEqual(columnOf(), { column: undefined, version: SCHEMA_VERSION }, "a runner adds nothing");
  const second = await openSqliteStore({ file, role: "server", now: () => T0 });
  try {
    assert.deepEqual(columnOf(), { column: { name: "labels", type: "TEXT", notnull: 0 }, version: SCHEMA_VERSION }, "the server adds runs.labels, nullable, the version kept");
    assert.deepEqual((await second.runs.get("run-old")).labels, {}, "a run started before reads as given none");
    const made = await second.runs.create(run("run-new", { tenant: "t-1" }));
    assert.deepEqual(made.labels, { tenant: "t-1" });
    assert.deepEqual((await second.runs.list({ labels: { tenant: "t-1" } })).map((row) => row.id), ["run-new"]);
  } finally {
    await second.close();
  }
  // A second open finds the column and adds nothing; the runner then opens.
  const again = await openSqliteStore({ file, role: "server", now: () => T0 });
  await again.close();
  const runner = await openSqliteStore({ file, role: "runner" });
  try {
    assert.deepEqual((await runner.runs.get("run-new")).labels, { tenant: "t-1" });
  } finally {
    await runner.close();
  }
});
