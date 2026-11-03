// Setup's import as the owner watches it: how far it has got (the rows of `total`, then the transcripts), every run's row
// in before the first transcript, a stop between the two finished by the next start, a run opened before its transcript
// lands saying so and then filling in, and Mission Control's counts read through the store the import keeps busy.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openStoreReader } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { claudeSession } from "./fixtures/import-sessions.mjs";
import { call, cookieOf, FAUX, scratch, serve } from "./support.mjs";

const json = { "content-type": "application/json" };
const page = (server) => ({ ...json, origin: `http://127.0.0.1:${server.port}` });
/** A test password, no real one (the source export reviews a literal credential that is not plainly fake). */
const pw = (name) => `not-a-secret-${name}`;
const PASSWORD = pw("owner");

/** A home of `n` Claude Code sessions over `projects` projects. */
async function many(t, n, projects) {
  const root = await scratch(t);
  const home = join(root, "home");
  for (let k = 0; k < projects; k++) mkdirSync(join(home, "code", `p${k}`), { recursive: true });
  for (let i = 1; i <= n; i++) claudeSession(home, join(home, "code", `p${i % projects}`), i, { prompt: `Task ${i}.` });
  return { root, sessionsHome: { home, temp: join(root, "tmp") } };
}
function storeRuns(data) {
  if (!existsSync(join(data, "store.sqlite"))) return [];
  const reader = openStoreReader(data, { busyTimeoutMs: 10_000 });
  try {
    return reader.listRuns();
  } finally {
    reader.close();
  }
}
const hasTranscript = (data, runId) => existsSync(join(data, "runs", runId, "store", "run.sqlite"));
async function setUp(server) {
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: page(server), body: { password: PASSWORD, import: true } });
  assert.deepEqual([made.status, made.json], [201, { signed_in: true, importing: true }], made.text);
  return cookieOf(made);
}
const stateOf = async (server, cookie) => (await call(server.port, { path: "/v2/setup/import", headers: { cookie } })).json;

test("while the import at setup runs, the owner reads how far it has got, and every run's row is in before the first transcript", { timeout: 180_000 }, async (t) => {
  const { sessionsHome } = await many(t, 300, 6);
  const server = await serve(t, { accounts: true, openSetup: true, sessionsHome });
  const cookie = await setUp(server);
  const seen = [];
  let rowsAtTranscripts;
  for (const deadline = Date.now() + 150_000; Date.now() < deadline; await sleep(50)) {
    const state = await stateOf(server, cookie);
    seen.push(state);
    if (state.phase === "transcripts" && rowsAtTranscripts === undefined) rowsAtTranscripts = storeRuns(server.data).length;
    if (state.state !== "running") break;
  }
  assert.deepEqual(seen.at(-1), { state: "done", agents: 6, runs: 300, skipped: 0 });
  const running = seen.filter((s) => s.state === "running" && s.total !== undefined);
  assert.ok(running.length > 0, `a running state with its counts: ${JSON.stringify(seen.slice(0, 3))}`);
  for (const s of running) {
    assert.equal(s.total, 300);
    assert.ok(["index", "transcripts"].includes(s.phase), s.phase);
    assert.ok(s.runs >= 0 && s.runs <= 300 && s.transcripts <= s.runs && s.agents <= 6, JSON.stringify(s));
    assert.ok(!Number.isNaN(Date.parse(s.started_at)), s.started_at);
  }
  assert.ok(running.some((s) => s.phase === "index"), "read during the index pass");
  assert.equal(rowsAtTranscripts, 300, "every row in once the transcripts pass begins");
  assert.ok(running.filter((s) => s.phase === "transcripts").every((s) => s.runs === 300));
});

