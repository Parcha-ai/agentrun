// An agent's own limit on its runs' requests on free models (definition.max_requests, a template's budget.max_requests):
// the server's limit (AGENTRUN_FREE_MODEL_REQUESTS, 60 by default) is for every run on the server, and one looping run on
// a free model can spend a person's whole daily free quota under it. A run of an agent with max_requests stops at the
// smaller of the two, failed as at the server's limit, in the same words naming the number it stopped at. A free model
// stuck on a failing tool (fixtures/faux-loop.mjs) is the loop.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { definitionIssues } from "../dist/validate.js";
import { follow, journalOf, scratch, serve, withEnv } from "./support.mjs";

const FREE_LOOP = new URL("./fixtures/faux-loop.mjs", import.meta.url).pathname;
const ENV = "AGENTRUN_FREE_MODEL_REQUESTS";
const words = (n) => `Not sent: this run reached its ${n}-request limit for free models.`;
const definition = (id, extra = {}) => ({ id, version: 1, name: id, instructions: "Look it up.", skills: [], tools: [], ...extra });

/** A run of agent `id` with `input`, followed to its end: its view and its model requests. */
async function runOf(api, data, id, input) {
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: input } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 120_000 });
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const requests = journalOf(data, started.body.run_id).filter((entry) => entry.kind === "runner.request").map((entry) => entry.data);
  return { view, requests };
}

const failedAt = (view, n) => {
  assert.equal(view.status, "failed", JSON.stringify(view));
  assert.deepEqual(view.error && { code: view.error.code, message: view.error.message }, { code: "spend_cap_reached", message: words(n) });
};

test("an agent's max_requests stops its run on a free model at that many requests, failed in the server limit's words naming it", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, [ENV]);
  const { api, data } = await serve(t, { faux: FREE_LOOP });
  const made = await api("POST", "/agents", { definition: definition("capped", { max_requests: 3 }) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await api("GET", "/agents/capped")).body.definition.max_requests, 3, "the agent says its limit");
  const { view, requests } = await runOf(api, data, "capped", "Loop 10");
  failedAt(view, 3);
  assert.equal(requests.length, 3, "3 requests left; the 4th was refused before it was sent");
});

test(`max_requests above the server's limit (${ENV}) gets the server's limit`, { timeout: 120_000 }, async (t) => {
  withEnv(t, { [ENV]: "2" });
  const { api, data } = await serve(t, { faux: FREE_LOOP });
  assert.equal((await api("POST", "/agents", { definition: definition("over", { max_requests: 50 }) })).status, 201);
  const { view, requests } = await runOf(api, data, "over", "Loop 10");
  failedAt(view, 2);
  assert.equal(requests.length, 2);
});

test("an edit that leaves max_requests out keeps it; 0 clears it", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { runner: false });
  assert.equal((await api("POST", "/agents", { definition: definition("kept", { max_requests: 4 }) })).status, 201);
  const edited = await api("PUT", "/agents/kept/definition", { definition: { name: "kept", instructions: "Look it up again." } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await api("GET", "/agents/kept")).body.definition.max_requests, 4, "leaving it out never removes a limit");
  const cleared = await api("PUT", "/agents/kept/definition", { definition: { name: "kept", instructions: "Look it up.", max_requests: 0 } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal((await api("GET", "/agents/kept")).body.definition.max_requests, undefined, "0 clears it");
});

test("max_requests that is no whole number of at least 0 is refused, naming the field", () => {
  for (const bad of [2.5, -1, "3", true, null]) {
    const issues = definitionIssues({ name: "a", instructions: "x", max_requests: bad });
    assert.deepEqual(issues.map((i) => [i.field, i.reason]), [["definition.max_requests", "wrong_type"]], JSON.stringify(bad));
  }
  assert.deepEqual(definitionIssues({ name: "a", instructions: "x", max_requests: 20 }), []);
  assert.deepEqual(definitionIssues({ name: "a", instructions: "x", max_requests: 0 }), []);
});

test("a template's budget.max_requests is listed, written onto the agent its apply makes, and stops that agent's run", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, [ENV]);
  const root = join(await scratch(t), "templates");
  mkdirSync(join(root, "looper"), { recursive: true });
  writeFileSync(join(root, "looper", "agent.md"), `---
name: looper
version: 1.0.0
description: Looks things up.
tools: []
budget: { per_run_usd: 1, max_requests: 3 }
---
Look it up.
`);
  const { api, data } = await serve(t, { faux: FREE_LOOP, templates: root });
  const listed = (await api("GET", "/templates")).body.templates.find((p) => p.name === "looper");
  assert.deepEqual(listed?.budget, { per_run_usd: 1, max_requests: 3 }, JSON.stringify(listed));
  const applied = await api("POST", "/templates/looper/apply", { parameters: {} });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const agent = (await api("GET", `/agents/${applied.body.agent_id}`)).body.definition;
  assert.deepEqual([agent.max_cost_usd, agent.max_requests], [1, 3], JSON.stringify(agent));
  const { view, requests } = await runOf(api, data, applied.body.agent_id, "Loop 10");
  failedAt(view, 3);
  assert.equal(requests.length, 3);
});
