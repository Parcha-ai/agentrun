// GET /runs' `source` filter: the runs imported from one source (`claude-code`, `codex`, ...), or `live` for the runs made
// here (not imported). The console's imported-runs link and Wrapped's "open these sessions as runs" are built on it. A
// source that reads as no name is 400; a second one is 400; a name no run holds lists none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const listed = async (api, query) => {
  const { status, body } = await api("GET", `/runs?${query}`);
  assert.equal(status, 200, JSON.stringify(body));
  return body.runs.map((run) => run.run_id).sort();
};

test("GET /runs' source keeps the runs imported from it; live keeps the runs not imported", { timeout: 120_000 }, async (t) => {
  const { api, store } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const live = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  assert.equal(live.status, 202, JSON.stringify(live.body));
  await follow(api, live.body.run_id, ["completed"]);
  const { agentId, revisionId } = await store.runs.get(live.body.run_id);
  const imported = async (id, source, session) => {
    await store.importRun({ id, agentId, revisionId, importedFrom: { source, session }, launch: { body: { input: { content: "hi" }, title: id, place: { mode: "runner" } } }, startedAt: Date.now(), transcript: [] });
    return id;
  };
  const a = await imported("imp-claude-1", "claude-code", "s1");
  const b = await imported("imp-claude-2", "claude-code", "s2");
  const c = await imported("imp-codex-1", "codex", "s3");

  assert.deepEqual(await listed(api, "source=claude-code"), [a, b].sort());
  assert.deepEqual(await listed(api, "source=codex"), [c]);
  assert.deepEqual(await listed(api, "source=live"), [live.body.run_id], "live is the runs made here");
  assert.deepEqual(await listed(api, "source=pi"), [], "a source no run holds lists none");
  assert.equal((await listed(api, "")).length, 4, "no source: every run");
  assert.equal((await listed(api, "source=claude-code&limit=1")).length, 1, "with a page");

  for (const query of ["source=", "source=Claude%20Code", "source=a:b", "source=claude-code&source=codex"]) {
    const refused = await api("GET", `/runs?${query}`);
    assert.deepEqual([refused.status, refused.body.error?.code], [400, "bad_request"], `${query}: ${JSON.stringify(refused.body)}`);
  }
});