test("a server stopped between the index pass and the transcripts pass: the next start finishes every transcript, no run twice, and says what the whole import took", { timeout: 180_000 }, async (t) => {
  const { root, sessionsHome } = await many(t, 120, 3);
  const data = join(root, "agents");
  const options = { data, port: 0, faux: FAUX, drainTimeout: "5s", accounts: true, openSetup: true, sessionsHome };
  const first = await startServe(options);
  const cookie = await setUp(first);
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await sleep(20)) {
    const state = await stateOf(first, cookie);
    if (state.phase === "transcripts" || state.state !== "running") break;
  }
  await first.close();
  const before = storeRuns(data);
  assert.equal(before.length, 120, "every row in");
  assert.ok(before.filter((run) => hasTranscript(data, run.id)).length < 120, "stopped before every transcript");
  assert.ok(existsSync(join(data, ".import-at-setup")), "the yes kept while transcripts are missing");
  const second = await startServe(options);
  t.after(() => second.close());
  const signedIn = await call(second.port, { method: "POST", path: "/v2/auth/sign-in", headers: page(second), body: { password: PASSWORD } });
  assert.equal(signedIn.status, 200, signedIn.text);
  for (const deadline = Date.now() + 120_000; (await stateOf(second, cookieOf(signedIn)))?.state !== "done" && Date.now() < deadline; ) await sleep(100);
  assert.deepEqual(await stateOf(second, cookieOf(signedIn)), { state: "done", agents: 3, runs: 120, skipped: 0 });
  const after = storeRuns(data);
  assert.equal(after.length, 120, "no run twice");
  assert.ok(after.every((run) => hasTranscript(data, run.id)), "every transcript written");
});

test("a run opened while its transcript is still to come says it is importing and is not final; once the transcript lands, the same run shows it", { timeout: 180_000 }, async (t) => {
  const { sessionsHome } = await many(t, 300, 6);
  const server = await serve(t, { accounts: true, openSetup: true, sessionsHome });
  const cookie = await setUp(server);
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await sleep(20)) {
    const state = await stateOf(server, cookie);
    if (state.phase === "transcripts" || state.state !== "running") break;
  }
  const timeline = async (id) => (await call(server.port, { path: `/v2/runs/${id}/timeline`, headers: { cookie } })).json;
  let opened;
  // The rows a transcript has not reached yet, the last ones first: one is still to come when it is read.
  for (const run of storeRuns(server.data).reverse()) {
    if (hasTranscript(server.data, run.id)) continue;
    const page = await timeline(run.id);
    if (page.transcript === "importing") {
      opened = { id: run.id, page };
      break;
    }
  }
  assert.ok(opened, "a run read before its transcript landed");
  assert.deepEqual([opened.page.rows, opened.page.final, opened.page.status], [[], false, "completed"]);
  for (const deadline = Date.now() + 120_000; (await stateOf(server, cookie)).state === "running" && Date.now() < deadline; ) await sleep(100);
  const filled = await timeline(opened.id);
  assert.equal(filled.transcript, undefined, "no longer importing");
  assert.ok(filled.rows.length > 0, "its rows, read again once the transcript landed");
  assert.equal(filled.final, true);
});

test("Mission Control's counts: after one good read, a store held busy answers that read with its as_of, never 409; with no read before, the busy store is 409", { timeout: 60_000 }, async (t) => {
  const server = await serve(t);
  const stats = () => server.api("GET", "/stats");
  const hold = () => {
    const db = new DatabaseSync(join(server.data, "store.sqlite"));
    db.exec("BEGIN EXCLUSIVE");
    return () => { db.exec("ROLLBACK"); db.close(); };
  };
  // An agent's filter never read: busy is busy.
  let release = hold();
  const cold = await server.api("GET", "/stats?agent=nobody");
  release();
  assert.deepEqual([cold.status, cold.body.error?.code], [409, "home_busy"], JSON.stringify(cold.body));

  const good = await stats();
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.as_of, undefined, "a fresh read carries no as_of");
  const readAt = Date.now();
  release = hold();
  let held;
  try {
    held = await stats();
  } finally {
    release();
  }
  assert.equal(held.status, 200, JSON.stringify(held.body));
  const { as_of, ...rest } = held.body;
  assert.deepEqual(rest, good.body, "the last good read");
  assert.ok(Math.abs(Date.parse(as_of) - readAt) < 5_000, `as_of is when it was read: ${as_of}`);
  const fresh = await stats();
  assert.deepEqual([fresh.status, fresh.body.as_of], [200, undefined], "the store free again: a fresh read");
});
