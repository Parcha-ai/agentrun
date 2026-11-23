// `agentrun-serve import` of a Factory Droid home: each session a run of source "droid", its Workers in it, its tokens
// the settings.json total on its last request. Every session is the synthetic one fixtures/import-sessions.mjs writes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { runMetricsOf } from "../dist/timeline/index.js";
import { agentIdOf, planImport, runImport } from "../dist/import.js";
import { openSqliteStore } from "../dist/store/index.js";
import { listRuns } from "../dist/store-reads/runs.js";
import { runEntries } from "../dist/store-reads/journal.js";
import { droidSession, sessionId } from "./fixtures/import-sessions.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { client, FAUX, scratch, startServe } from "./support.mjs";

// A scratch config home, never the real ~/.config (the import boots its seal key as the server does).
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "import-droid-config-"));
after(() => rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true }));

const ENV = { PATH: "/usr/bin" };

/** One project under a scratch home, its Droid sessions written by `write(home, project)`, imported. */
async function importedDroid(t, write) {
  const root = await scratch(t);
  const h = { at: join(root, "home"), temp: join(root, "tmp") };
  const project = join(h.at, "code", "droid-project");
  mkdirSync(project, { recursive: true });
  write(h.at, project);
  const data = join(root, "agents");
  const options = { home: h.at, env: ENV, temp: h.temp };
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  let open = true;
  const close = async () => void (open && ((open = false), await store.close()));
  t.after(close);
  const report = await runImport(store, await planImport(options), options);
  const runs = (await listRuns(store, {}, ctx)).sort((a, b) => a.importedFrom.session.localeCompare(b.importedFrom.session));
  return { root, h, project, data, store, close, report, runs };
}

/** A run's stored metrics, checked against its own transcript, and its answers. */
async function metricsOf(store, runId) {
  const entries = await runEntries(store, runId, ctx);
  const { activeMs, effort, costUsdEst, costBasis, ...counted } = (await store.runs.get(runId)).metrics;
  assert.deepEqual(counted, runMetricsOf(entries), "the metrics are what the run's own transcript says");
  return { metrics: counted, costUsdEst, answers: entries.filter((e) => e.kind === "pi.assistant").map((e) => e.model[0]) };
}

test("a Droid home imports as source droid: one run per session, its Worker in it, the settings' total once on the last request", { timeout: 60_000 }, async (t) => {
  const { data, store, close, report, runs } = await importedDroid(t, (home, project) => {
    droidSession(home, project, 1);
    droidSession(home, project, 2, { worker: 1, prompt: "Find the config." });
  });
  assert.equal(report.agents.length, 1);
  assert.deepEqual(runs.map((r) => [r.importedFrom.source, r.importedFrom.session, r.state, r.costUsd ?? null]), [["droid", sessionId(1), "completed", null]], "the Worker is no run of its own");
  const revisions = await store.agents.revisions(report.agents[0].id);
  assert.equal(revisions[0].body.harness, undefined, "Droid's harness is pi's, the default, never stored");
  // The stored metrics count the Worker's requests with the session's (its transcript holds the session's own): each
  // session's total once (100/20/400/30), on its last request. serve's meter reads a request of no input as one whose
  // tokens are unknown: the other two are unmetered, and with them the catalog leaves the run unpriced.
  const { costUsdEst, ...metrics } = (await store.runs.get(runs[0].id)).metrics;
  assert.deepEqual([metrics.requests, metrics.unmetered, metrics.input, metrics.output, metrics.cacheRead, metrics.cacheWrite], [4, 2, 200, 40, 800, 60]);
  assert.deepEqual(metrics.models, { "anthropic/claude-sonnet-5": 4 });
  assert.equal(costUsdEst, undefined, "a run with an unmetered request has no estimate");
  const answers = (await runEntries(store, runs[0].id, ctx)).filter((e) => e.kind === "pi.assistant").map((e) => e.model[0]);
  assert.deepEqual(answers.map((a) => [a.usage.input, a.usage.output]), [[0, 0], [100, 20]], "the session's own: the total on its last request");

  // The server takes the store's owner lock: the import's store is closed first.
  await close();
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => server.close());
  const api = client(server.baseUrl, server.token);
  const view = await api("GET", `/runs/${runs[0].id}`);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.imported_from, { source: "droid", session: sessionId(1) });
  const doc = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/Run" }, view.body), [], JSON.stringify(view.body));
  const page = (await api("GET", `/agents/${report.agents[0].id}/runs`)).body;
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/RunList" }, page), [], JSON.stringify(page));
});

test("a Droid session with no usage (no settings.json, or one with no tokenUsage) imports its requests as unmetered, never as 0 tokens, its cost unknown", async (t) => {
  const { store, runs } = await importedDroid(t, (home, project) => {
    droidSession(home, project, 3, { settings: false });
    droidSession(home, project, 4, { usage: false });
  });
  assert.deepEqual(runs.map((r) => [r.importedFrom.source, r.costUsd ?? null]), [["droid", null], ["droid", null]]);
  for (const run of runs) {
    const { metrics, costUsdEst } = await metricsOf(store, run.id);
    assert.deepEqual([metrics.requests, metrics.unmetered, metrics.input, metrics.cacheRead, metrics.cacheWrite, metrics.output], [2, 2, 0, 0, 0, 0], run.importedFrom.session);
    assert.equal(costUsdEst ?? null, null, "nothing to price");
  }
});

test("a Droid turn that ended on a provider that never answered imports as failed, that request one of its own with the reason as its error", async (t) => {
  const { store, runs } = await importedDroid(t, (home, project) => droidSession(home, project, 5, { failed: true }));
  assert.equal(runs[0].state, "failed");
  const { metrics, answers } = await metricsOf(store, runs[0].id);
  assert.deepEqual([metrics.requests, metrics.unmetered, metrics.input], [3, 2, 100], "the failed request carries the total; the two before it are unmetered");
  assert.deepEqual([answers.at(-1).stopReason, answers.at(-1).errorMessage], ["error", "model_provider_unavailable"]);
});

test("a chosen project's Droid session still being written is left out by the folder its session_start names", async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const project = join(home, "code", "droid-project");
  const other = join(home, "code", "elsewhere");
  for (const dir of [project, other]) mkdirSync(dir, { recursive: true });
  const live = droidSession(home, project, 6, { fresh: true });
  droidSession(home, other, 7, { fresh: true });
  const plan = await planImport({ home, env: ENV, temp: join(root, "tmp"), only: [agentIdOf(project)] });
  assert.deepEqual(plan.skipped.map((entry) => entry.what), [live]);
});
