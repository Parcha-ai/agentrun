// The import's index pass (`index: true`): each run's row and serve.json first, with the metrics and estimate its
// transcript gives, and no transcript; the import run again without it writes the transcripts. The rows after the first
// pass are the rows after the second, and the rows one pass writes; a stop between the two leaves rows the next import
// finishes, never duplicates; and each pass says how far it has got.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openStore } from "@parcha/pi-durable-agent";
import { planImport, runImport } from "../dist/import.js";
import { at as minute, claudeSession, claudeSubagent, codexSession, piSession, sessionId, writeSession } from "./fixtures/import-sessions.mjs";
import { scratch } from "./support.mjs";

const ENV = { PATH: "/usr/bin" };

/** Session `n` resumed from the Claude Code one at `file`: its records again under the new id, then (unless `own: false`)
 *  a prompt and an answer of its own. */
function resumed(file, n, { own = true } = {}) {
  const copied = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)).map((r) => (r.sessionId ? { ...r, sessionId: sessionId(n) } : r));
  const base = { sessionId: sessionId(n), cwd: copied[0].cwd, isSidechain: false, userType: "external", version: "2.1.0" };
  return writeSession(join(dirname(file), `${sessionId(n)}.jsonl`), [
    ...copied,
    ...(own
      ? [
          { ...base, type: "user", uuid: `own-u-${n}`, timestamp: minute(20), message: { role: "user", content: "And the tests?" } },
          { ...base, type: "assistant", uuid: `own-a-${n}`, timestamp: minute(21), message: { id: `msg_own_${n}`, role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "They pass." }], usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 60 } } },
        ]
      : []),
  ]);
}

/** A Codex thread resumed in a second rollout file under the first's id: one session, two files. */
function resumedThread(home, cwd, first, n) {
  const again = codexSession(home, cwd, n);
  const id = JSON.parse(readFileSync(first, "utf8").split("\n")[0]).payload.id;
  const records = readFileSync(again, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)).map((r) => (r.type === "session_meta" ? { ...r, payload: { ...r.payload, id } } : r));
  writeFileSync(again, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const old = new Date(Date.now() - 60 * 60_000);
  for (const file of [first, again]) utimesSync(file, old, old);
}

/** Two projects: Claude Code sessions with a subagent, one its source could not price (the catalog's estimate), one
 *  resumed under a new id and one copy of nothing of its own; a Codex thread in two files, another with a subagent that
 *  has its own; and a pi session. */
function wideHome(root) {
  const home = join(root, "home");
  const alpha = join(home, "code", "alpha");
  const beta = join(home, "code", "beta");
  for (const dir of [alpha, beta]) mkdirSync(dir, { recursive: true });
  const first = claudeSession(home, alpha, 1);
  claudeSubagent(home, alpha, 1, 1);
  // The same session again in a second file of its id, in another project's folder, holding only copies of the first's
  // records: one run, read from both files, the copy adding nothing.
  writeSession(join(home, ".claude", "projects", "-elsewhere", `${sessionId(1)}.jsonl`), readFileSync(first, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)));
  claudeSession(home, alpha, 2, { unknownCost: true, prompt: "Price this." });
  resumed(first, 3);
  resumed(first, 4, { own: false });
  claudeSession(home, alpha, 5, { parallel: true, answerModel: "claude-haiku-5", pause: 60 });
  const thread = codexSession(home, beta, 10);
  resumedThread(home, beta, thread, 11);
  codexSession(home, beta, 12);
  codexSession(home, beta, 13, { subagent: true, parent: sessionId(12) });
  codexSession(home, beta, 14, { subagent: true, parent: sessionId(13) });
  piSession(home, beta, 15);
  return { home, temp: join(root, "tmp") };
}

async function storeFor(t, name) {
  const data = join(await scratch(t), name);
  const store = openStore(data);
  t.after(() => store.close());
  return { data, store };
}

/** Each run by its source and session: its row and its stored metrics (without the time they were written). */
function rows(store) {
  return Object.fromEntries(
    store.listRuns().map((run) => {
      const { at, ...metrics } = store.runMetrics(run.id) ?? {};
      void at;
      const { id, revision, ...row } = run;
      void id;
      void revision;
      return [`${run.importedFrom.source}:${run.importedFrom.session}`, { ...row, metrics }];
    }),
  );
}
const runIdOf = (store, key) => store.listRuns().find((run) => `${run.importedFrom.source}:${run.importedFrom.session}` === key).id;
/** A run's transcript as it reads: each entry's kind, model and data. */
function transcriptOf(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all().map(({ record }) => {
      const { kind, model, data: extra } = JSON.parse(record);
      return { kind, model, data: extra };
    });
  } finally {
    db.close();
  }
}
const metaOf = (data, runId) => JSON.parse(readFileSync(join(data, "runs", runId, "serve.json"), "utf8"));

