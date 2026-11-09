// Shared by the run custody tests over the store path (run-custody-reads, sign-ins-reads): a server whose browser is on
// Browserbase (faux), a real run that repeats what it is told (the faux model's "Hold, then echo"), the agent's sign-in
// saved as a run's save keeps it, and a run's row marked as the runner marks a run it hands a sign-in (sign_in_handed,
// the SHA-256 of each pointer). No sleeps, no process deaths: a seal key change is a server started again on the data.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { forgetSignIn, saveSignIn } from "../dist/sign-ins-store.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { KEY as BB_KEY } from "./fixtures/faux-browserbase-check.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

export const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
export const FAUX_BROWSERBASE = new URL("./fixtures/faux-browserbase-check.mjs", import.meta.url).pathname;
const ENV = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "BROWSERBASE_BASE_URL", "BROWSERBASE_CONNECT_BASE_URL", "AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY"];
export const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
/** A distinct, real-looking Browserbase context id. */
export const pointerOf = (tag = "CUSTODY") => `bb-ctx-${tag}-${randomBytes(10).toString("hex")}`;

/** A server whose seal key is `seal`, its browser on Browserbase (faux). With `agentTools`, one agent `alpha` of those
 *  tools is made. `options` reach serve() (a `data` of an earlier server's, `allowCodeNodes`). */
export async function server(t, { seal = randomBytes(32), agentTools = ["browser"], env = {}, ...options } = {}) {
  withEnv(t, { BROWSERBASE_API_KEY: BB_KEY, BROWSERBASE_PROJECT_ID: "proj-1", AGENTRUN_SEAL_KEY: seal.toString("base64"), ...env }, ENV);
  const served = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE, ...options });
  if (agentTools) assert.equal((await served.api("POST", "/agents", agent("alpha", { tools: agentTools }))).status, 201);
  return { ...served, seal };
}

/** The same data served again under seal key `seal` (another, or the first back): the earlier server closed first. */
export async function reserved(t, earlier, seal, options = {}) {
  await earlier.close();
  process.env.AGENTRUN_SEAL_KEY = seal.toString("base64");
  const served = await serve(t, { data: earlier.data, fauxBrowser: FAUX_BROWSER, fauxBrowserbase: FAUX_BROWSERBASE, ...options });
  return { ...served, seal };
}

/** A run of `alpha` whose message, so its title and its answer ("On <message>: done."), holds `said`. Ended unless
 *  `hold`: then it waits (running) until its gate's file is made by the returned `release`. */
export async function runSaying({ api, data }, said, { hold = false } = {}) {
  const gate = join(data, "..", `gate-${randomBytes(4).toString("hex")}`);
  if (!hold) writeFileSync(gate, "");
  const started = await api("POST", "/agents/alpha/runs", { input: { content: `${said} Hold, then echo, until ${gate}.` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  if (!hold) await follow(api, runId, ["completed", "failed"]);
  return { runId, release: () => writeFileSync(gate, "") };
}

/** Runs `work` over a runner's store handle on the server's data (beside the running server, as a runner holds one). */
export async function overStore({ data }, work) {
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  try {
    return await work(store);
  } finally {
    await store.close();
  }
}

/** Saves `pointer` as alpha's Browserbase sign-in, as a run's save keeps it. */
export const saved = (s, pointer) => overStore(s, (store) => saveSignIn(store, s.seal, { agentId: "alpha", provider: "browserbase", pointer }));

/** Forgets alpha's Browserbase sign-in: its pointer to a tombstone, kept only for cutting. */
export const forgotten = (s) => overStore(s, (store) => forgetSignIn(store, s.seal, { remove: async () => undefined }, "alpha", "browserbase"));

/** Writes `sql` with `params` on the server's store file (a row as the runner writes it), as the store's own writer
 *  writes (store/sqlite/worker.ts): BEGIN IMMEDIATE takes the write lock before anything is read, so the busy timeout
 *  covers another writer in flight. A plain autocommit UPDATE reads first and upgrades after, and a commit by the server
 *  or its runner in between fails it at once ("database is locked", a stale snapshot the timeout never waits out). */
export function written({ data }, sql, ...params) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { timeout: 10_000 });
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(sql).run(...params);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Marks run `runId`'s row with `mark` as its sign_in_handed (as the runner writes it at its claim; null: none). */
export const marked = (s, runId, mark) => written(s, "UPDATE runs SET sign_in_handed = ? WHERE id = ?", mark === null ? null : JSON.stringify(mark), runId);

/** What is served of run `runId`: its view, its row in both lists (all runs, alpha's), and its Timeline page. */
export async function reads({ api }, runId, agentId = "alpha") {
  const view = (await api("GET", `/runs/${runId}`)).body;
  const lists = [(await api("GET", "/runs")).body, (await api("GET", `/agents/${agentId}/runs`)).body].map((body) => body.runs.find((run) => run.run_id === runId));
  const timeline = (await api("GET", `/runs/${runId}/timeline`)).body;
  return { view, lists, timeline };
}

/** Asserts nothing served (`shown`, each by its name) holds any of `needles`. */
export function holdsNone(shown, ...needles) {
  for (const [where, value] of Object.entries(shown)) for (const needle of needles) assert.ok(!JSON.stringify(value).includes(needle), `${where} holds ${needle}: ${JSON.stringify(value)}`);
}
