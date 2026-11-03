// The timeline's one row per action, through the API: capabilities say the shape (features.timeline.actions); a run's
// tool call is one row (its call's, changed in place to its outcome), with no result row, no "Saved" row and no second
// row for ask_person's question; a settled run's usage row is its total.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, follow, serve, startRun } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const shown = (rows) => JSON.stringify(rows.map((r) => [r.kind, r.summary, r.tool_status]));

test("capabilities say the timeline's shape: one row per action", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("GET", "/capabilities")).body.features.timeline.actions, true);
});

test("a harness run's write and read are one row each, its call's, with its outcome; no result row and no Saved row; the settled run ends on its total", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  assert.equal((await api("POST", "/agents", agent("files", { harness: "codex", instructions: "Write then read.", tools: ["read", "write"] }))).status, 201);
  const started = await api("POST", "/agents/files/runs", { input: { content: "go" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows, last } = await follow(api, started.body.run_id, ["completed"], { deadlineMs: 55_000 });
  assert.equal(last.final, true);
  const actions = rows.filter((r) => r.kind === "tool_use" || r.kind === "tool_result");
  assert.deepEqual(actions.map((r) => [r.kind, r.tool_name, r.tool_status]), [["tool_use", "write", "success"], ["tool_use", "read", "success"]], shown(rows));
  assert.equal(new Set(actions.map((r) => r.tool_use_id)).size, 2, "one row per tool_use_id");
  assert.equal(actions[0].path, "note.txt", shown(rows));
  assert.deepEqual(rows.filter((r) => r.kind === "phase" && /^Saved /.test(r.summary ?? "")), [], shown(rows));
  assert.match(rows.findLast((r) => r.kind === "usage").summary, /^Total: \$\d+\.\d{4} · \d+ model requests? · \d+ s$/, shown(rows));
});

test("ask_person's question is one row: waiting while it waits, the asked action once answered; never a call and a result row besides", async (t) => {
  const { api } = await serve(t);
  const { run_id } = await startRun(api, "regions", "Pick a region.", { tools: ["ask_person"] });
  const waiting = await follow(api, run_id, ["input_required"]);
  const asking = waiting.rows.filter((r) => (r.summary ?? "").includes("Which region should I use?"));
  assert.deepEqual(asking.map((r) => [r.kind, r.summary]), [["waiting", "Waiting for you: Which region should I use?"]], shown(waiting.rows));
  assert.equal((await api("POST", `/runs/${run_id}/messages`, { content: "EU" })).status, 202);
  const done = await follow(api, run_id, ["completed"]);
  const asked = done.rows.filter((r) => (r.summary ?? "").includes("Which region should I use?"));
  assert.deepEqual(asked.map((r) => [r.kind, r.tool_name, r.tool_status]), [["tool_use", "ask_person", "success"]], shown(done.rows));
  assert.match(asked[0].summary, /^Asked you: Which region should I use\?/, shown(done.rows));
});