test("the index pass writes every run's row, its metrics and estimate as its transcript gives them, and no transcript; the transcripts pass changes no row, and the two passes write what one pass does", { timeout: 120_000 }, async (t) => {
  const root = await scratch(t);
  const h = wideHome(root);
  const opts = { home: h.home, env: ENV, temp: h.temp };

  const two = await storeFor(t, "two");
  const plan = await planImport(opts, two.store);
  const indexed = await runImport(two.store, plan, { ...opts, index: true });
  const afterIndex = rows(two.store);
  const keys = Object.keys(afterIndex).sort();
  assert.equal(keys.length, 7, `the sessions as runs: ${keys.join(", ")}`);
  for (const key of keys) {
    const runId = runIdOf(two.store, key);
    assert.equal(existsSync(join(two.data, "runs", runId, "store", "run.sqlite")), false, `${key}: no transcript after the index pass`);
    assert.ok(existsSync(join(two.data, "runs", runId, "serve.json")), `${key}: its serve.json, for the lists`);
  }
  assert.ok(Object.values(afterIndex).some((row) => row.metrics.costUsdEst !== undefined), "a run its source did not price has the catalog's estimate from the index pass");
  assert.deepEqual(indexed.agents.map((a) => a.runs).reduce((n, r) => n + r, 0), 7);

  const transcripts = await runImport(two.store, plan, opts);
  assert.deepEqual(transcripts.agents.map((a) => [a.runs, a.finished]).reduce(([r, f], [ar, af]) => [r + ar, f + af], [0, 0]), [0, 7], "the transcripts pass finishes every row, and makes none");
  assert.deepEqual(rows(two.store), afterIndex, "no row changed by the transcripts pass");

  const one = await storeFor(t, "one");
  const single = await runImport(one.store, await planImport(opts, one.store), opts);
  assert.deepEqual(rows(one.store), afterIndex, "the rows one pass writes");
  const skips = (report) => report.skipped.map((s) => `${s.what} ${s.why}`).sort();
  assert.deepEqual(skips(transcripts), skips(single), "the files left out, and why, as one pass says");
  assert.ok(single.skipped.some((s) => s.why === "holds only records of sessions imported already"), "the copy is left out");
  for (const key of keys) {
    const [a, b] = [runIdOf(one.store, key), runIdOf(two.store, key)];
    assert.deepEqual(transcriptOf(two.data, b), transcriptOf(one.data, a), `${key}: the same transcript`);
    assert.deepEqual(metaOf(two.data, b), metaOf(one.data, a), `${key}: the same serve.json`);
  }
});

test("a stop between the passes leaves rows the next import finishes: every transcript written, no run twice, no row changed", { timeout: 120_000 }, async (t) => {
  const root = await scratch(t);
  const h = wideHome(root);
  const opts = { home: h.home, env: ENV, temp: h.temp };
  const { data, store } = await storeFor(t, "agents");
  await runImport(store, await planImport(opts, store), { ...opts, index: true });
  const afterIndex = rows(store);
  // The index pass again (a start stopped before its transcripts pass, started again): nothing more.
  const again = await runImport(store, await planImport(opts, store), { ...opts, index: true });
  assert.equal(again.agents.reduce((n, a) => n + a.runs, 0), 0, "no row made twice");
  assert.deepEqual(rows(store), afterIndex);
  // The next start's import, whole.
  const next = await runImport(store, await planImport(opts, store), opts);
  assert.deepEqual(next.agents.reduce(([r, f], a) => [r + a.runs, f + a.finished], [0, 0]), [0, 7], "every row finished, none made");
  assert.equal(store.listRuns().length, 7, "no run twice");
  assert.deepEqual(rows(store), afterIndex, "no row changed");
  for (const run of store.listRuns()) assert.ok(transcriptOf(data, run.id).length > 0, `${run.importedFrom.session}: its transcript`);
});

test("each pass says how far it has got: the index pass its rows and agents, the transcripts pass its transcripts, each count only growing", { timeout: 120_000 }, async (t) => {
  const root = await scratch(t);
  const h = wideHome(root);
  const opts = { home: h.home, env: ENV, temp: h.temp };
  const { store } = await storeFor(t, "agents");
  const plan = await planImport(opts, store);
  const seen = { index: [], transcripts: [] };
  await runImport(store, plan, { ...opts, index: true, onProgress: (p) => seen.index.push(p) });
  await runImport(store, plan, { ...opts, onProgress: (p) => seen.transcripts.push(p) });
  const growing = (list, field) => list.every((p, i) => i === 0 || p[field] >= list[i - 1][field]);
  assert.deepEqual(seen.index.at(-1), { rows: 7, transcripts: 0, agents: 2 });
  assert.deepEqual(seen.transcripts.at(-1), { rows: 7, transcripts: 7, agents: 2 });
  for (const field of ["rows", "transcripts", "agents"]) {
    assert.ok(growing(seen.index, field), `index: ${field} grows`);
    assert.ok(growing(seen.transcripts, field), `transcripts: ${field} grows`);
  }
  assert.ok(seen.index.length >= 7, "a word after each run");
});

test("a timeline read says the transcript is importing while a run read before its transcript has none: while the import runs, and once the transcript has landed though the run read is older", async () => {
  const { importingNow } = await import("../dist/runs.js");
  assert.equal(importingNow(true, false, true), true, "awaited, not landed, the import running");
  assert.equal(importingNow(true, true, true), true, "landed after the run was read: read it again, never final with no rows");
  assert.equal(importingNow(true, true, false), true, "landed, the import over since: still read it again");
  assert.equal(importingNow(true, false, false), false, "no import running and no transcript: the run has none");
  assert.equal(importingNow(false, false, true), false, "a run read with its transcript");
});
