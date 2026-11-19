// A run a learned workflow served says so where runs are read, from the one read the cost per run makes (its record's
// metrics.path, store-reads/learning.ts pathViewOf over pathOfRow), never a second rule:
//   - GET /v2/runs/{id} and its row of GET /v2/runs (and of the agent's own list) carry `path` and, on a run the workflow
//     answered alone (path `workflow`) or one it handed back (path `handed_back`), `workflow: { name, digest }`;
//   - a run by the agent, a check's replay run and a run whose record names no path carry no `workflow` (the last, and a
//     run that has not ended, a null `path`);
//   - every run reads as GET .../learning/cost places it, and each answer meets the document.
import assert from "node:assert/strict";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { agent, serve } from "./support.mjs";

const DIGEST = "d".repeat(16);
const REPLAYED = "e".repeat(16);
const LEARNS = { input: { content: "Which MCC fits a coffee shop?" }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0, workflows: ["mcc-guess"] } };

test("a served run carries its path and workflow on its read and on every list row, a handed-back run likewise; an agent run, a replay, a run with no path and one at work carry no workflow", async (t) => {
  // No runner: each run is ended in the store as a runner ends it, with the metrics its end writes (workflow-first.ts pathMetrics).
  const { api, store, baseUrl } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("source", { learning: {} }))).status, 201);
  const revisionId = (await store.agents.get("source")).currentRevision;
  const end = async (id, metrics, costUsd = 0.04) => {
    await store.runs.create({ id, agentId: "source", revisionId }, { body: LEARNS });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    if (metrics !== "running") await store.runs.update(claim, { state: "ended", costUsd, ...(metrics === undefined ? {} : { metrics }) });
  };
  await end("by-agent", { path: "agent" }, 0.9);
  await end("served-1", { path: "workflow", workflow: "mcc-guess", workflow_digest: DIGEST });
  await end("handed-1", { path: "handed_back", workflow: "mcc-guess", workflow_digest: DIGEST }, 0.5);
  await end("replay-1", { path: "replay", workflow: "mcc-guess", workflow_digest: REPLAYED }, 0.05);
  // Its end wrote no path (its patch was late): what it took is not known, so it is said to be nothing.
  await end("no-path", undefined);
  // Claimed and at work: not ended, so no path yet.
  await end("at-work", "running");

  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const meets = (path, value) => assert.deepEqual(schemaProblems(doc, doc.paths[path].get.responses["200"].content["application/json"].schema, value), [], `${path}: ${JSON.stringify(value)}`);
  const expected = {
    "by-agent": { path: "agent", workflow: null },
    "served-1": { path: "workflow", workflow: { name: "mcc-guess", digest: DIGEST } },
    "handed-1": { path: "handed_back", workflow: { name: "mcc-guess", digest: DIGEST } },
    "replay-1": { path: "replay", workflow: null },
    "no-path": { path: null, workflow: null },
    "at-work": { path: null, workflow: null },
  };
  const shown = ({ path, workflow }) => ({ path, workflow });

  for (const [id, fields] of Object.entries(expected)) {
    const { status, body } = await api("GET", `/runs/${id}`);
    assert.equal(status, 200, JSON.stringify(body));
    meets("/runs/{run_id}", body);
    assert.deepEqual(shown(body), fields, `GET /runs/${id}`);
  }
  for (const path of ["/runs?agent=source&limit=100", "/agents/source/runs?limit=100"]) {
    const { status, body } = await api("GET", path);
    assert.equal(status, 200, JSON.stringify(body));
    meets(path.startsWith("/agents") ? "/agents/{agent_id}/runs" : "/runs", body);
    assert.deepEqual(body.runs.map((item) => item.run_id).sort(), Object.keys(expected).sort(), path);
    for (const item of body.runs) assert.deepEqual(shown(item), expected[item.run_id], `${path}: ${item.run_id}`);
  }

  // The same runs as the cost per run places them: the run views' `path` is the series'.
  const cost = (await api("GET", "/agents/source/learning/cost")).body;
  const paths = Object.fromEntries(cost.runs.map((run) => [run.run_id, run.path]));
  assert.deepEqual(paths, { "by-agent": "agent", "served-1": "workflow", "handed-1": "handed_back", "replay-1": "replay" }, JSON.stringify(cost.runs));
  for (const [id, path] of Object.entries(paths)) assert.equal(expected[id].path, path, `${id}: the run views say the path the cost series says`);
});

