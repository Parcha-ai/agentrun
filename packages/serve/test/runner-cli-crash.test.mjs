// A claude-agent or codex run whose runner dies mid-turn is taken by the next runner and ends once: the request it had
// paid for before the crash is booked once (never again on the next claim, never dropped), every request after it is
// booked, and the run's timeline shows each row once. pi's crash through the runner is adapter-pi-cap-raise-crash's.
//
// The faux CLI harness (fixtures/faux-harness.mjs, "Claude Code makes five cent calls across a restart at <file>") makes
// one $0.01 tool call, then holds its turn with no request open (writing <file>.held) until <file> exists, then four more
// $0.01 calls and a $0.01 answer: six paid requests, $0.06. It keeps its own records in the run's journal, so a process
// opened after the crash goes on from the request after the last one it made. The first runner is killed while the turn
// holds (a crash: nothing stopped, flushed or released). The second runner's store reads the clock an hour on, so the
// first's 30-second claim has already run out for it: it takes the run at once, with no wait on a lease.
import assert from "node:assert/strict";
import { existsSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fauxEnvOf } from "../dist/server.js";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { dispatchRunner } from "../dist/runner/harness-loops.js";
import { computerDepsFrom } from "../dist/workspace/index.js";
import { routeOf } from "../dist/runner/model-route.js";
import { withoutFaux } from "../dist/model.js";
import { bootSealKey } from "../dist/seal-key.js";
import { agent, FAUX, follow, scratch, serve } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
/** The second runner's clock: far past the first runner's 30-second claim, so that claim has run out for it. */
const AN_HOUR = 60 * 60 * 1000;
/** Six paid requests at $0.01: the call before the crash, four calls after it, and the answer. */
const PAID = 6;
const USD = 0.06;

/** Resolves once `file` exists: on the directory's own change events, never a timer. */
function appeared(file) {
  return new Promise((resolve) => {
    const watcher = watch(dirname(file), () => existsSync(file) && (watcher.close(), resolve()));
    if (existsSync(file)) (watcher.close(), resolve());
  });
}

/** A runner on the server's data, as the in-process runner the tests start (support.mjs startInProcessRunner), with its
 *  store's clock `skewMs` on: the runner itself, to kill, and a close for the test's end. */
async function runnerOn(t, data, name, { skewMs = 0, claims = [] } = {}) {
  const store = await openSqliteStore({ dataDir: data, role: "runner", ...(skewMs ? { now: () => Date.now() + skewMs } : {}) });
  const env = { ...withoutFaux(process.env), ...fauxEnvOf({ faux: FAUX, harnessTable: fauxTable(FAUX_HARNESS) }) };
  const seal = await bootSealKey(store, data, { role: "runner" });
  const computers = computerDepsFrom({ env, store, sealKey: seal.key });
  // Each claim this runner takes, as its events say it (the runner's own "claimed").
  const onEvent = (event) => event.type === "claimed" && claims.push(`${name}@${event.claim.epoch}`);
  const runner = startRunner({ store, name, onEvent, createLoop: dispatchRunner({ env, data, journal: (claim) => store.journal(claim), store, sealKey: seal.key, routeOf, computerForClaim: computers.computerForClaim, computerDeps: computers.computerDeps }) });
  let killed = false;
  t.after(async () => {
    if (!killed) await runner.close().catch(() => {});
    await store.close().catch(() => {});
    seal.release();
  });
  return { kill: () => ((killed = true), runner.kill()) };
}

/** The run's journal entries of `kind`, read from the server's store beside the server. */
function entriesOf(data, runId, kind) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    return db.prepare("SELECT record FROM pi_entries WHERE run_id = ? ORDER BY id").all(runId).map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === kind);
  } finally {
    db.close();
  }
}

/** The run's claim epoch, as its row in the server's store holds it. */
function epochOf(data, runId) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    return Number(db.prepare("SELECT epoch FROM runs WHERE id = ?").get(runId).epoch);
  } finally {
    db.close();
  }
}

