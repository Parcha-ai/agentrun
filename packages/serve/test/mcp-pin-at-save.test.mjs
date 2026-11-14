// An agent's MCP tools are pinned when it is saved, on its revision: a save lists each granted server once and keeps the
// granted tools as the server listed them (name, description, input schema, annotations, price). A run uses its
// revision's pin, whatever the server lists by then; a server that cannot be listed, or a granted tool it no longer
// lists, refuses the save in words naming it; saving again re-pins. Through the API on pi with a faux model and the
// fake MCP server. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, retried, serve, startInProcessRunner, withEnv } from "./support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const ADD = "mcp:fake/add";
const ALLOW = { [ADD]: { permission: "allow" } };
/** The fake's add as a save pins it: every field its server listed. */
const PINNED_ADD = { name: "add", title: "Add", description: "Add two numbers.", input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false }, annotations: { readOnlyHint: true } };

/** The server with the fake saved. `serving`: more of serve()'s options (runner: false); `fakeOptions`: the fake's (hold). */
async function setup(t, { serving = {}, fakeOptions = {} } = {}) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { faux: FAUX_MCP, ...serving });
  const fake = await startFakeMcp(fakeOptions);
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

test("a save while a granted server is down keeps its previous pin when the edit grants nothing new from it; a tool new to the pin, or no previous pin, is refused", { timeout: 120_000 }, async (t) => {
  const { api, fake } = await setup(t);
  assert.equal((await retried(api)("POST", "/agents", agent("kept", { tools: [ADD] }))).status, 201);
  const first = (await api("GET", "/agents/kept")).body;
  const definition = { ...first.definition, instructions: "Add the numbers you are given, then say the sum." };
  delete definition.version;
  await fake.close();
  // An edit of the instructions alone: the server's grants are all in the previous pin, so it is carried, nothing listed.
  const edited = await api("PUT", "/agents/kept/definition", { definition });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const second = (await api("GET", "/agents/kept")).body;
  assert.equal(second.revisions, 2, "a new revision");
  assert.equal(second.definition.instructions, definition.instructions);
  assert.deepEqual(second.mcp_pin, first.mcp_pin, "the previous revision's pin, carried");
  // A tool from the down server that the previous pin does not hold: refused in the words that name the server.
  const added = await api("PUT", "/agents/kept/definition", { definition: { ...definition, tools: [ADD, "mcp:fake/delete_thing"] } });
  assert.equal(added.status, 422, JSON.stringify(added.body));
  assert.match(JSON.stringify(added.body), /The MCP server fake could not be listed to pin its tools/);
  assert.equal((await api("GET", "/agents/kept")).body.revisions, 2, "nothing saved");
  // A new agent has no previous pin: refused the same way.
  const fresh = await retried(api)("POST", "/agents", agent("fresh", { tools: [ADD] }));
  assert.equal(fresh.status, 422, JSON.stringify(fresh.body));
  assert.match(JSON.stringify(fresh.body), /The MCP server fake could not be listed to pin its tools/);
});

const ADD_CALL = { content: 'Call mcp__fake__add with {"a":2,"b":3}' };
const INLINE = { external: { source: "grep", kind: "expert", id: "7", version: 1 }, definition: { name: "Expert 7", instructions: "Answer.", skills: [], tools: [ADD], tool_settings: ALLOW }, input: ADD_CALL };

/** Clears `revisionId`'s pin, as a server open leaves a revision an earlier build saved (store/sqlite/store.ts open). */
function unpin(data, revisionId) {
  const raw = new DatabaseSync(join(data, "store.sqlite"), { timeout: 10_000 });
  try {
    raw.prepare("UPDATE revisions SET mcp_pin = NULL WHERE id = ?").run(revisionId);
  } finally {
    raw.close();
  }
}

/** The fake's add listed with another description at each read, so two listings never pin the same tool. */
function changingAdd(fake) {
  let reads = 0;
  Object.defineProperty(fake.tools.add, "description", { get: () => `Add two numbers (read ${++reads}).`, enumerable: true, configurable: true });
}

