// An agent's MCP tools pinned when it is saved, not at its run's first claim (mcp-snapshot.ts). Through the API on pi with
// a faux model and the fake MCP server: a save keeps each granted tool's snapshot in the revision, with the version of the
// server's whole listed snapshot; a refresh of the server after it shows on the agent's read as drift and changes nothing
// the agent's runs call (a tool the server no longer lists still runs as pinned); a save again re-pins, and a save that
// changes nothing makes no revision. On the real store: a claim uses the revision's pin as it is, writes no pin of its
// own, and checks it again (meta tools, header declarations, a grant it does not hold). No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { queued, storeOn } from "./store-helpers.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const { mcpDriftOf, revisionPinOf, snapshotVersion } = await import("../dist/mcp-snapshot.js");
const { mcpClaim, McpClaimRefused } = await import("../dist/runner/mcp-claim.js");

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const ADD = "mcp:fake/add";

async function setup(t) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { faux: FAUX_MCP });
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  assert.equal((await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  const refresh = async () => assert.equal((await server.api("POST", "/settings/mcp-servers/fake/refresh")).status, 200);
  const registryVersion = async () => snapshotVersion((await server.api("GET", "/settings/mcp-servers/fake")).body.tools);
  const pinOf = async (id) => (await server.store.agents.revision((await server.api("GET", `/agents/${id}`)).body.revision)).body.mcpPin;
  return { server, api: server.api, fake, refresh, registryVersion, pinOf };
}

test("the snapshot version matches the vector the tools source computes", () => {
  // The registry's shape (input_schema); the tools package's test holds the same tools in the wire shape to this answer.
  const tools = [
    { name: "b", input_schema: { type: "object", properties: { x: { type: "string" } } }, annotations: { readOnlyHint: true }, grantable: false },
    { name: "a", title: "A", description: "The first.", input_schema: { type: "object" } },
  ];
  assert.equal(snapshotVersion(tools), "sha256:8828911138affb8490da4ded4bddb2e72379655d739a4beec6e4ea0676b327df");
});

test("a save pins each granted MCP tool as the registry holds it, with the server's snapshot version, and the read shows no drift", { timeout: 240_000 }, async (t) => {
  const { api, fake, registryVersion, pinOf } = await setup(t);
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" }, prices: { add: 0.02 } })).status, 200);
  const made = await api("POST", "/agents", agent("pinned", { tools: [ADD] }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const pin = await pinOf("pinned");
  assert.deepEqual(Object.keys(pin), ["fake"]);
  assert.equal(pin.fake.url, fake.url);
  assert.equal(pin.fake.version, await registryVersion());
  assert.deepEqual(pin.fake.tools.map((tool) => tool.name), ["add"], "the granted tools alone");
  assert.deepEqual(pin.fake.tools[0].inputSchema.required, ["a", "b"], "in the harnesses' shape");
  assert.deepEqual({ ...pin.fake.prices }, { add: 0.02 }, "with the owner's price");
  const read = await api("GET", "/agents/pinned");
  assert.deepEqual(read.body.mcp_drift, []);
  assert.equal("mcpPin" in read.body.definition, false, "the pin is the save's, never the definition's");
  // An agent that grants no MCP tool pins nothing.
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  assert.equal(await pinOf("plain"), undefined);
  assert.deepEqual((await api("GET", "/agents/plain")).body.mcp_drift, []);
});

test("the registry changes after the save: the read shows drift, a run uses the pinned snapshot, and a save again re-pins", { timeout: 240_000 }, async (t) => {
  const { api, fake, refresh, registryVersion, pinOf } = await setup(t);
  assert.equal((await api("POST", "/agents", agent("steady", { tools: [ADD], tool_settings: { [ADD]: { permission: "allow" } } }))).status, 201);
  const pinned = await registryVersion();
  const revisions = (await api("GET", "/agents/steady")).body.revisions;

  // The server stops listing `add` and the owner refreshes it: the registry has no `add` now.
  const add = fake.tools.add;
  delete fake.tools.add;
  await refresh();
  const current = await registryVersion();
  assert.notEqual(current, pinned);
  assert.deepEqual((await api("GET", "/agents/steady")).body.mcp_drift, [{ server: "fake", pinned_version: pinned, current_version: current, reason: "tools_changed" }]);

  // The running agent never changes: its run is checked against and calls the tool its save pinned. (The server still
  // answers a call of it; only its listing dropped it.)
  fake.tools.add = add;
  const started = await api("POST", "/agents/steady/runs", { input: { content: `Call mcp__fake__add with ${JSON.stringify({ a: 2, b: 3 })}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal((await follow(api, started.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 })).last.status, "completed");
  assert.match((await api("GET", `/runs/${started.body.run_id}`)).body.result?.final_answer ?? "", /The tool said: 5/);
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length, 1);

  // A save of the same definition re-pins: a new revision, pinned to what the registry holds now (it no longer lists
  // `add`, so the save is refused, as a grant of an unlisted tool is).
  const definition = (await api("GET", "/agents/steady")).body.definition;
  const refused = await api("PUT", "/agents/steady/definition", { definition: { ...definition, version: undefined } });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  // Listed again (with a changed description), the save re-pins to the new snapshot.
  fake.tools.add = { ...add, description: "Add two numbers, and say so." };
  await refresh();
  const again = await api("PUT", "/agents/steady/definition", { definition: { ...definition, version: undefined } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.revisions, revisions + 1, "a new revision");
  assert.equal((await pinOf("steady")).fake.version, await registryVersion());
  assert.equal((await pinOf("steady")).fake.tools[0].description, "Add two numbers, and say so.");
  assert.deepEqual((await api("GET", "/agents/steady")).body.mcp_drift, []);
  // Saved once more with nothing changed: no new revision.
  const same = await api("PUT", "/agents/steady/definition", { definition: { ...definition, version: undefined } });
  assert.equal(same.status, 200);
  assert.equal(same.body.revisions, revisions + 1);
});

test("a pinned server deleted since the save: the read says removed, and a run is refused at its start, nothing sent", { timeout: 240_000 }, async (t) => {
  const { api, fake } = await setup(t);
  assert.equal((await api("POST", "/agents", agent("orphan", { tools: [ADD], tool_settings: { [ADD]: { permission: "allow" } } }))).status, 201);
  assert.equal((await api("DELETE", "/settings/mcp-servers/fake")).status, 204);
  const [drift] = (await api("GET", "/agents/orphan")).body.mcp_drift;
  assert.deepEqual([drift.server, drift.current_version, drift.reason], ["fake", null, "removed"]);
  const started = await api("POST", "/agents/orphan/runs", { input: { content: `Call mcp__fake__add with ${JSON.stringify({ a: 1, b: 1 })}` } });
  assert.ok(started.status >= 400, JSON.stringify(started.body));
  assert.match(JSON.stringify(started.body), /No MCP server fake is saved/);
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 0);
});

test("a server removed or moved since the save shows as drift", () => {
  const tools = [{ name: "add", input_schema: { type: "object" } }];
  const rows = new Map([["fake", { name: "fake", url: "https://mcp.example.test/mcp", tools }]]);
  const pin = revisionPinOf(["mcp:fake/add"], rows);
  assert.deepEqual(mcpDriftOf(pin, rows), []);
  assert.deepEqual(mcpDriftOf(pin, new Map([["fake", { ...rows.get("fake"), url: "https://moved.example.test/mcp" }]])), [{ server: "fake", pinned_version: pin.fake.version, current_version: pin.fake.version, reason: "address_changed" }]);
  assert.deepEqual(mcpDriftOf(pin, new Map()), [{ server: "fake", pinned_version: pin.fake.version, current_version: null, reason: "removed" }]);
  assert.deepEqual(mcpDriftOf(undefined, rows), []);
});

test("a save's pin refuses what a claim's would: a meta tool, a header it cannot send, a tool not listed", () => {
  const row = (tools) => new Map([["fake", { name: "fake", url: "https://mcp.example.test/mcp", tools }]]);
  assert.throws(() => revisionPinOf(["mcp:fake/COMPOSIO_MULTI_EXECUTE_TOOL"], row([{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", input_schema: { type: "object" } }])), /can't be granted/);
  assert.throws(() => revisionPinOf(["mcp:fake/h"], row([{ name: "h", input_schema: { type: "object", "x-mcp-header": "X-Root" } }])), /declares a header it cannot send/);
  assert.throws(() => revisionPinOf(["mcp:fake/gone"], row([])), /no longer one of its tools/);
  assert.equal(revisionPinOf(["web_search"], row([])), undefined);
});

/** A store with run-1 queued and claimed, the fake saved under "fake" with `tools` (registry shape). */
async function claimed(t, tools) {
  const opened = await storeOn(t);
  await opened.store.mcp.put({ name: "fake", url: "https://mcp.example.test/mcp", auth: "none", tools, sealed: null });
  await queued(opened.store, "run-1");
  const claim = await opened.store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  return { store: opened.store, claim };
}
const claimOf = (store, claim, grants, revisionPin) => mcpClaim({ store, claim, grants, revisionPin, sealKey: randomBytes(32), signal: new AbortController().signal });

test("a claim uses its revision's pin as it is, though the registry changed since, and writes no pin of its own", async (t) => {
  const listed = [{ name: "add", description: "Add.", input_schema: { type: "object", properties: { a: { type: "number" } } } }];
  const { store, claim } = await claimed(t, listed);
  const revisionPin = revisionPinOf(["mcp:fake/add"], new Map([["fake", { name: "fake", url: "https://mcp.example.test/mcp", tools: listed }]]));
  // The server dropped `add` since the save.
  await store.mcp.put({ name: "fake", url: "https://mcp.example.test/mcp", auth: "none", tools: [], sealed: null });
  const step = await claimOf(store, claim, ["mcp:fake/add"], revisionPin);
  assert.deepEqual(JSON.parse(JSON.stringify(step.pin)), { fake: { url: "https://mcp.example.test/mcp", tools: [{ name: "add", description: "Add.", inputSchema: { type: "object", properties: { a: { type: "number" } } } }] } });
  assert.equal(await store.mcp.pin("run-1"), undefined, "no pin row: the revision's is the run's");
  step.release();
});

test("a claim checks its revision's pin again: a meta tool, a header it cannot send, a grant it does not hold, a pin that does not read", async (t) => {
  const url = "https://mcp.example.test/mcp";
  const { store, claim } = await claimed(t, []);
  const pinWith = (tool) => ({ fake: { url, version: "sha256:x", tools: [tool] } });
  await assert.rejects(claimOf(store, claim, ["mcp:fake/COMPOSIO_MULTI_EXECUTE_TOOL"], pinWith({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object" } })), (error) => error instanceof McpClaimRefused && /can't be granted/.test(error.message));
  await assert.rejects(claimOf(store, claim, ["mcp:fake/h"], pinWith({ name: "h", inputSchema: { type: "object", "x-mcp-header": "X-Root" } })), (error) => error instanceof McpClaimRefused && /declares a header it cannot send/.test(error.message));
  await assert.rejects(claimOf(store, claim, ["mcp:fake/add", "mcp:fake/other"], pinWith({ name: "add", inputSchema: { type: "object" } })), (error) => error instanceof McpClaimRefused && /mcp:fake\/other is not in the tools the agent's save pinned/.test(error.message));
  await assert.rejects(claimOf(store, claim, ["mcp:fake/add"], { fake: { url } }), (error) => error instanceof McpClaimRefused && /does not read/.test(error.message));

});
