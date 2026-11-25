// A runs list reads the runs' rows (store/schema.ts RUN_LISTING_COLUMNS), never a run's view: each run's listing is built
// from its view once per change and kept on its row. These hold what a caller depends on: the list shows each run as the
// run's own read does at that moment (summaryOfView of GET /runs/{id}, the item main's list built from the view), field by
// field, in every status, a write that moves a run included; a status filter finds each run where its read says it is;
// and one list makes the same number of store calls, and reads the same rows, at 20 runs and at 200.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { createHash, randomBytes } from "node:crypto";
import { agent, answerFlow, client, FAUX, flowAgent, follow, serve, startServe } from "./support.mjs";
import { storeOn } from "./store-helpers.mjs";
import { workflow } from "./learn-format-support.mjs";
import { landWorkflows } from "./learned-workflow-seed-support.mjs";
import { learningAt } from "./learn-support.mjs";

const { Connection } = await import("../dist/store/sqlite/connection.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { listedItem, listingOverStore, summaryOfView, summaryOverStore } = await import("../dist/store-view.js");
const { createLister } = await import("../dist/run-listing.js");
const { saveSignIn, signInsOverStore } = await import("../dist/sign-ins-store.js");
const { blobOid } = await import("../dist/learn/rows.js");
const { changeWorkflow } = await import("../dist/learning-routes.js");

const STATUSES = ["queued", "working", "paused", "input_required", "completed", "failed", "cancelled"];

/** Every item of the list at `path` (pages of 100). */
async function everyItem(api, path) {
  const items = [];
  for (let cursor = null; ; ) {
    const { status, body } = await api("GET", `${path}${path.includes("?") ? "&" : "?"}limit=100${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(status, 200, JSON.stringify(body));
    items.push(...body.runs);
    if (!(cursor = body.next_cursor)) return items;
  }
}

/** Each listed item against the item main's list built from the run's view (summaryOfView of the run's own read, read
 *  just after), field by field, its keys too. The run's read alone adds what learning spent for it to its cost
 *  (learning_usd, all_in_usd and its parts: server.ts allInViewOf) and what its paid tool calls cost (tools_usd: store-view.ts
 *  toolsUsdOverStore), which no list item carries. */
async function sameAsViews(api, items, why) {
  for (const item of items) {
    const { status, body: view } = await api("GET", `/runs/${item.run_id}`);
    assert.equal(status, 200, JSON.stringify(view));
    const cost = Object.fromEntries(Object.entries(view.cost).filter(([key]) => !["learning_usd", "all_in_usd", "compile_usd", "followup_usd", "shadow_usd", "share_usd", "tools_usd"].includes(key)));
    const expected = summaryOfView({ ...view, cost });
    assert.deepEqual(Object.keys(item).sort(), Object.keys(expected).sort(), `${why}: ${item.run_id} (${expected.status}) lists the same fields`);
    for (const key of Object.keys(expected)) assert.deepEqual(item[key], expected[key], `${why}: ${item.run_id} (${expected.status}) lists ${key} as its read says it`);
  }
}

/** Each status's filtered list holds exactly the runs whose own read says that status. The filtered lists are read first,
 *  so none finds a run by what a list without a filter built just before, and the settled statuses before the others: a
 *  run that settled since its listing was built is found by its row's own write, not by a list of the status it left
 *  building it first. */
async function filtersMatchViews(api, query = "") {
  const filtered = {};
  for (const status of [...STATUSES].reverse()) filtered[status] = (await everyItem(api, `/runs?status=${status}${query ? `&${query.slice(1)}` : ""}`)).map((item) => item.run_id);
  const all = await everyItem(api, `/runs${query}`);
  const statusOf = new Map();
  for (const { run_id } of all) statusOf.set(run_id, (await api("GET", `/runs/${run_id}`)).body.status);
  for (const status of STATUSES) assert.deepEqual(filtered[status], all.map((item) => item.run_id).filter((id) => statusOf.get(id) === status), `status=${status}${query} lists the runs whose read says ${status}`);
}

test("a runs list shows each run as the run's own read does, field by field, in every status, and a status filter finds each where its read says it is", { timeout: 240_000 }, async (t) => {
  // The listings' builder runs only when the test asks (listingSettled): every list after a move is the list's own work.
  const server = await serve(t, { maxRuns: 1, listerIdleMs: Infinity });
  const { api, data } = server;
  assert.equal((await api("POST", "/agents", agent("one"))).status, 201);
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  const start = async (agentId, input) => {
    const started = await api("POST", `/agents/${agentId}/runs`, { input });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return started.body.run_id;
  };
  const held = (file) => ({ content: `Answer once ${join(data, file)} exists.` });

  const completed = await start("one", { content: "What is six times seven?" });
  await follow(api, completed, ["completed"]);
  const failed = await start("one", { content: "Fail now." });
  await follow(api, failed, ["failed"]);
  const workflow = await start("flow", { question: "What is six times seven?" });
  await follow(api, workflow, ["completed"]);
  const archived = await start("one", { content: "What is one plus one?" });
  await follow(api, archived, ["completed"]);
  assert.equal((await api("POST", `/runs/${archived}/archive`)).status, 200);
  const cancelled = await start("one", held("never"));
  await follow(api, cancelled, ["working"]);
  assert.equal((await api("POST", `/runs/${cancelled}/cancel`)).status, 202);
  await follow(api, cancelled, ["cancelled"]);
  const stopped = await start("one", held("never"));
  await follow(api, stopped, ["working"]);
  assert.equal((await api("POST", `/runs/${stopped}/stop`)).status, 200);
  await follow(api, stopped, ["input_required"]);
  // A workflow pauses (an agentic run does not), once the node in flight ends: its first node holds until a file the test
  // makes after the pause, and the second never starts.
  const pause = held("paused").content;
  const twoSteps = answerFlow(pause);
  twoSteps.root.steps.push({ ...twoSteps.root.steps[0], label: "again", instructions: "Answer the question.", as: "again" });
  assert.equal((await api("POST", "/agents", flowAgent("pausing", twoSteps))).status, 201);
  const paused = await start("pausing", { question: pause });
  await follow(api, paused, ["working"]);
  assert.equal((await api("POST", `/runs/${paused}/pause`)).body.paused, true);
  await writeFile(join(data, "paused"), "");
  for (const end = Date.now() + 30_000; (await api("GET", `/runs/${paused}`)).body.status !== "paused"; await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < end, "the workflow reads paused");
  const working = await start("one", held("go"));
  await follow(api, working, ["working"]);
  // The one place is the working run's (the paused run parked and let it go): this one waits for it.
  const queued = await start("one", { content: "What is two plus two?" });

  await server.listingSettled();
  const listed = await everyItem(api, "/runs");
  assert.deepEqual(new Set(listed.map((item) => item.status)), new Set(STATUSES), "a run in every status");
  await sameAsViews(api, listed, "settled");
  await sameAsViews(api, await everyItem(api, "/runs?archived=true"), "archived");
  await filtersMatchViews(api);
  await filtersMatchViews(api, "?agent=one");

  // A run that moves is listed as it is now, without waiting for the server's lister: its row says it is behind.
  await writeFile(join(data, "go"), "");
  await follow(api, working, ["completed"]);
  await follow(api, queued, ["completed"]);
  await filtersMatchViews(api);
  await sameAsViews(api, await everyItem(api, "/runs"), "just moved");
  // A message continues the run a person stopped: it is listed going again at once.
  assert.equal((await api("POST", `/runs/${stopped}/messages`, { content: "What is three plus three?" })).status < 300, true);
  await follow(api, stopped, ["completed", "input_required"]);
  await sameAsViews(api, await everyItem(api, "/runs?agent=one"), "continued");
  // A run that asks its person a question: the ask is its journal's, and the list says input_required as its read does.
  assert.equal((await api("POST", "/agents", agent("asks", { tools: ["ask_person"] }))).status, 201);
  const asks = await start("asks", { content: `Pick a region once ${join(data, "ask")} exists.` });
  await follow(api, asks, ["working"]);
  await sameAsViews(api, await everyItem(api, "/runs?agent=asks"), "before its ask");
  await writeFile(join(data, "ask"), "");
  for (const end = Date.now() + 30_000; (await api("GET", `/runs/${asks}`)).body.status !== "input_required"; await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, "the run asks");
  await sameAsViews(api, await everyItem(api, "/runs?agent=asks"), "asked");
  await filtersMatchViews(api, "?agent=asks");
});

test("a run's learning, and a grade with words that opens the run again, are listed as the run's read says them at once", { timeout: 240_000 }, async (t) => {
  const first = await serve(t);
  assert.equal((await first.api("POST", "/agents", agent("learner", { learning: true }))).status, 201);
  const started = await first.api("POST", "/agents/learner/runs", { input: { content: "What is six times seven?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(first.api, runId, ["completed"], { deadlineMs: 120_000 });
  for (const end = Date.now() + 120_000; !(await first.api("GET", `/runs/${runId}`)).body.learning; await new Promise((resolve) => setTimeout(resolve, 250))) {
    assert.ok(Date.now() < end, "the run's learning is read");
  }
  await first.stop();
  // The same data with no runner and no builder of its own: the run the grade opens again stays queued, and every list
  // shows what the list itself read.
  const { api } = await serve(t, { data: first.data, runner: false, listerIdleMs: Infinity });
  await sameAsViews(api, await everyItem(api, "/runs?agent=learner"), "learning read");
  const before = (await api("GET", `/runs/${runId}`)).body;
  const graded = await api("PUT", `/runs/${runId}/grade`, { correct: false, label: "The answer is forty-two, in words." });
  assert.equal(graded.status, 200, JSON.stringify(graded.body));
  assert.equal(graded.body.feedback, "correction", "the grade's words open the run again");
  // Its correction round waits, with no runner to take it, and the run keeps its end while its learning reflects.
  const opened = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([opened.status, opened.ended_at, opened.result, opened.learning?.state], ["completed", before.ended_at, before.result, "reflecting"], `the run keeps its end while its round waits: ${JSON.stringify(opened)}`);
  assert.ok(opened.poll_after_ms > 0, "read again until its learning settles");
  await sameAsViews(api, await everyItem(api, "/runs?agent=learner"), "graded with words");
  await filtersMatchViews(api, "?agent=learner");
});

test("the server's lister starts once the server knows its own address: a store with runs to build logs no failed build at the start", { timeout: 120_000 }, async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-list-rows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  await storeOf(data, 3, 2);
  const lines = [];
  const server = await startServe({ data, port: 0, faux: FAUX, log: (line) => lines.push(line) });
  try {
    await server.listingSettled();
    assert.deepEqual(lines.filter((line) => line.includes("run_listing_unbuilt")), [], "no listing failed to build");
    const { body } = await client(server.baseUrl, server.token)("GET", "/runs?limit=5");
    assert.equal(body.runs.length, 3);
  } finally {
    await server.close();
  }
});

test("the lister builds every run it may, past a pass's worth of runs whose views fail to build: those wait for their retry, never holding up the rows after them", { timeout: 120_000 }, async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-list-rows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  // 120 runs: 40 completed, 40 failed, 40 working, none built.
  await storeOf(data, 120, 2);
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  t.after(() => store.close());
  // The 40 runs the lister reaches first (newest of those no runner holds) cannot be read: more than one pass reads.
  const first = (await store.runs.behind({ limit: 40 })).map(({ id }) => id);
  const unreadable = new Set(first);
  const runs = new Proxy(store.runs, { get: (target, key) => (key === "get" ? (id) => (unreadable.has(id) ? Promise.reject(new Error(`${id} cannot be read`)) : target.get(id)) : Reflect.get(target, key)) });
  const broken = new Proxy(store, { get: (target, key) => (key === "runs" ? runs : typeof target[key] === "function" ? target[key].bind(target) : Reflect.get(target, key)) });
  const failures = [];
  const lister = createLister(broken, () => ({ origin: "http://127.0.0.1:7340", serverSecrets: () => [] }), { idleMs: Infinity, log: (line) => failures.push(line) });
  t.after(() => lister.stop());
  await lister.settled();
  assert.equal(failures.length, 40, "each unreadable run failed once");
  const left = (await store.runs.behind({ limit: 200 })).filter(({ held }) => !held).map(({ id }) => id);
  assert.deepEqual(left.sort(), [...first].sort(), "every run no runner holds is built but the unreadable ones");
});

test("a status filter finds every run still going whose listing was never built, however many: none is left off for the lister to reach later", { timeout: 300_000 }, async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-list-rows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  // 156 runs: 52 completed, 52 failed and 52 claimed and working, none of whose listings is built (no lister runs here),
  // so no working run's row has a status yet: more than a list builds at once.
  await storeOf(data, 156, 2);
  const server = await startServe({ data, port: 0, faux: FAUX, listerIdleMs: Infinity });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  const working = await everyItem(api, "/runs?status=working");
  assert.equal(working.length, 52, "status=working lists every working run");
  assert.ok(working.every((item) => item.status === "working"));
});

test("a journal commit alone, with the run's row as it was, puts the run's listing behind, so a list shows what it stored", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-list-rows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openSqliteStore({ dataDir: join(dir, "agents"), role: "server" });
  t.after(() => store.close());
  const deps = { origin: "http://127.0.0.1:7340", serverSecrets: () => [] };
  await store.agents.create({ id: "one", name: "one" }, { id: "rev-one", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "one", revisionId: "rev-one" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 3_600_000 });
  const journal = store.journal(claim);
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  const listed = async () => (await store.runs.listed({ archived: false, limit: 50 })).rows[0];
  assert.equal(await store.runs.putListing("run-1", (await listed()).listMark, await listingOverStore(store, "run-1", deps)), true);
  const built = await listed();
  assert.equal(built.behind, false, "the held run's listing is current once built");
  // A turn's answer and its cost: the journal's alone, no row write beside it.
  const answer = { id: await journal.mintId(), conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Forty-two." }], usage: { cost: { total: 0.25 } }, timestamp: 0 }] };
  await commitWrites(journal, [{ type: "entry", value: answer }], BACKGROUND_CONTEXT);
  const now = await summaryOverStore(store, "run-1", deps);
  assert.notDeepEqual(listedItem(built.listing, deps.origin, null, []), now, "the commit moved what the run's read shows");
  assert.equal((await listed()).behind, true, "the commit put the run's listing behind, so the next list builds it again");
  assert.deepEqual(listedItem(await listingOverStore(store, "run-1", deps), deps.origin, null, []), now, "built again, it lists as the run's read");
});

test("a listing built before a write that settled its run is never written over the status that write gave the row: the run stays listed as completed", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-list-rows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openSqliteStore({ dataDir: join(dir, "agents"), role: "server" });
  t.after(() => store.close());
  const deps = { origin: "http://127.0.0.1:7340", serverSecrets: () => [] };
  await store.agents.create({ id: "one", name: "one" }, { id: "rev-one", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "one", revisionId: "rev-one" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 3_600_000 });
  await commitWrites(store.journal(claim), [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  const listed = async () => (await store.runs.listed({ archived: false, limit: 50 })).rows[0];
  // A build reads the mark, then the run's view (not yet over); the run ends before the build writes.
  const { listMark } = await listed();
  const stale = await listingOverStore(store, "run-1", deps);
  assert.notEqual(stale.status, "completed");
  await store.runs.update(claim, { state: "ended", costUsd: 0.01 });
  assert.equal((await listed()).listStatus, "completed", "the write that ended the run set its row's status");
  assert.equal(await store.runs.putListing("run-1", listMark, stale), false, "a listing built before that write is not written");
  const after = await listed();
  assert.equal(after.listStatus, "completed", "the row's status is the ended run's");
  assert.equal(after.behind, true, "the listing is still behind, so the next build writes the ended run's");
  assert.deepEqual((await store.runs.listed({ archived: false, status: "completed", limit: 50 })).rows.map(({ row }) => row.id), ["run-1"], "status=completed finds it");
});

test("a status filter lists a run still going that a write moved while the filter built it: the build is made again over the write, never left off", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-list-rows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  // run-0000 completed, run-0001 failed, run-0002 claimed and working; no listing built (no lister runs here).
  await storeOf(data, 3, 2);
  const server = await startServe({ data, port: 0, faux: FAUX, listerIdleMs: Infinity });
  t.after(() => server.close());
  // Once the filter has read the runs still going whose listings are behind (the read whose WHERE holds the settled-status
  // CASE), a write to the working run's row lands before the filter builds it: its mark moves past the one read.
  const all = Connection.prototype.all;
  let moved = false;
  Connection.prototype.all = function (sql, ...params) {
    const result = all.call(this, sql, ...params);
    if (moved || !/FROM runs JOIN agents/.test(sql) || !/THEN 'completed'/.test(sql)) return result;
    moved = true;
    return result.then(async (rows) => (await this.write([{ sql: "UPDATE runs SET cost_usd = 0.5 WHERE id = 'run-0002'" }]), rows));
  };
  t.after(() => (Connection.prototype.all = all));
  const api = client(server.baseUrl, server.token);
  const working = await everyItem(api, "/runs?status=working");
  assert.ok(moved, "the write landed between the filter's read and its build");
  assert.deepEqual(working.map((item) => item.run_id), ["run-0002"], "status=working lists the run the write moved");
  await sameAsViews(api, working, "the run is listed as its read shows it after the write");
});

test("a status filter reads every run still going whose listing is behind while the lister builds some between its reads: none is skipped", { timeout: 300_000 }, async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-list-rows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  // 153 runs: 51 completed, 51 failed and 51 working, none built: the filter reads the 51 going in two reads of 50.
  await storeOf(data, 153, 2);
  const server = await startServe({ data, port: 0, faux: FAUX, listerIdleMs: Infinity });
  t.after(() => server.close());
  // After the filter's first read of the runs still going whose listings are behind (the read whose WHERE holds the
  // settled-status CASE), the lister writes the listing of the first of them, as it does in the background: that row
  // leaves the set the filter reads, before its second read. The listing it writes is cut of other keys, so the list
  // builds it again when its page reaches it.
  const all = Connection.prototype.all;
  let built;
  Connection.prototype.all = function (sql, ...params) {
    const result = all.call(this, sql, ...params);
    if (built || !/FROM runs JOIN agents/.test(sql) || !/THEN 'completed'/.test(sql)) return result;
    return result.then(async (rows) => {
      built = rows[0].id;
      await this.write([{ sql: `UPDATE runs SET listing = '{"item":{},"cut":"other"}', list_status = 'working', listing_mark = list_mark, listing_live = 0, listing_until = NULL WHERE id = ?`, params: [built] }]);
      return rows;
    });
  };
  t.after(() => (Connection.prototype.all = all));
  const api = client(server.baseUrl, server.token);
  const working = await everyItem(api, "/runs?status=working");
  assert.ok(built, "a listing was written between the filter's reads");
  assert.equal(working.length, 51, "status=working lists every working run");
  assert.ok(working.every((item) => item.status === "working"));
});

/** Run `runId`'s row as a list reads it: its listing, and whether that is behind. */
const listedRow = async (store, runId) => (await store.runs.listed({ archived: false, limit: 50 })).rows.find(({ row }) => row.id === runId);

test("a run whose sign-in could not be read while its listing was built is built again once it can: a list shows it as its own read does", { timeout: 60_000 }, async (t) => {
  const { store, clock } = await storeOn(t);
  const key = randomBytes(32);
  await store.agents.create({ id: "alpha", name: "alpha" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  const pointer = `bb-ctx-LIST-${randomBytes(10).toString("hex")}`;
  await saveSignIn(store, key, { agentId: "alpha", provider: "browserbase", pointer });
  await store.runs.create({ id: "run-1", agentId: "alpha", revisionId: "rev-1" }, { body: { input: { content: "What is six times seven?" }, title: "Six times seven", place: { mode: "runner" }, plane: { browser: "browserbase" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { signInHanded: [createHash("sha256").update(pointer).digest("hex")] });
  const journal = store.journal(claim);
  const answer = { id: await journal.mintId(), conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Forty-two." }], usage: { cost: { total: 0 } }, timestamp: 0 }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }, { type: "entry", value: answer }], BACKGROUND_CONTEXT);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "Forty-two.", costUsd: 0, endedAt: clock.now });
  // The sign-ins read fails while `down`, as a store read that times out does, then reads again.
  const reader = signInsOverStore(store, key, { remove: async () => {} });
  let down = true;
  const signIns = new Proxy(reader, { get: (target, name) => (typeof target[name] === "function" ? (...args) => (down ? Promise.reject(new Error("the sign-ins read timed out")) : target[name](...args)) : Reflect.get(target, name)) });
  const deps = { origin: "http://127.0.0.1:7340", serverSecrets: () => [], signIns, now: () => clock.now };
  const lister = createLister(store, () => deps, { idleMs: Infinity, now: () => clock.now });
  t.after(() => lister.stop());
  await lister.settled();
  const withheld = await listedRow(store, "run-1");
  assert.equal(withheld.behind, false, "built while the read failed");
  down = false;
  const read = await summaryOverStore(store, "run-1", deps);
  assert.notDeepEqual(listedItem(withheld.listing, deps.origin, null, []), read, "the run's own read shows the run once its sign-in reads again");
  // A pass after the lister's retry time.
  clock.now += 60_000;
  await lister.settled();
  const again = await listedRow(store, "run-1");
  assert.deepEqual(listedItem(again.listing, deps.origin, null, []), read, "the list shows the run as its own read does");
});

test("an approval that lands between a background build's read of the agent's learning and its write is read by a later pass: the run's row says what its learning says now", { timeout: 60_000 }, async (t) => {
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-list-rows-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const { store, clock } = await storeOn(t);
  const name = "file-ticket";
  const file = `workflows/${name}/workflow.json`;
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "File the ticket.", learning: true } });
  // The run's compile merge, as it landed: its draft held for the owner's OK.
  const seed = await landWorkflows(store, "agent-1", [{ name, description: "Files a ticket", workflow: JSON.parse(workflow({ name })), status: "pending" }]);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "File it." }, title: "t", place: { mode: "runner" }, learning: { seed, section: "" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "merged", merged: seed, detail: "Waiting for your OK: workflow file-ticket.", workflows: [{ file, name, pending: true }] };
  await store.runs.update(claim, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }] });
  // The agent's statuses as the server reads them: one map per save, the same map while main stands.
  const pending = new Map([[file, { status: "pending" }]]);
  const approved = new Map([[file, { status: "active" }]]);
  let seen = pending;
  const deps = { origin: "http://127.0.0.1:7340", serverSecrets: () => [], statuses: async () => seen, now: () => clock.now };
  const lister = createLister(
    // The approval lands, and the server marks the agent's held listings behind, after the build read its learning and
    // before it writes its listing.
    new Proxy(store, {
      get: (target, key) =>
        key === "runs"
          ? new Proxy(target.runs, {
              get: (runs, method) =>
                method === "putListing"
                  ? async (...args) => {
                      if (seen === pending) {
                        seen = approved;
                        await lister.learningChanged("agent-1");
                      }
                      return runs.putListing(...args);
                    }
                  : typeof runs[method] === "function"
                    ? runs[method].bind(runs)
                    : Reflect.get(runs, method),
            })
          : typeof target[key] === "function"
            ? target[key].bind(target)
            : Reflect.get(target, key),
    }),
    () => deps,
    { idleMs: Infinity, now: () => clock.now },
  );
  t.after(() => lister.stop());
  await lister.settled();
  assert.equal(seen, approved, "the approval landed during the build");
  const read = await summaryOverStore(store, "run-1", deps);
  assert.notDeepEqual(read.learning, (await summaryOverStore(store, "run-1", { ...deps, statuses: async () => pending })).learning, "the approval changes what the run's read says of its learning");
  // Passes after it: none moved the run since.
  await lister.settled();
  const row = await listedRow(store, "run-1");
  assert.deepEqual(listedItem(row.listing, deps.origin, null, []), read, "the list says what its learning says now: the workflow no longer waits");
});

test("an approval that lands between a list's own build of a run's listing (its read of the agent's learning) and its write is read by the lister's next pass: the next list says what its learning says now", { timeout: 120_000 }, async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-list-rows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  const name = "file-ticket";
  const file = `workflows/${name}/workflow.json`;
  const readme = `workflows/${name}/README.md`;
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  try {
    await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "File the ticket.", learning: true } });
    // The run's compile merge, as it landed: its draft held for the owner's OK.
    const seed = await landWorkflows(store, "agent-1", [{ name, description: "Files a ticket", workflow: JSON.parse(workflow({ name })), status: "pending" }]);
    await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "File it." }, title: "t", place: { mode: "runner" }, learning: { seed, section: "" } } });
    const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
    const kept = { state: "merged", merged: seed, detail: "Waiting for your OK: workflow file-ticket.", workflows: [{ file, name, pending: true }] };
    await store.runs.update(claim, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }] });
  } finally {
    await store.close();
  }
  const server = await startServe({ data, port: 0, faux: FAUX, listerIdleMs: Infinity });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  // The lister's first pass (it marks behind every listing that read outside its run) finds no row to build, so the run's
  // listing is the list's to build.
  const all = Connection.prototype.all;
  let hidden = true;
  Connection.prototype.all = function (sql, ...params) {
    return hidden && /AS behind ORDER BY held/.test(sql) ? Promise.resolve([]) : all.call(this, sql, ...params);
  };
  t.after(() => (Connection.prototype.all = all));
  await server.listingSettled();
  hidden = false;
  // The approval lands once the list's build has read the agent's learning (its read of the items at the newest save
  // ends), before that build writes the listing. The run's row then holds no listing, so the agent's held listings the
  // approval marks behind are none.
  let armed = false;
  let approved = false;
  const approve = async () => {
    const other = await openSqliteStore({ dataDir: data, role: "runner" });
    try {
      const text = (await learningAt(other, "agent-1")).text(readme);
      assert.equal((await changeWorkflow(other, "agent-1", readme, { action: "approve", ifMatch: `"${blobOid(text)}"`, refuse: [] })).status, 200);
    } finally {
      await other.close();
    }
    approved = true;
  };
  const hiding = Connection.prototype.all;
  Connection.prototype.all = async function (sql, ...params) {
    const rows = await hiding.call(this, sql, ...params);
    if (armed && /FROM learning_items WHERE agent_id = \? AND version <= \?/.test(sql)) {
      armed = false;
      await approve();
    }
    return rows;
  };
  armed = true;
  const built = await everyItem(api, "/runs");
  assert.ok(approved, "the approval landed during the list's build");
  assert.match(String(built[0].learning?.detail ?? ""), /Waiting for your OK/, "the list built the run's listing from its learning as it read it");
  // The lister's pass after it: no write moved the run since.
  await server.listingSettled();
  await sameAsViews(api, await everyItem(api, "/runs"), "the list says what its learning says now: the workflow no longer waits");
});

/** Counts the store calls each GET of a runs list makes, and the rows its reads hand back: every call on a store connection
 *  made while that request is handled (its async context), none of the server's own background work. */
function storeCallsPerList(t) {
  const request = new AsyncLocalStorage();
  let last;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, req, ...rest) {
    if (event === "request" && req.method === "GET" && /^\/v2\/runs(\?|$)/.test(req.url)) return request.run((last = { calls: 0, rows: 0 }), () => emit.call(this, event, req, ...rest));
    return emit.call(this, event, req, ...rest);
  };
  t.after(() => (http.Server.prototype.emit = emit));
  for (const name of ["exec", "run", "runCounted", "get", "all", "write", "transaction"]) {
    const original = Connection.prototype[name];
    Connection.prototype[name] = function (...args) {
      const counted = request.getStore();
      const result = original.apply(this, args);
      if (!counted) return result;
      counted.calls++;
      if (name === "all") return result.then((rows) => ((counted.rows += rows.length), rows));
      if (name === "get") return result.then((row) => ((counted.rows += row === undefined ? 0 : 1), row));
      return result;
    };
    t.after(() => (Connection.prototype[name] = original));
  }
  /** The calls and rows of the last list request. */
  return () => last;
}

/** A store of `count` runs of one agent, each with `entries` journal entries (the person's message, then the agent's
 *  answers): a third completed, a third failed, the rest claimed and working under a long lease (no runner beside the
 *  server here). Made through the store's own calls. */
async function storeOf(data, count, entries) {
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  try {
    await store.agents.create({ id: "bench", name: "bench" }, { id: "rev-bench", kind: "agentic", body: { instructions: "Answer." } });
    for (let i = 0; i < count; i++) {
      const id = `run-${String(i).padStart(4, "0")}`;
      await store.runs.create({ id, agentId: "bench", revisionId: "rev-bench" });
      const claim = await store.claim(id, "runner-a", { leaseMs: 3_600_000 });
      const journal = store.journal(claim);
      const writes = [{ type: "conversation", value: { id: 1 } }, { type: "entry", value: { id: await journal.mintId(), conversationId: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "Go on." }], timestamp: 0 }] } }];
      for (let e = 1; e < entries; e++) writes.push({ type: "entry", value: { id: await journal.mintId(), conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: `Step ${e}.` }], usage: { cost: { total: 0.001 } }, timestamp: 0 }] } });
      await commitWrites(journal, writes, BACKGROUND_CONTEXT);
      if (i % 3 === 0) await store.runs.update(claim, { state: "ended", costUsd: 0.01 });
      else if (i % 3 === 1) await store.runs.update(claim, { state: "failed", costUsd: 0.01 });
    }
  } finally {
    await store.close();
  }
}

// A page of 5, under each status's count at 20 runs: a list that cuts its page in the query reads the same rows at both.
test("one runs list makes the same store calls, and reads the same rows, at 20 runs and at 200: none per run, with a status filter or without", { timeout: 300_000 }, async (t) => {
  const callsOfLast = storeCallsPerList(t);
  const calls = {};
  const rows = {};
  for (const count of [20, 200]) {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-list-rows-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const data = join(dir, "agents");
    await storeOf(data, count, 5);
    const server = await startServe({ data, port: 0, faux: FAUX, listerIdleMs: Infinity });
    try {
      await server.listingSettled?.();
      const api = client(server.baseUrl, server.token);
      for (const query of ["", "?status=working", "?status=failed", "?status=input_required"]) {
        const answer = await api("GET", `/runs${query}${query ? "&" : "?"}limit=5`);
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        assert.equal(answer.body.runs.length, query === "?status=input_required" ? 0 : 5, `${query}: a full page`);
        const counted = callsOfLast();
        (calls[query || "all"] ??= {})[count] = counted?.calls;
        (rows[query || "all"] ??= {})[count] = counted?.rows;
      }
    } finally {
      await server.close();
    }
  }
  for (const [query, at] of Object.entries(calls)) {
    assert.ok(Number.isInteger(at[20]) && at[20] > 0, `${query}: the list's calls were counted (${JSON.stringify(at)})`);
    assert.equal(at[200], at[20], `${query}: one list makes ${at[20]} store calls at 20 runs and ${at[200]} at 200: the same, none per run`);
    assert.ok(at[200] <= 2, `${query}: one list makes at most two store calls with nothing behind (${at[200]})`);
    const read = rows[query];
    assert.equal(read[200], read[20], `${query}: one list reads ${read[20]} rows at 20 runs and ${read[200]} at 200: the same, its page cut in the query`);
  }
});
