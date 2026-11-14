// "Allow reads": an MCP server's `allow_reads` in this server's tool settings (`mcp:<server>/*`) lets each of its tools
// the server marks read-only (readOnlyHint true) run with no approval; a write still asks, and a destructive tool's ask
// takes a second confirm to allow (confirm_destructive on the answer). The mark the gate reads is the one the run's pin
// holds (what the server listed when the run was pinned), never a later listing. A deny anywhere still wins, and an
// explicit setting of the tool's own key, or the agent's own setting, beats the rule. pi (the faux model) against the
// fake MCP server; claude-agent and codex are mcp-gate-wired.test.mjs's. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { permissionFrom, SETTINGS_UNREAD, toolEffect } from "../dist/tool-gate.js";
import { agent, call, clientOwnerSession, follow, serve as serveOf, whenFree, withEnv } from "./support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const TOKEN = `not-a-secret-${"mcp-allow-reads-0123"}`;
const json = { "content-type": "application/json" };
const serve = (t) => (withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }), serveOf(t, { faux: FAUX_MCP, accounts: true, openSetup: true }));
const calls = (fake, tool) => fake.log.filter((entry) => entry.method === "tools/call" && (tool === undefined || entry.tool === tool));
const READS = { "mcp:fake/*": { allow_reads: true } };

/** The fake MCP server saved as `fake`, with a plain write the server marks so (`note`: readOnlyHint and destructiveHint
 *  both false) beside its own tools: `add` read-only, `delete_thing` destructive. */
async function addFake(t, api) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  fake.tools.note = { description: "Write a note.", input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false }, run: ({ text }) => ({ content: [{ type: "text", text: `noted ${text}` }] }) };
  const saved = await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return fake;
}

async function started(api, id, tools, content) {
  const made = await whenFree(() => api("POST", "/agents", agent(id, { tools })));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content } }));
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

/** The owner's answer to approval `approvalId` of run `runId`: its status and its body. */
async function owner(server) {
  const { cookie, origin } = await clientOwnerSession(server);
  return async (runId, approvalId, body) => {
    const sent = await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body });
    return { status: sent.status, body: sent.json };
  };
}

async function parked(api, runId) {
  await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.pending?.kind, "approval", JSON.stringify(view.pending));
  return view.pending;
}
const answerOf = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer;

test("toolEffect: read-only only on readOnlyHint true; destructive only on destructiveHint true (not the spec's default, which would mark every tool of a server that annotates nothing) unless read-only; else write", () => {
  assert.equal(toolEffect({ readOnlyHint: true }), "read");
  assert.equal(toolEffect({ readOnlyHint: true, destructiveHint: true }), "read", "destructiveHint means nothing on a read-only tool");
  assert.equal(toolEffect({ readOnlyHint: false, destructiveHint: false }), "write");
  assert.equal(toolEffect({ destructiveHint: false }), "write");
  assert.equal(toolEffect({ readOnlyHint: false, destructiveHint: true }), "destructive");
  assert.equal(toolEffect({ readOnlyHint: false }), "write", "destructiveHint not given: a write, which still asks");
  assert.equal(toolEffect(undefined), "write", "no annotations: a write");
  assert.equal(toolEffect({ readOnlyHint: "true" }), "write", "only a JSON true is read-only");
  assert.equal(toolEffect({ destructiveHint: "true" }), "write", "only a JSON true is destructive");
});