test("lists rebuild same-cut legacy cached rows missing execution path fields, while null fields remain current", async (t) => {
  const { listingOverStore, builtOfNow } = await import("../dist/store-view.js");
  const server = await serve(t, { learning: "on", runner: false, listerIdleMs: Infinity });
  const { api, store, baseUrl } = server;
  assert.equal((await api("POST", "/agents", agent("source", { learning: {} }))).status, 201);
  const revisionId = (await store.agents.get("source")).currentRevision;
  const cases = [
    { id: "legacy", missing: ["path", "workflow"] },
    { id: "missing-path", missing: ["path"] },
    { id: "missing-workflow", missing: ["workflow"] },
    { id: "old-unknown", missing: ["path", "workflow"], unknown: true },
    { id: "unknown", missing: [], unknown: true },
  ];
  for (const { id, unknown } of cases) {
    await store.runs.create({ id, agentId: "source", revisionId }, { body: LEARNS });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", outcome: "completed", costUsd: 0.04,
      ...(unknown ? {} : { metrics: { path: "workflow", workflow: "mcc-guess", workflow_digest: DIGEST } }) });
  }
  await server.listingSettled();
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  for (const path of ["/runs?agent=source&limit=100", "/agents/source/runs?limit=100"]) {
    // Read a real listing first so the fixture keeps the server's current secret digest and write mark.
    assert.equal((await api("GET", path)).status, 200);
    for (const { id, missing, unknown } of cases) {
      const before = (await store.runs.listed({ archived: false, limit: 100 })).rows.find(({ row }) => row.id === id);
      const current = await listingOverStore(store, id, { origin: baseUrl, serverSecrets: () => [] });
      if (missing.length === 0) {
        assert.equal(current.item.path, null); assert.equal(current.item.workflow, null);
        assert.equal(builtOfNow(current, []), true, "null values are current, not absent fields");
        continue;
      }
      const item = { ...before.listing.item, ...(unknown ? {} : { served: { workflow: "mcc-guess", digest: DIGEST } }) };
      for (const key of missing) delete item[key];
      assert.equal(await store.runs.putListing(id, before.listMark, { ...current, item, cut: before.listing.cut }), true);
      const kept = (await store.runs.listed({ archived: false, limit: 100 })).rows.find(({ row }) => row.id === id);
      assert.equal(kept.behind, false, "neither a row change nor an expiry should invalidate this fixture");
      assert.equal(kept.listing.cut, before.listing.cut, "the saved-secret digest did not change");
    }
    const { status, body } = await api("GET", path);
    assert.equal(status, 200);
    const route = path.startsWith("/agents") ? "/agents/{agent_id}/runs" : "/runs";
    assert.deepEqual(schemaProblems(doc, doc.paths[route].get.responses["200"].content["application/json"].schema, body), []);
    for (const { id, unknown } of cases) {
      const item = body.runs.find(row => row.run_id === id);
      assert.deepEqual({ path: item.path, workflow: item.workflow }, unknown
        ? { path: null, workflow: null }
        : { path: "workflow", workflow: { name: "mcc-guess", digest: DIGEST } }, `${path}: ${id}`);
      assert.equal(Object.hasOwn(item, "served"), false);
      assert.equal(Object.hasOwn(item, "handed_back"), false);
      const kept = (await store.runs.listed({ archived: false, limit: 100 })).rows.find(({ row }) => row.id === id);
      assert.equal(Object.hasOwn(kept.listing.item, "path"), true);
      assert.equal(Object.hasOwn(kept.listing.item, "workflow"), true);
    }
  }
});