/** Every row of the run's timeline as the server serves it, page by page from the start, none merged by id. */
async function everyRow(api, runId) {
  const rows = [];
  for (let after = 0; ; ) {
    const { status, body } = await api("GET", `/runs/${runId}/timeline?${new URLSearchParams(after ? { after: String(after) } : {})}`);
    assert.equal(status, 200, JSON.stringify(body));
    rows.push(...body.rows);
    if (!body.has_more) return rows;
    after = body.next_after;
  }
}

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a run whose runner dies mid-turn is taken by the next runner and ends once, each request booked once and each timeline row shown once`, { timeout: 120_000 }, async (t) => {
    const gate = join(await scratch(t), "go");
    const { api, data } = await serve(t, { runner: false, harnessTable: fauxTable(FAUX_HARNESS) });
    const made = await api("POST", "/agents", agent("crash", { harness, instructions: `Claude Code makes five cent calls across a restart at ${gate}.`, tools: ["read"] }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const started = await api("POST", "/agents/crash/runs", { input: { content: "Read a.txt five times." } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;

    // The first runner takes the run; its turn pays one request and its call, then holds. Killed there, as a crash.
    const claims = [];
    const first = await runnerOn(t, data, "runner-a", { claims });
    await appeared(`${gate}.held`);
    first.kill();
    await writeFile(gate, "");

    // The next runner, past the first's claim, takes the run and finishes it.
    await runnerOn(t, data, "runner-b", { skewMs: AN_HOUR, claims });
    const { last } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
    const view = (await api("GET", `/runs/${runId}`)).body;
    assert.equal(last.status, "completed", `the run completed: ${JSON.stringify(view)}`);

    // Taken over once: two claims (the first runner's, then the next one's), and one end in its journal. The run's epoch
    // is 3: each claim moves it on, and so does the end that lets the run go (store run-patch's ending).
    assert.deepEqual(claims, ["runner-a@1", "runner-b@2"], "claimed by the first runner, then once by the next");
    assert.equal(epochOf(data, runId), 3, "two claims and the run's end");
    assert.equal(entriesOf(data, runId, "agentrun.end").length, 1, "the run's journal holds one end");

    // Money: six requests booked, the one before the crash once, none after it free: $0.06 on the run, its usage row and
    // its stored cost alike.
    const rows = await everyRow(api, runId);
    const usage = rows.findLast((row) => row.kind === "usage")?.usage;
    assert.equal(usage?.requests, PAID, `six requests booked: ${JSON.stringify(usage)}`);
    assert.ok(Math.abs(usage.usd - USD) < 1e-9, `the usage row's cost is $0.06: ${JSON.stringify(usage)}`);
    assert.ok(Math.abs(view.cost.usd - USD) < 1e-9, `the run's cost is $0.06: ${JSON.stringify(view.cost)}`);

    // The timeline: every row once, the person's message once, five calls each with one result, one answer.
    const ids = rows.map((row) => row.id);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "no row id twice");
    const shown = JSON.stringify(rows.map((row) => [row.seq, row.kind, row.summary]));
    assert.equal(rows.filter((row) => row.kind === "user_message").length, 1, `the person's message once: ${shown}`);
    const uses = rows.filter((row) => row.kind === "tool_use");
    assert.equal(uses.length, 5, `five calls: ${shown}`);
    assert.equal(new Set(uses.map((row) => row.tool_use_id)).size, 5, `each call once: ${shown}`);
    for (const use of uses) assert.equal(rows.filter((row) => row.kind === "tool_result" && row.tool_use_id === use.tool_use_id).length, 1, `${use.tool_use_id}: one result: ${shown}`);
    assert.equal(rows.filter((row) => row.kind === "final_answer").length, 1, `one answer: ${shown}`);
    assert.equal(view.result?.final_answer, "Done.", JSON.stringify(view.result));
  });
}