test("permissionFrom: allow_reads lifts the ask of a read-only MCP tool to allow (from the server); a write or a destructive tool still asks; a deny, an explicit key, the agent's own setting and unread settings each hold", () => {
  const tool = "mcp:fake/add";
  assert.deepEqual(permissionFrom(tool, READS, {}, "ask", {}, "read"), { permission: "allow", from: "server" });
  assert.deepEqual(permissionFrom(tool, READS, {}, "ask", {}, "write"), { permission: "ask", from: "default" });
  assert.deepEqual(permissionFrom(tool, READS, {}, "ask", {}, "destructive"), { permission: "ask", from: "default" });
  assert.deepEqual(permissionFrom(tool, READS, {}, "ask", {}), { permission: "ask", from: "default" }, "no mark: not read-only");
  assert.deepEqual(permissionFrom(tool, {}, {}, "ask", {}, "read"), { permission: "ask", from: "default" }, "the rule off: the ask stands");
  // Its wildcard set to ask with the rule on: the rule is on that same key, so a read still runs.
  assert.deepEqual(permissionFrom(tool, { "mcp:fake/*": { permission: "ask", allow_reads: true } }, {}, "ask", {}, "read"), { permission: "allow", from: "server" });
  // A deny anywhere wins.
  assert.equal(permissionFrom(tool, { "mcp:fake/*": { permission: "deny", allow_reads: true } }, {}, "ask", {}, "read").permission, "deny");
  assert.equal(permissionFrom(tool, { ...READS, [tool]: { permission: "deny" } }, {}, "ask", {}, "read").permission, "deny");
  assert.equal(permissionFrom(tool, READS, { [tool]: { permission: "deny" } }, "ask", {}, "read").permission, "deny");
  assert.equal(permissionFrom(tool, READS, { "mcp:fake/*": { permission: "deny" } }, "ask", {}, "read").permission, "deny");
  // An explicit setting of the tool's own key beats the rule, on the server or the agent.
  assert.deepEqual(permissionFrom(tool, { ...READS, [tool]: { permission: "ask" } }, {}, "ask", {}, "read"), { permission: "ask", from: "server" });
  assert.deepEqual(permissionFrom(tool, READS, { [tool]: { permission: "ask" } }, "ask", {}, "read"), { permission: "ask", from: "agent" });
  assert.deepEqual(permissionFrom(tool, READS, { "mcp:fake/*": { permission: "ask" } }, "ask", {}, "read"), { permission: "ask", from: "agent" }, "the agent's own ask for its server holds");
  // A stand-in for a value that does not read, or settings not read at all: nothing is lifted.
  assert.equal(permissionFrom(tool, { "mcp:fake/*": { permission: "ask", fallback: true, allow_reads: true } }, {}, "ask", {}, "read").permission, "ask");
  assert.equal(permissionFrom(tool, Object.assign({ ...READS }, { [SETTINGS_UNREAD]: true }), {}, "ask", {}, "read").permission, "ask");
  // Another server's rule is not this one's; a tool that is not an MCP tool is never lifted.
  assert.equal(permissionFrom(tool, { "mcp:other/*": { allow_reads: true } }, {}, "ask", {}, "read").permission, "ask");
  assert.equal(permissionFrom("web_fetch", { ...READS, web_fetch: { permission: "ask" } }, {}, "ask", {}, "read").permission, "ask");
});

test("settings: allow_reads is kept on an MCP server's wildcard in the server's tool settings only, true or false (false clears it); anywhere else, or not a boolean, is 422", async (t) => {
  const { api } = await serve(t);
  const put = await api("PUT", "/settings/tools", READS);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body["mcp:fake/*"], { allow_reads: true });
  assert.deepEqual((await api("GET", "/settings/tools")).body["mcp:fake/*"], { allow_reads: true });
  const off = await api("PUT", "/settings/tools", { "mcp:fake/*": { allow_reads: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body["mcp:fake/*"], undefined, "false keeps nothing");
  for (const [body, field] of [[{ "mcp:fake/add": { allow_reads: true } }, "mcp:fake/add.allow_reads"], [{ "mcp:fake/*": { allow_reads: "yes" } }, "mcp:fake/*.allow_reads"], [{ web_fetch: { allow_reads: true } }, "web_fetch.allow_reads"]]) {
    const refused = await api("PUT", "/settings/tools", body);
    assert.equal(refused.status, 422, JSON.stringify([body, refused.body]));
    assert.ok(JSON.stringify(refused.body).includes(field), JSON.stringify(refused.body));
  }
  const own = await whenFree(() => api("POST", "/agents", agent("own-reads", { tools: [], tool_settings: READS })));
  assert.equal(own.status, 422, `an agent's own settings keep no allow_reads: ${JSON.stringify(own.body)}`);
  const doc = (await api("GET", "/openapi.json")).body;
  assert.ok(JSON.stringify(doc).includes("allow_reads"), "documented");
});

test("a saved server's read marks each tool read, write or destructive, gives a read-only tool allow under allow_reads, and says that allow is allow_reads' (allow_reads: true on the tool), never on a tool its own setting or a deny holds", async (t) => {
  const { api } = await serve(t);
  await addFake(t, api);
  const before = (await api("GET", "/settings/mcp-servers/fake")).body.tools;
  const of = (tools, name) => tools.find((tool) => tool.name === name);
  assert.deepEqual(["add", "note", "delete_thing", "slow_write"].map((name) => of(before, name).effect), ["read", "write", "destructive", "write"]);
  assert.equal(of(before, "add").permission, "ask");
  assert.equal((await api("PUT", "/settings/tools", READS)).status, 200);
  const after = (await api("GET", "/settings/mcp-servers/fake")).body.tools;
  assert.deepEqual(["add", "note", "delete_thing"].map((name) => of(after, name).permission), ["allow", "ask", "ask"]);
  assert.equal((await api("GET", "/settings/mcp-servers")).body.servers[0].tools.find((tool) => tool.name === "add").permission, "allow");
  assert.equal(of(before, "add").allow_reads, undefined, "not before the switch is on");
  assert.deepEqual(["add", "note", "delete_thing", "slow_write"].map((name) => of(after, name).allow_reads), [true, undefined, undefined, undefined]);
  // A tool's own setting beats the rule: the read says its own word, and no allow_reads.
  assert.equal((await api("PUT", "/settings/tools", { ...READS, "mcp:fake/add": { permission: "ask" } })).status, 200);
  const own = of((await api("GET", "/settings/mcp-servers/fake")).body.tools, "add");
  assert.deepEqual([own.permission, own.allow_reads], ["ask", undefined]);
  // A deny on the wildcard holds over it.
  assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "deny", allow_reads: true } })).status, 200);
  const denied = of((await api("GET", "/settings/mcp-servers/fake")).body.tools, "add");
  assert.deepEqual([denied.permission, denied.allow_reads], ["deny", undefined]);
});

