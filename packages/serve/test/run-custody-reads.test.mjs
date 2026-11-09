// A run's custody on the store path's reads (run-cut.ts): everything served of a run is cut by ONE set, its view's words,
// its title (GET /runs/{id}, both run lists) and its Timeline's rows alike. The set holds every secret this server never
// shows and every browser sign-in pointer the run was handed; a run whose hand can't be read back here (a hash that opens
// to nothing kept, no vendor browser beside its mark, or a mark no server writes) is withheld, its words, title and
// Timeline rows with it. Each run is real (the faux model answers by repeating its message), and its row is marked as the
// runner marks a run it hands a sign-in (sign_in_handed, the SHA-256 of each pointer). No sleeps, no process deaths.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { saveSignIn } from "../dist/sign-ins-store.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { WITHHELD_SIGN_IN } from "../dist/run-view.js";
import { KEY as BB_KEY } from "./fixtures/faux-browserbase-check.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX_BROWSERBASE = new URL("./fixtures/faux-browserbase-check.mjs", import.meta.url).pathname;
const ENV = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "BROWSERBASE_BASE_URL", "BROWSERBASE_CONNECT_BASE_URL", "AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY"];
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** A server whose seal key is `seal`, its browser on Browserbase (faux), with one agent `alpha` (its tools `tools`). */
async function server(t, { seal = randomBytes(32), tools = ["browser"], env = {} } = {}) {
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: seal.toString("base64"), ...env }, ENV);
  const served = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE });
  assert.equal((await served.api("POST", "/agents", agent("alpha", { tools }))).status, 201);
  return { ...served, seal };
}

