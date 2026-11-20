// A run a learned workflow served says so where runs are read, from the one read the cost per run makes (its record's
// metrics.path, store-reads/learning.ts pathViewOf over pathOfRow), never a second rule:
//   - GET /v2/runs/{id} and its row of GET /v2/runs (and of the agent's own list) carry `path` and, on a run the workflow
//     answered alone (path `workflow`) or one it handed back (path `handed_back`), `workflow: { name, digest, repick }`;
//   - `repick` says whether the served workflow's answer re-picked after a quote miss (learn/check.ts), from its run's
//     metrics `loops` (workflow-first.ts pathMetrics): `found` when its second pass found its quotes, `missed` when it
//     still missed, null with no second pass. Only a row its run marked a re-pick (`repick`, check.ts repickLabels)
//     counts: an ordinary loop that ran twice, another workflow's loop, or a re-pick that ran once is none;
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

test("a served run carries its path and workflow on its read and on every list row, a handed-back run likewise, each saying whether its answer re-picked; an agent run, a replay, a run with no path and one at work carry no workflow", async (t) => {
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
  const loop = (iterations, met, workflow = "mcc-guess") => ({ node: "repick", iterations, met, repick: true, workflow });
  const refine = { node: "refine", iterations: 2, met: true, workflow: "mcc-guess" };
  const served = (loops, path = "workflow") => ({ path, workflow: "mcc-guess", workflow_digest: DIGEST, loops });
  await end("repick-found", served([refine, loop(2, true)]));
  await end("repick-missed", served([loop(2, false)], "handed_back"));
  await end("first-pass", served([loop(1, true)]));
  await end("other-flow", served([loop(2, true, "inner-flow"), loop(1, true)]));
  await end("ordinary-loop", served([refine]));

  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const meets = (path, value) => assert.deepEqual(schemaProblems(doc, doc.paths[path].get.responses["200"].content["application/json"].schema, value), [], `${path}: ${JSON.stringify(value)}`);
  const expected = {
    "by-agent": { path: "agent", workflow: null },
    "served-1": { path: "workflow", workflow: { name: "mcc-guess", digest: DIGEST, repick: null } },
    "handed-1": { path: "handed_back", workflow: { name: "mcc-guess", digest: DIGEST, repick: null } },
    "replay-1": { path: "replay", workflow: null },
    "no-path": { path: null, workflow: null },
    "at-work": { path: null, workflow: null },
    "repick-found": { path: "workflow", workflow: { name: "mcc-guess", digest: DIGEST, repick: "found" } },
    "repick-missed": { path: "handed_back", workflow: { name: "mcc-guess", digest: DIGEST, repick: "missed" } },
    "first-pass": { path: "workflow", workflow: { name: "mcc-guess", digest: DIGEST, repick: null } },
    "other-flow": { path: "workflow", workflow: { name: "mcc-guess", digest: DIGEST, repick: null } },
    "ordinary-loop": { path: "workflow", workflow: { name: "mcc-guess", digest: DIGEST, repick: null } },
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
  const repicked = { "repick-found": "workflow", "repick-missed": "handed_back", "first-pass": "workflow", "other-flow": "workflow", "ordinary-loop": "workflow" };
  assert.deepEqual(paths, { "by-agent": "agent", "served-1": "workflow", "handed-1": "handed_back", "replay-1": "replay", ...repicked }, JSON.stringify(cost.runs));
  for (const [id, path] of Object.entries(paths)) assert.equal(expected[id].path, path, `${id}: the run views say the path the cost series says`);
});
