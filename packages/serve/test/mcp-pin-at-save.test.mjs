// An agent's MCP tools are pinned when it is saved, on its revision: a save lists each granted server once and keeps the
// granted tools as the server listed them (name, description, input schema, annotations, price). A run uses its
// revision's pin, whatever the server lists by then; a server that cannot be listed, or a granted tool it no longer
// lists, refuses the save in words naming it; saving again re-pins. Through the API on pi with a faux model and the
// fake MCP server. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, retried, serve, withEnv } from "./support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const ADD = "mcp:fake/add";
const ALLOW = { [ADD]: { permission: "allow" } };
/** The fake's add as a save pins it: every field its server listed. */
const PINNED_ADD = { name: "add", title: "Add", description: "Add two numbers.", input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false }, annotations: { readOnlyHint: true } };

async function setup(t) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { faux: FAUX_MCP });
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  assert.equal((await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  return { ...server, fake };
}

const refresh = async (api) => assert.equal((await api("POST", "/settings/mcp-servers/fake/refresh", {})).status, 200);
const answerOf = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";

test("a save pins the granted tools on the revision, and a run uses that pin though the server changed the tool since", { timeout: 240_000 }, async (t) => {
  const { api, store, fake } = await setup(t);
  const made = await retried(api)("POST", "/agents", agent("pinned", { tools: [ADD], tool_settings: ALLOW }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const read = (await api("GET", "/agents/pinned")).body;
  assert.deepEqual(read.mcp_pin, { fake: { tools: [PINNED_ADD] } }, "the agent read shows the pin its save made");

  // The server changes the tool, and its owner refreshes the registry: the saved revision keeps what it pinned.
  fake.tools.add.description = "Add two numbers, then some.";
  await refresh(api);
  const started = await api("POST", "/agents/pinned/runs", { input: { content: 'Call mcp__fake__add with {"a":2,"b":3}' } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  assert.equal((await follow(api, runId, ["completed", "failed"], { deadlineMs: 180_000 })).last.status, "completed");
  assert.match(await answerOf(api, runId), /The tool said: 5/);
  const pin = (await store.mcp.pin(runId))?.body;
  assert.equal(pin?.fake?.tools?.[0]?.description, "Add two numbers.", `the run's pin is its revision's: ${JSON.stringify(pin)}`);
});

test("a run of a revision whose pinned tool the server dropped since still starts on its pin; the call is the server's to refuse", { timeout: 240_000 }, async (t) => {
  const { api, fake } = await setup(t);
  assert.equal((await retried(api)("POST", "/agents", agent("dropped", { tools: [ADD], tool_settings: ALLOW }))).status, 201);
  delete fake.tools.add;
  await refresh(api);
  const started = await api("POST", "/agents/dropped/runs", { input: { content: 'Call mcp__fake__add with {"a":2,"b":3}' } });
  assert.equal(started.status, 202, `the run starts on its revision's pin: ${JSON.stringify(started.body)}`);
  assert.equal((await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 180_000 })).last.status, "completed");
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length, 1, "the pinned call went to the server");
  assert.doesNotMatch(await answerOf(api, started.body.run_id), /The tool said: 5/, "the server no longer runs it");
});

test("a save is refused in words naming the server when it cannot be listed, and naming the tool when the server no longer lists it", { timeout: 120_000 }, async (t) => {
  const { api, fake } = await setup(t);
  // The registry still lists add (no refresh), but the server no longer does: the save lists it now.
  const kept = fake.tools.add;
  delete fake.tools.add;
  const gone = await retried(api)("POST", "/agents", agent("gone", { tools: [ADD] }));
  assert.equal(gone.status, 422, JSON.stringify(gone.body));
  assert.match(JSON.stringify(gone.body), /The MCP server fake has no tool add/);
  fake.tools.add = kept;
  // The server is down: nothing it would pin can be read.
  await fake.close();
  const down = await retried(api)("POST", "/agents", agent("down", { tools: [ADD] }));
  assert.equal(down.status, 422, JSON.stringify(down.body));
  assert.match(JSON.stringify(down.body), /The MCP server fake could not be listed to pin its tools/);
  assert.equal((await api("GET", "/agents/down")).status, 404, "no agent was made");
});

test("saving again re-pins: an unchanged definition after the server changed its tool is a new revision with the new pin, and again with nothing changed is none", { timeout: 120_000 }, async (t) => {
  const { api, fake } = await setup(t);
  assert.equal((await retried(api)("POST", "/agents", agent("again", { tools: [ADD] }))).status, 201);
  const first = (await api("GET", "/agents/again")).body;
  const definition = { ...first.definition };
  delete definition.version;
  fake.tools.add.description = "Add two numbers, changed.";
  const saved = await api("PUT", "/agents/again/definition", { definition });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const second = (await api("GET", "/agents/again")).body;
  assert.equal(second.revisions, 2, "a new revision");
  assert.notEqual(second.revision, first.revision);
  assert.equal(second.mcp_pin.fake.tools[0].description, "Add two numbers, changed.");
  assert.equal((await api("PUT", "/agents/again/definition", { definition })).status, 200);
  assert.equal((await api("GET", "/agents/again")).body.revisions, 2, "nothing changed: no revision");
});
