// A run waiting on the agent's question (ask_person) carries the question's waiting row in its served Timeline (GET
// /v2/runs/{id}/timeline, run-timeline-served.ts), as its view does (store-view withAsks) and main's served Timeline did:
// the console's "The agent asks" box reads the question from the newest waiting row, so without it a run that waited on
// something else before (a browser hand-over) shows that earlier wait's words as the agent's question.
import assert from "node:assert/strict";
import { test } from "node:test";
import { follow, serve } from "./support.mjs";

const FAUX_ASK_GATE = new URL("./fixtures/faux-ask-gate.mjs", import.meta.url).pathname;

test("a run waiting on the agent's question serves its waiting row on the Timeline, with the question's words, the run's own pending question", { timeout: 90_000 }, async (t) => {
  const server = await serve(t, { faux: FAUX_ASK_GATE });
  assert.equal((await server.api("POST", "/agents", { definition: { id: "asker", name: "asker", instructions: "Ask.", tools: ["ask_person"] } })).status, 201);
  const started = await server.api("POST", "/agents/asker/runs", { input: { content: "Ask: Shall I go on?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(server.api, runId, ["input_required"]);
  const view = (await server.api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([view.status, view.state, view.pending?.kind, view.pending?.question], ["input_required", "waiting", "question", "Shall I go on?"], JSON.stringify(view.pending));
  const rows = (await server.api("GET", `/runs/${runId}/timeline`)).body.rows;
  const waiting = rows.filter((row) => row.kind === "waiting");
  assert.equal(waiting.length, 1, `one waiting row: ${JSON.stringify(rows.map((row) => [row.kind, row.summary]))}`);
  assert.equal(waiting[0].summary, "Waiting for you: Shall I go on?");
  assert.equal(waiting[0].text, "Shall I go on?", "its text, the question the box shows");
  assert.equal(rows.at(-1)?.kind === "waiting" || rows.findLastIndex((row) => row.kind === "waiting") > rows.findLastIndex((row) => row.kind === "tool_result"), true, "after the call's result");
});