const completes = async (api, runId) => {
  assert.equal((await follow(api, runId, ["completed", "failed"], { deadlineMs: 180_000 })).last.status, "completed", JSON.stringify((await api("GET", `/runs/${runId}`)).body.error));
  assert.match(await answerOf(api, runId), /The tool said: 5/);
};

test("an earlier revision's first run pins it and completes: the run lists the server once, writes the pin on that revision, and a later run reads it", { timeout: 240_000 }, async (t) => {
  const { api, data, store, fake } = await setup(t);
  assert.equal((await retried(api)("POST", "/agents", agent("older", { tools: [ADD], tool_settings: ALLOW }))).status, 201);
  const first = (await api("GET", "/agents/older")).body;
  unpin(data, first.revision);
  assert.equal((await api("GET", "/agents/older")).body.mcp_pin, null);
  const started = await api("POST", "/agents/older/runs", { input: ADD_CALL });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await completes(api, started.body.run_id);
  const after = (await api("GET", "/agents/older")).body;
  assert.equal(after.revision, first.revision, "the same revision, pinned: no new one");
  assert.equal(after.revisions, 1);
  assert.deepEqual(after.mcp_pin, { fake: { tools: [PINNED_ADD] } }, "the pin its first run made");
  // Pinned now: a later run lists nothing, whatever the server lists by then.
  const lists = fake.log.filter((entry) => entry.method === "tools/list").length;
  fake.tools.add.description = "Add two numbers, changed.";
  const later = await api("POST", "/agents/older/runs", { input: ADD_CALL });
  assert.equal(later.status, 202, JSON.stringify(later.body));
  await completes(api, later.body.run_id);
  assert.equal(fake.log.filter((entry) => entry.method === "tools/list").length, lists, "no listing after the pin");
  assert.equal((await store.mcp.pin(later.body.run_id))?.body?.fake?.tools?.[0]?.description, "Add two numbers.");
});

test("an earlier revision's first run while its server is down is refused (409) in the words that say to save the agent again, and nothing is pinned", { timeout: 120_000 }, async (t) => {
  const { api, data, fake } = await setup(t);
  assert.equal((await retried(api)("POST", "/agents", agent("downed", { tools: [ADD], tool_settings: ALLOW }))).status, 201);
  unpin(data, (await api("GET", "/agents/downed")).body.revision);
  await fake.close();
  const refused = await api("POST", "/agents/downed/runs", { input: ADD_CALL });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable", JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /The MCP tool mcp:fake\/add was not pinned when this revision was saved: save the agent again to pin it\./);
  assert.equal((await api("GET", "/agents/downed")).body.mcp_pin, null, "nothing pinned");
});

test("two first runs of an earlier revision at once make one pin: both run on it, and the revision keeps it", { timeout: 240_000 }, async (t) => {
  const { api, data, store, fake } = await setup(t);
  assert.equal((await retried(api)("POST", "/agents", agent("raced", { tools: [ADD], tool_settings: ALLOW }))).status, 201);
  const revision = (await api("GET", "/agents/raced")).body.revision;
  unpin(data, revision);
  changingAdd(fake);
  const [one, two] = await Promise.all([1, 2].map(() => api("POST", "/agents/raced/runs", { input: ADD_CALL })));
  assert.deepEqual([one.status, two.status], [202, 202], JSON.stringify([one.body, two.body]));
  await completes(api, one.body.run_id);
  await completes(api, two.body.run_id);
  const kept = (await api("GET", "/agents/raced")).body;
  assert.equal(kept.revision, revision);
  const pins = [(await store.mcp.pin(one.body.run_id))?.body, (await store.mcp.pin(two.body.run_id))?.body];
  assert.ok(pins[0]?.fake?.tools?.[0]?.description, JSON.stringify(pins));
  assert.deepEqual(pins[1], pins[0], "one pin for both runs");
  assert.equal(kept.mcp_pin.fake.tools[0].description, pins[0].fake.tools[0].description, "the revision keeps the pin both ran on");
});