test("pi: under allow_reads a read-only tool runs with no approval; a write parks; a destructive call parks marked destructive and its allow needs confirm_destructive; a deny on the server's wildcard still refuses the read", { timeout: 180_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", READS)).status, 200);

  const read = await started(api, "reader", ["mcp:fake/add"], 'Call mcp__fake__add with {"a":2,"b":3}');
  const { last } = await follow(api, read, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", "no one was asked");
  assert.equal(await answerOf(api, read), "The tool said: 5");
  assert.equal(calls(fake, "add").length, 1);

  const write = await started(api, "writer", ["mcp:fake/note"], 'Call mcp__fake__note with {"text":"hi"}');
  const asked = await parked(api, write);
  assert.equal(asked.tool, "mcp:fake/note");
  assert.equal(asked.destructive, undefined, "a write is not marked destructive");
  assert.equal(calls(fake, "note").length, 0);
  assert.equal((await answer(write, asked.id, { decision: "deny" })).status, 204);
  await follow(api, write, ["completed"], { deadlineMs: 60_000 });
  assert.equal(calls(fake, "note").length, 0, "denied: never sent");

  const wipe = await started(api, "wiper", ["mcp:fake/delete_thing"], 'Call mcp__fake__delete_thing with {"id":"t1"}');
  const destructive = await parked(api, wipe);
  assert.equal(destructive.destructive, true, JSON.stringify(destructive));
  const unconfirmed = await answer(wipe, destructive.id, { decision: "allow" });
  assert.equal(unconfirmed.status, 422, JSON.stringify(unconfirmed.body));
  assert.ok(JSON.stringify(unconfirmed.body).includes("confirm_destructive"), JSON.stringify(unconfirmed.body));
  assert.equal(calls(fake, "delete_thing").length, 0, "an unconfirmed allow sends nothing");
  assert.equal((await answer(wipe, destructive.id, { decision: "allow", confirm_destructive: true })).status, 204);
  await follow(api, wipe, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answerOf(api, wipe), "The tool said: deleted t1");
  assert.equal(calls(fake, "delete_thing").length, 1);
  const bad = await answer(write, asked.id, { decision: "deny", confirm_destructive: "yes" });
  assert.equal(bad.status, 422, "confirm_destructive is true when sent");

  assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "deny", allow_reads: true } })).status, 200);
  const refused = await started(api, "refused", ["mcp:fake/add"], 'Call mcp__fake__add with {"a":1,"b":1}');
  await follow(api, refused, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.match(await answerOf(api, refused), /denied|deny/i);
  assert.equal(calls(fake, "add").length, 1, "a deny wins over allow_reads: nothing more sent");
});

test("pi: the gate reads the mark the run's pin holds: a tool its server marks read-only only after the run was pinned still asks in that run, while a run pinned after it runs unasked", { timeout: 180_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", READS)).status, 200);
  const runId = await started(api, "pinned", ["mcp:fake/note"], 'Call mcp__fake__note with {"text":"one"}');
  const first = await parked(api, runId);
  // The server now says the write is read-only, and the saved server's listing takes it: the live read says allow.
  fake.tools.note.annotations = { readOnlyHint: true };
  assert.equal((await api("POST", "/settings/mcp-servers/fake/refresh")).status, 200);
  assert.equal((await api("GET", "/settings/mcp-servers/fake")).body.tools.find((tool) => tool.name === "note").permission, "allow", "the live listing reads allow");
  assert.equal((await answer(runId, first.id, { decision: "deny" })).status, 204);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  // The same run, its pin made before the change: its next call of the tool still asks.
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: 'Call mcp__fake__note with {"text":"two"}' })).status, 202);
  const again = await parked(api, runId);
  assert.equal(again.tool, "mcp:fake/note");
  assert.equal(calls(fake, "note").length, 0, "the pinned mark holds: nothing sent");
  // A run pinned after the change reads the new mark: it runs with no approval.
  const fresh = await started(api, "fresh", ["mcp:fake/note"], 'Call mcp__fake__note with {"text":"three"}');
  const { last } = await follow(api, fresh, ["completed", "failed", "input_required"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed");
  assert.equal(calls(fake, "note").length, 1);
});
