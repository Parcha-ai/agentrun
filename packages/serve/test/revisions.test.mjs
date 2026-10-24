// Edits are revisions: each definition an agent had is kept, a run pins one, and every run of every agent is listed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, answerFlow, flowAgent, follow, serve, startRun, storeRun } from "./support.mjs";

test("PUT definition commits a new revision whose parent is the current one and makes it current; skills carry over", async (t) => {
  const { api } = await serve(t);
  const created = (await api("POST", "/agents", { ...agent("editor", { skills: ["cite"] }), skills: { "cite/SKILL.md": "# Cite\n" } })).body;
  const put = await api("PUT", "/agents/editor/definition", { definition: { name: "editor", instructions: "Answer briefly.", skills: ["cite"], tools: ["read"] }, note: "shorter answers" });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.notEqual(put.body.revision, created.revision);
  assert.equal(put.headers.get("etag"), `"${put.body.revision}"`);
  assert.deepEqual(put.body.definition, { id: "editor", version: 2, name: "editor", instructions: "Answer briefly.", skills: ["cite"], tools: ["read"] });
  assert.deepEqual(put.body.skills.map((s) => s.path), ["cite/SKILL.md"], "the current revision's skill files carry over");
  assert.equal(put.body.revisions, 2);
  const list = (await api("GET", "/agents/editor/revisions")).body;
  assert.deepEqual(list.revisions.map((r) => [r.revision, r.version, r.parent, r.current, r.kind]), [
    [put.body.revision, 2, created.revision, true, "agentic"],
    [created.revision, 1, null, false, "agentic"],
  ]);
  assert.equal(list.revisions[0].note, "shorter answers");
  assert.equal(list.revisions[1].definition.instructions, "Answer.");
  assert.equal(list.next_cursor, null);
  assert.equal((await api("GET", "/agents/editor/revisions?limit=1")).body.revisions.length, 1);
  assert.equal((await api("GET", "/agents/nobody/revisions")).status, 404);
});

test("a PUT of the revision the agent already has writes nothing, so a PUT sent twice makes one revision", async (t) => {
  const { api } = await serve(t);
  await api("POST", "/agents", { ...agent("twice", { skills: ["cite"] }), skills: { "cite/SKILL.md": "# Cite\n" } });
  const edit = { definition: { instructions: "Answer briefly.", skills: ["cite"], tools: ["read"], version: 2 } };
  const first = await api("PUT", "/agents/twice/definition", edit);
  const again = await api("PUT", "/agents/twice/definition", edit);
  assert.deepEqual([first.status, again.status], [200, 200], JSON.stringify(again.body));
  assert.equal(again.body.revision, first.body.revision);
  assert.deepEqual([again.body.revisions, again.body.definition.version], [2, 2]);
  const same = await api("PUT", "/agents/twice/definition", { definition: { instructions: "Answer briefly.", tools: ["read"] }, skills: { "cite/SKILL.md": "# Cite\n" } });
  assert.equal(same.body.revision, first.body.revision, "the same skill text is the same revision");
  assert.equal((await api("GET", "/agents/twice/revisions")).body.revisions.length, 2);
});

test("PUT definition: If-Match must name the current revision, a name it does not keep is refused, and a workflow edit is checked", async (t) => {
  const { api } = await serve(t);
  const created = (await api("POST", "/agents", agent("guarded"))).body;
  const stale = await api("PUT", "/agents/guarded/definition", { definition: { instructions: "x" } }, { "if-match": '"not-it"' });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.error.code, "precondition_failed");
  const renamed = await api("PUT", "/agents/guarded/definition", { definition: { name: "other", instructions: "x" } });
  assert.deepEqual(renamed.body.error.fields.map((f) => [f.field, f.reason]), [["definition.name", "not_allowed"]]);
  const wrongId = await api("PUT", "/agents/guarded/definition", { definition: { id: "else", instructions: "x" } });
  assert.deepEqual(wrongId.body.error.fields.map((f) => [f.field, f.reason]), [["definition.id", "not_an_option"]]);
  const broken = await api("PUT", "/agents/guarded/definition", { definition: { workflow: { v: 2, name: "bad" } } });
  assert.equal(broken.status, 422);
  assert.equal(broken.body.error.fields[0].field, "definition.workflow");
  const ok = await api("PUT", "/agents/guarded/definition", { definition: { workflow: answerFlow() } }, { "if-match": created.home_etag });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.kind, "workflow");
  assert.deepEqual(ok.body.definition, { id: "guarded", version: 2, name: "guarded", workflow: answerFlow(), skills: [], tools: [] });
  assert.equal((await api("PUT", "/agents/nobody/definition", { definition: { instructions: "x" } })).status, 404);
});