/** A run of `alpha` whose message, and so its title and its answer ("On <message>: done."), holds `said`; ended. */
async function runSaying({ api, data }, said) {
  const gate = join(data, "..", `gate-${randomBytes(4).toString("hex")}`);
  writeFileSync(gate, "");
  const started = await api("POST", "/agents/alpha/runs", { input: { content: `${said} Hold, then echo, until ${gate}.` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"]);
  return started.body.run_id;
}

/** Saves `pointer` as alpha's Browserbase sign-in, as a run's save keeps it. */
async function saved({ data, seal }, pointer) {
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  try {
    await saveSignIn(store, seal, { agentId: "alpha", provider: "browserbase", pointer });
  } finally {
    await store.close();
  }
}

/** Marks run `runId`'s row with `mark` as its sign_in_handed (as the runner writes it at its claim, as JSON; null: none). */
function marked({ data }, runId, mark) {
  const db = new DatabaseSync(join(data, "store.sqlite"));
  try {
    db.prepare("UPDATE runs SET sign_in_handed = ? WHERE id = ?").run(mark === null ? null : JSON.stringify(mark), runId);
  } finally {
    db.close();
  }
}

/** What is served of run `runId`: its view, its row in both lists, and its Timeline page. */
async function reads({ api }, runId) {
  const view = (await api("GET", `/runs/${runId}`)).body;
  const lists = [(await api("GET", "/runs")).body, (await api("GET", "/agents/alpha/runs")).body].map((body) => body.runs.find((run) => run.run_id === runId));
  const timeline = (await api("GET", `/runs/${runId}/timeline`)).body;
  return { view, lists, timeline };
}

test("a run handed its agent's sign-in, on a browser plane, is served cut of the pointer it repeats: its answer, its title in its view and both lists, and every Timeline row", { timeout: 120_000 }, async (t) => {
  const s = await server(t);
  const pointer = `bb-ctx-CUSTODY-${randomBytes(10).toString("hex")}`;
  const runId = await runSaying(s, pointer);
  await saved(s, pointer);
  marked(s, runId, [sha(pointer)]);
  const { view, lists, timeline } = await reads(s, runId);
  assert.match(view.result.final_answer, /^On \[redacted\] Hold, then echo/, "its answer, cut, not withheld");
  assert.match(view.title, /^\[redacted\] Hold/, "its title, cut");
  for (const row of lists) assert.match(row.title, /^\[redacted\] Hold/, "its title in the lists, cut");
  assert.ok(timeline.rows.some((row) => /On \[redacted\] Hold, then echo/.test(row.text ?? row.summary ?? "")), JSON.stringify(timeline.rows));
  for (const [where, shown] of Object.entries({ view, lists, timeline })) assert.ok(!JSON.stringify(shown).includes(pointer), `${where} holds the pointer`);
});

test("a run whose hand can't be read back here is withheld: its answer, its title in its view and both lists, and its Timeline's rows, in the view's words", { timeout: 120_000 }, async (t) => {
  const s = await server(t);
  const pointer = `bb-ctx-CUSTODY-${randomBytes(10).toString("hex")}`;
  const runId = await runSaying(s, pointer);
  // The agent's sign-in now is another (replaced since): the run's hash opens to nothing kept.
  await saved(s, `bb-ctx-OTHER-${randomBytes(10).toString("hex")}`);
  marked(s, runId, [sha(pointer)]);
  const { view, lists, timeline } = await reads(s, runId);
  assert.equal(view.result?.final_answer ?? null, null);
  assert.equal(view.title, WITHHELD_SIGN_IN);
  for (const row of lists) assert.equal(row.title, WITHHELD_SIGN_IN);
  assert.deepEqual(timeline.rows, [], "no row of what it said");
  assert.equal(timeline.status, view.status, "its status still reads");
  for (const [where, shown] of Object.entries({ view, lists, timeline })) {
    assert.ok(!JSON.stringify(shown).includes(pointer), `${where} holds the pointer`);
    assert.ok(!JSON.stringify(shown).includes("Hold, then echo"), `${where} holds its words`);
  }
});

test("a run marked handed with no vendor browser on its launch is withheld alike: its words, title and Timeline", { timeout: 120_000 }, async (t) => {
  const s = await server(t, { tools: [] });
  const pointer = `bb-ctx-CUSTODY-${randomBytes(10).toString("hex")}`;
  const runId = await runSaying(s, pointer);
  await saved(s, pointer);
  marked(s, runId, [sha(pointer)]);
  const { view, lists, timeline } = await reads(s, runId);
  assert.equal(view.result?.final_answer ?? null, null);
  assert.equal(view.title, WITHHELD_SIGN_IN);
  for (const row of lists) assert.equal(row.title, WITHHELD_SIGN_IN);
  assert.deepEqual(timeline.rows, []);
  for (const shown of [view, lists, timeline]) assert.ok(!JSON.stringify(shown).includes(pointer));
});

test("a mark no server writes (a legacy true, one hash alone, an object, an empty array, a hash beside a number) fails closed: the run is withheld, never served uncut", { timeout: 120_000 }, async (t) => {
  const s = await server(t);
  const pointer = `bb-ctx-CUSTODY-${randomBytes(10).toString("hex")}`;
  const runId = await runSaying(s, pointer);
  await saved(s, pointer);
  for (const mark of [true, sha(pointer), { hash: sha(pointer) }, [], [sha(pointer), 5]]) {
    marked(s, runId, mark);
    const { view, lists, timeline } = await reads(s, runId);
    const what = JSON.stringify(mark);
    assert.equal(view.result?.final_answer ?? null, null, what);
    assert.equal(view.title, WITHHELD_SIGN_IN, what);
    assert.deepEqual(timeline.rows, [], what);
    for (const shown of [view, lists, timeline]) assert.ok(!JSON.stringify(shown).includes(pointer), `${what}: ${JSON.stringify(shown)}`);
  }
  // No mark at all (a run handed none) is served as any run's, cut of the server's secrets alone: the pointer, never
  // handed, is its words as said.
  marked(s, runId, null);
  assert.match((await reads(s, runId)).view.result.final_answer, new RegExp(`^On ${pointer}`));
});

test("a tool key this server holds, repeated by a run handed nothing, is cut from its answer, its title and every Timeline row", { timeout: 120_000 }, async (t) => {
  const key = ["not-a-secret", "custody-tool-key", randomBytes(8).toString("hex")].join("-");
  const s = await server(t, { tools: [], env: { PARALLEL_API_KEY: key } });
  const runId = await runSaying(s, key);
  const { view, lists, timeline } = await reads(s, runId);
  assert.match(view.result.final_answer, /^On \[redacted\] Hold/);
  assert.ok(timeline.rows.some((row) => /On \[redacted\] Hold/.test(row.text ?? row.summary ?? "")), JSON.stringify(timeline.rows));
  for (const [where, shown] of Object.entries({ view, lists, timeline })) assert.ok(!JSON.stringify(shown).includes(key), `${where} holds the key`);
});
