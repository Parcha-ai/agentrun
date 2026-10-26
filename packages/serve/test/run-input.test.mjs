// GET /v2/runs/{id}/input, this server's own route: a run's input exactly as it was started, both kinds, whole (the
// timeline cuts a long first message at 2000 characters), behind the token like every route.
import assert from "node:assert/strict";
import { test } from "node:test";
import { client, flowAgent, follow, serve, startRun } from "./support.mjs";

test("a run's input, whole and as started: an agentic run's past the timeline's cut, and a workflow run's", async (t) => {
  const { api } = await serve(t);
  const long = `What is six times seven? ${"Say it plainly. ".repeat(200)}`.trim();
  assert.ok(long.length > 2000);
  const { run_id } = await startRun(api, "calc", long);
  await follow(api, run_id, ["completed"]);
  const timeline = await api("GET", `/runs/${run_id}/timeline`);
  assert.ok(timeline.body.rows.find((r) => r.kind === "user_message").text.length < long.length, "the timeline cut it");
  const agentic = await api("GET", `/runs/${run_id}/input`);
  assert.deepEqual([agentic.status, agentic.body], [200, { input: { content: long } }]);
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  const flow = await api("POST", "/agents/flow/runs", { input: { question: "What is six times seven?" } });
  await follow(api, flow.body.run_id, ["completed"]);
  assert.deepEqual((await api("GET", `/runs/${flow.body.run_id}/input`)).body, { input: { question: "What is six times seven?" } });
});

test("an unknown run is 404, and no token is 401; capabilities name the route", async (t) => {
  const { api, baseUrl } = await serve(t);
  assert.equal((await api("GET", "/runs/nope/input")).status, 404);
  const { run_id } = await startRun(api, "calc", "What is six times seven?");
  assert.equal((await client(baseUrl)("GET", `/runs/${run_id}/input`)).status, 401);
  assert.deepEqual((await api("GET", "/capabilities")).body.features.run_input, { routes: ["GET /runs/{id}/input"] });
});