test("an inline agent's version stored before pins were made at save is pinned at its next run, which completes", { timeout: 240_000 }, async (t) => {
  const { api, data, store } = await setup(t);
  const first = await api("POST", "/runs", INLINE);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await completes(api, first.body.run_id);
  const revision = first.body.revision;
  unpin(data, revision);
  const again = await api("POST", "/runs", INLINE);
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal(again.body.revision, revision, "the version's stored revision");
  await completes(api, again.body.run_id);
  assert.deepEqual((await store.agents.revision(revision))?.mcpPin?.fake?.tools?.map((tool) => tool.name), ["add"], "the stored version is pinned");
});

test("two runs at once of an inline agent's version stored with no pin make one pin, and both run on it", { timeout: 240_000 }, async (t) => {
  const { api, data, store, fake } = await setup(t);
  const first = await api("POST", "/runs", INLINE);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await completes(api, first.body.run_id);
  unpin(data, first.body.revision);
  changingAdd(fake);
  const [one, two] = await Promise.all([1, 2].map(() => api("POST", "/runs", INLINE)));
  assert.deepEqual([one.status, two.status], [202, 202], JSON.stringify([one.body, two.body]));
  await completes(api, one.body.run_id);
  await completes(api, two.body.run_id);
  const pins = [(await store.mcp.pin(one.body.run_id))?.body, (await store.mcp.pin(two.body.run_id))?.body];
  assert.ok(pins[0]?.fake?.tools?.[0]?.description, JSON.stringify(pins));
  assert.deepEqual(pins[1], pins[0], "one pin for both runs");
  assert.deepEqual((await store.agents.revision(first.body.revision))?.mcpPin, pins[0], "the stored version keeps it");
});

test("an edit while a granted server is down carries the pin of the revision it is built on: a save that re-pinned meanwhile is kept, not the pin the edit first read", { timeout: 120_000 }, async (t) => {
  // The edit's first listing is held at the fake (its `hold`) until the test lets go, by closing the fake.
  let gate;
  const reached = new Promise((resolve) => (gate = resolve));
  let armed = false;
  const hold = async () => {
    if (!armed) return;
    armed = false;
    gate();
    await new Promise(() => {});
  };
  const { api, fake } = await setup(t, { fakeOptions: { hold } });
  assert.equal((await retried(api)("POST", "/agents", agent("carried", { tools: [ADD] }))).status, 201);
  const first = (await api("GET", "/agents/carried")).body;
  assert.equal(first.mcp_pin.fake.tools[0].description, "Add two numbers.", "v1");
  const definition = { ...first.definition };
  delete definition.version;
  // The edit reads the agent (v1), then its save lists the server: held there.
  armed = true;
  const editing = api("PUT", "/agents/carried/definition", { definition: { ...definition, instructions: "Add the numbers, then say the sum." } });
  await reached;
  // Meanwhile another save re-pins: the server changed its tool, and the unchanged definition saved again is v2.
  fake.tools.add.description = "Add two numbers, v2.";
  const repinned = await api("PUT", "/agents/carried/definition", { definition });
  assert.equal(repinned.status, 200, JSON.stringify(repinned.body));
  assert.equal((await api("GET", "/agents/carried")).body.mcp_pin.fake.tools[0].description, "Add two numbers, v2.", "v2");
  // The server goes down: the edit's held listing fails, and its retry on v2 cannot list either, so it carries a pin.
  await fake.close();
  const edited = await editing;
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const now = (await api("GET", "/agents/carried")).body;
  assert.equal(now.revisions, 3, "the edit, on v2");
  assert.equal(now.definition.instructions, "Add the numbers, then say the sum.");
  assert.equal(now.mcp_pin.fake.tools[0].description, "Add two numbers, v2.", "the pin of the revision the edit is built on (v2), not the one it first read (v1)");
});

