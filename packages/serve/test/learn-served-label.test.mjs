// A run a learned workflow served says so where runs are read, from the one read the cost per run makes (its record's
// metrics.path, store-reads/learning.ts servedViewOf over pathOfRow), never a second rule:
//   - GET /v2/runs/{id} and its row of GET /v2/runs (and of the agent's own list) carry `served: { workflow, digest }` on
//     a run the workflow answered alone (path `workflow`), `handed_back: { workflow, digest }` on one it handed back;
//   - a run by the agent, a check's replay run and a run whose record names no path carry neither, nor does a run that
//     has not ended;
//   - every run reads as GET .../learning/cost places it, and each answer meets the document.
import assert from "node:assert/strict";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { agent, serve } from "./support.mjs";

const DIGEST = "d".repeat(16);
const REPLAYED = "e".repeat(16);
const LEARNS = { input: { content: "Which MCC fits a coffee shop?" }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0, workflows: ["mcc-guess"] } };

test("a served run carries served on its read and on every list row; a handed-back run carries handed_back; an agent run, a replay, a run with no path and one at work carry neither", async (t) => {
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
    "by-agent": {},
    "served-1": { served: { workflow: "mcc-guess", digest: DIGEST } },
    "handed-1": { handed_back: { workflow: "mcc-guess", digest: DIGEST } },
    "replay-1": {},
    "no-path": {},
    "at-work": {},
  };
  const shown = (item) => Object.fromEntries(["served", "handed_back"].filter((key) => key in item).map((key) => [key, item[key]]));

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

  // The same runs as the cost per run places them: `served` exactly where its path is `workflow`.
  const cost = (await api("GET", "/agents/source/learning/cost")).body;
  const paths = Object.fromEntries(cost.runs.map((run) => [run.run_id, run.path]));
  assert.deepEqual(paths, { "by-agent": "agent", "served-1": "workflow", "handed-1": "handed_back", "replay-1": "replay" }, JSON.stringify(cost.runs));
  for (const [id, path] of Object.entries(paths)) {
    assert.equal("served" in expected[id], path === "workflow", `${id}: served where the cost series says workflow`);
    assert.equal("handed_back" in expected[id], path === "handed_back", `${id}: handed_back where it says handed_back`);
  }
});

test("a served run's listing saved under an older listing format is built again on its next list read, then reads current: the list says served as the run's read does", async (t) => {
  // No lister passes and no runner: only a list builds a listing here, so each build counted is a list's.
  const { api, store } = await serve(t, { learning: "on", runner: false, listerIdleMs: Infinity });
  assert.equal((await api("POST", "/agents", agent("source", { learning: {} }))).status, 201);
  const revisionId = (await store.agents.get("source")).currentRevision;
  await store.runs.create({ id: "served-old", agentId: "source", revisionId }, { body: LEARNS });
  const claim = await store.claim("served-old", "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "ended", costUsd: 0.04, metrics: { path: "workflow", workflow: "mcc-guess", workflow_digest: DIGEST } });
  const served = { workflow: "mcc-guess", digest: DIGEST };
  assert.deepEqual((await api("GET", "/runs/served-old")).body.served, served);

  // Each write of a run's listing (Runs.putListing), the server's and this test's alike.
  const { Connection } = await import("../dist/store/sqlite/connection.js");
  const write = Connection.prototype.write;
  let builds = 0;
  Connection.prototype.write = function (statements, ...rest) {
    builds += statements.filter(({ sql }) => /^UPDATE runs SET listing = /.test(sql)).length;
    return write.call(this, statements, ...rest);
  };
  t.after(() => (Connection.prototype.write = write));
  const listed = async () => (await store.runs.listed({ agentId: "source", archived: false, limit: 50 })).rows.find(({ row }) => row.id === "served-old");
  const read = async (path) => {
    const { status, body } = await api("GET", path);
    assert.equal(status, 200, JSON.stringify(body));
    const item = body.runs.find(({ run_id }) => run_id === "served-old");
    assert.ok(item, `${path} lists the run`);
    return item;
  };

  for (const path of ["/runs?agent=source", "/agents/source/runs"]) {
    // The run's listing as a server of an older listing format saved it: current by its mark and its cut, its item
    // without the served field that format did not have, and nothing else in it.
    await read(path);
    const { listing, listMark } = await listed();
    const { served: _served, ...item } = listing.item;
    assert.equal(await store.runs.putListing("served-old", listMark, { item, cut: listing.cut, status: "completed", live: false, until: null, flags: 0 }), true);
    const saved = await listed();
    assert.equal(saved.behind, false, "the old listing is current by its mark and its clock");
    assert.deepEqual(Object.keys(saved.listing).sort(), ["cut", "item"], "the old listing carries its item and cut alone");
    assert.equal("served" in saved.listing.item, false);

    builds = 0;
    assert.deepEqual((await read(path)).served, served, `${path}: the old listing is built again and says served`);
    assert.equal(builds, 1, `${path}: one build of the old listing`);
    assert.deepEqual((await listed()).listing.item.served, served, "the listing written back says served");
    builds = 0;
    for (const again of ["/runs?agent=source", "/agents/source/runs"]) assert.deepEqual((await read(again)).served, served, `${again} after ${path}`);
    assert.equal(builds, 0, `${path}: once built again, the listing is current: no read builds it`);
  }
});