test("POST current makes an earlier revision current again; a revision of another agent is refused", async (t) => {
  const { api } = await serve(t);
  const first = (await api("POST", "/agents", agent("back"))).body;
  const second = (await api("PUT", "/agents/back/definition", { definition: { instructions: "Second." } })).body;
  const other = (await api("POST", "/agents", agent("other"))).body;
  const moved = await api("POST", "/agents/back/current", { revision: first.revision });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.revision, moved.body.definition.version, moved.body.definition.instructions], [first.revision, 1, "Answer."]);
  assert.equal(moved.headers.get("etag"), `"${first.revision}"`);
  const third = (await api("PUT", "/agents/back/definition", { definition: { instructions: "Third." } })).body;
  const revisions = (await api("GET", "/agents/back/revisions")).body.revisions;
  assert.deepEqual(revisions.map((r) => [r.version, r.parent]), [[3, first.revision], [2, first.revision], [1, null]], "an edit's parent is the revision current when it was made");
  assert.equal(third.definition.version, 3);
  const foreign = await api("POST", "/agents/back/current", { revision: other.revision });
  assert.equal(foreign.status, 422);
  assert.deepEqual(foreign.body.error.fields.map((f) => f.field), ["revision"]);
  assert.equal((await api("POST", "/agents/back/current", {})).status, 422);
  assert.equal((await api("POST", "/agents/back/current", { revision: second.revision, extra: 1 })).status, 422);
});

test("a run pins its revision: the current one by default, or the one named; the store's row says which", async (t) => {
  const { api, data } = await serve(t);
  const first = (await api("POST", "/agents", agent("pinned"))).body;
  await api("PUT", "/agents/pinned/definition", { definition: { instructions: "Answer with care." } });
  const current = await api("POST", "/agents/pinned/runs", { input: { content: "What is six times seven?" } });
  const older = await api("POST", "/agents/pinned/runs", { input: { content: "What is six times seven?" }, revision: first.revision });
  assert.equal(older.status, 202, JSON.stringify(older.body));
  assert.deepEqual([current.body.agent_version, older.body.agent_version, older.body.revision], [2, 1, first.revision]);
  await follow(api, current.body.run_id, ["completed"]);
  await follow(api, older.body.run_id, ["completed"]);
  assert.equal(storeRun(data, older.body.run_id).revision, first.revision);
  assert.notEqual(storeRun(data, current.body.run_id).revision, first.revision);
  const unknown = await api("POST", "/agents/pinned/runs", { input: { content: "x" }, revision: "f".repeat(64) });
  assert.equal(unknown.status, 422);
  assert.deepEqual(unknown.body.error.fields.map((f) => f.field), ["revision"]);
  const byRevision = (await api("GET", `/runs?revision=${first.revision}`)).body.runs;
  assert.deepEqual(byRevision.map((r) => r.run_id), [older.body.run_id]);
});

test("GET /runs lists every agent's runs newest first, filtered by agent, revision and status, a page at a time", async (t) => {
  const { api } = await serve(t);
  const a = await startRun(api, "one", "What is six times seven?");
  const b = await startRun(api, "two", "Fail now.");
  await follow(api, a.run_id, ["completed"]);
  await follow(api, b.run_id, ["failed"]);
  const c = (await api("POST", "/agents/one/runs", { input: { content: "What is six times seven?" } })).body;
  await follow(api, c.run_id, ["completed"]);
  const all = (await api("GET", "/runs")).body;
  assert.deepEqual(all.runs.map((r) => r.run_id), [c.run_id, b.run_id, a.run_id]);
  assert.deepEqual(Object.keys(all.runs[0]).sort(), ["agent_id", "agent_version", "cost", "created_at", "ended_at", "error", "kind", "revision", "run_id", "sha", "state", "status", "title"]);
  assert.deepEqual((await api("GET", "/runs?agent=one")).body.runs.map((r) => r.run_id), [c.run_id, a.run_id]);
  assert.deepEqual((await api("GET", "/runs?status=failed")).body.runs.map((r) => [r.run_id, r.agent_id, r.error.code]), [[b.run_id, "two", "run_failed"]], "a failed run keeps its own error");
  assert.equal(all.runs[0].error, null);
  const page = (await api("GET", "/runs?limit=2")).body;
  assert.deepEqual(page.runs.map((r) => r.run_id), [c.run_id, b.run_id]);
  assert.deepEqual((await api("GET", `/runs?limit=2&cursor=${page.next_cursor}`)).body, { runs: [all.runs[2]], next_cursor: null });
  assert.equal((await api("GET", "/runs?status=done")).status, 400);
  assert.equal((await api("GET", "/runs?limit=101")).status, 400);
  assert.deepEqual((await api("GET", "/runs?agent=nobody")).body, { runs: [], next_cursor: null });
});

test("a workflow agent: its definition carries the workflow, its kind is workflow, and its runs are listed with the kind", async (t) => {
  const { api } = await serve(t);
  const created = await api("POST", "/agents", flowAgent("flow"));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.kind, created.body.definition.workflow.name], ["workflow", "answer"]);
  assert.equal((await api("POST", "/agents", flowAgent("bad", { v: 2, name: "bad" }))).body.error.fields[0].field, "definition.workflow");
  assert.equal((await api("GET", "/agents/bad")).status, 404, "a refused workflow makes no agent");
});