test("a run queued before the upgrade on a revision with no pin is pinned at its claim and completes", { timeout: 240_000 }, async (t) => {
  const { api, data, store } = await setup(t, { serving: { runner: false } });
  assert.equal((await retried(api)("POST", "/agents", agent("queued", { tools: [ADD], tool_settings: ALLOW }))).status, 201);
  const started = await api("POST", "/agents/queued/runs", { input: ADD_CALL });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  // The upgrade: the run is queued, and its revision has no pin (a server open leaves an earlier one so).
  unpin(data, started.body.revision);
  const stopRunner = await startInProcessRunner(data, { faux: FAUX_MCP });
  try {
    await completes(api, started.body.run_id);
  } finally {
    await stopRunner();
  }
  assert.deepEqual((await store.agents.revision(started.body.revision))?.mcpPin?.fake?.tools?.map((tool) => tool.name), ["add"], "its claim pinned the revision");
});

test("a run queued before the upgrade whose server is down at its claim fails in the words it did, and its revision stays unpinned", { timeout: 240_000 }, async (t) => {
  const { api, data, store, fake } = await setup(t, { serving: { runner: false } });
  assert.equal((await retried(api)("POST", "/agents", agent("downed-queued", { tools: [ADD], tool_settings: ALLOW }))).status, 201);
  const started = await api("POST", "/agents/downed-queued/runs", { input: ADD_CALL });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  unpin(data, started.body.revision);
  await fake.close();
  const stopRunner = await startInProcessRunner(data, { faux: FAUX_MCP });
  try {
    assert.equal((await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 180_000 })).last.status, "failed");
  } finally {
    await stopRunner();
  }
  assert.equal((await api("GET", `/runs/${started.body.run_id}`)).body.error?.message, "The MCP tool mcp:fake/add was not pinned when this agent's revision was saved, so this run cannot call it. Save the agent again to pin it. Nothing was sent.");
  assert.equal((await store.agents.revision(started.body.revision))?.mcpPin ?? null, null);
});

test("a follow-up to a run that ended before the upgrade pins its revision at the claim and the run goes on", { timeout: 240_000 }, async (t) => {
  const { api, data, store } = await setup(t);
  assert.equal((await retried(api)("POST", "/agents", agent("followed", { tools: [ADD], tool_settings: ALLOW }))).status, 201);
  const started = await api("POST", "/agents/followed/runs", { input: { content: "Say hello." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  assert.equal((await follow(api, runId, ["completed", "failed"], { deadlineMs: 180_000 })).last.status, "completed");
  unpin(data, started.body.revision);
  const sent = await api("POST", `/runs/${runId}/messages`, { content: ADD_CALL.content });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await completes(api, runId);
  assert.deepEqual((await store.agents.revision(started.body.revision))?.mcpPin?.fake?.tools?.map((tool) => tool.name), ["add"], "the follow-up's claim pinned the revision");
});

test("through tools_search and tools_call a run keeps its revision's pin: the tool as saved, and a value its setting does not pin refused unsent", { timeout: 240_000 }, async (t) => {
  const { api, fake } = await setup(t);
  // Its setting pins add's `a` to 2 (tool-gate.ts pinRefusal), and its save pins the tool as the fake listed it then.
  assert.equal((await retried(api)("POST", "/agents", agent("through", { tools: [ADD], tool_settings: { [ADD]: { permission: "allow", pin: { a: 2 } } } }))).status, 201);
  fake.tools.add.description = "Add two numbers, then some.";
  await refresh(api);
  const calls = () => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length;
  const run = async (content) => {
    const started = await api("POST", "/agents/through/runs", { input: { content } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal((await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 180_000 })).last.status, "completed");
    return answerOf(api, started.body.run_id);
  };
  const found = await run('Call tools_search with {"query":"add two numbers"}');
  assert.match(found, /Add two numbers\./, `the search answers the tool as pinned: ${found}`);
  assert.doesNotMatch(found, /then some/, "never as the server lists it now");
  const refused = await run('Call tools_call with {"name":"mcp__fake__add","args":{"a":5,"b":3}}');
  assert.match(refused, /a = 2/, `refused in the pin's words: ${refused}`);
  assert.equal(calls(), 0, "the call with a = 5 was never sent");
  assert.match(await run('Call tools_call with {"name":"mcp__fake__add","args":{"a":2,"b":3}}'), /5/);
  assert.equal(calls(), 1, "the call as pinned was sent once");
});
