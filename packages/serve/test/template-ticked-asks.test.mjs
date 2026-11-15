// A tool the owner ticks at a template's apply is granted, never allowed: the apply writes no permission for it, so
// each call follows this server's tool settings. Under approvals ask a ticked write waits for the owner (and is never sent
// when they deny it) unless the owner allowed it there; its read runs with no approval row only where the owner turned on
// Allow reads for its server. Under never, the owner's own choice at apply, a ticked tool runs unasked, and Allow reads
// never reaches a tool left unticked. A deny the owner set on the server still holds, and a pin is written as before. No
// socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { compiled, readPackage } from "../dist/templates.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { harnessSetup } from "./fixtures/mcp-harness-setup.mjs";
import { twoToolPackage } from "./fixtures/two-tool-template.mjs";
import { call, clientOwnerSession, follow, scratch, serve, whenFree, withEnv } from "./support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const BOTH = ["mcp:fake/add", "mcp:fake/delete_thing"];
// The owner's Allow reads for the fake's server: its read-only tools (add) run with no one asked, where the agent holds them.
const READS = { "mcp:fake/*": { allow_reads: true } };
const callsOf = (fake, tool) => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === tool);

test("a ticked tool is granted with no permission written, a read and a write alike, under ask and never: the gate's default decides", async (t) => {
  const dir = join(await scratch(t), "templates");
  for (const approvals of ["ask", "never"]) {
    const pkg = readPackage(twoToolPackage(dir, `two-tools-${approvals}`, undefined, approvals));
    // Served by a saved server named as its toolkit, as an apply maps it.
    const made = compiled(pkg, {}, { mcp: pkg.mcp.map((need) => ({ ...need, server: need.toolkit })), defaultTools: [], grants: BOTH, approvals }).agent.definition;
    assert.deepEqual(made.tools, BOTH, approvals);
    assert.equal(made.tool_settings, undefined, `${approvals}: a tick writes no permission`);
  }
});

test("pi: under approvals ask a ticked write parks for the owner, and their deny means it is never sent; the agent's read says it asks", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const dir = join(await scratch(t), "templates");
  twoToolPackage(dir, "two-tools-ask", "pi", "ask");
  const server = await serve(t, { faux: FAUX_MCP, templates: dir, accounts: true, openSetup: true });
  const { api } = server;
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" }, toolkit: "fake" })).status, 200);
  const applied = await whenFree(() => api("POST", "/templates/two-tools-ask/apply", { grants: BOTH }));
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const id = applied.body.agent_id;
  const agent = (await api("GET", `/agents/${id}`)).body;
  assert.equal(agent.definition.approvals ?? "ask", "ask");
  assert.deepEqual(agent.definition.tools.filter((tool) => tool.startsWith("mcp:")), BOTH, "both ticks granted");

  const run = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: 'Call mcp__fake__delete_thing with {"id":"x1"}' } }));
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["input_required", "completed", "failed"], { deadlineMs: 120_000 });
  assert.deepEqual(callsOf(fake, "delete_thing"), [], "the ticked write was not sent unasked");
  assert.equal(last.status, "input_required", "the ticked write waits for the owner");
  const pending = (await api("GET", `/runs/${run.body.run_id}`)).body.pending;
  assert.deepEqual([pending?.kind, pending?.tool], ["approval", "mcp:fake/delete_thing"], JSON.stringify(pending));
  assert.deepEqual(agent.tools.filter((x) => x.name.startsWith("mcp:")).map((x) => [x.name, x.permission]), BOTH.map((tool) => [tool, "ask"]), "a tick is no allow: the default (ask) stands");
  const { cookie, origin } = await clientOwnerSession(server);
  const answered = await call(server.port, { method: "POST", path: `/v2/runs/${run.body.run_id}/approvals/${pending.id}`, headers: { "content-type": "application/json", cookie, origin }, body: { decision: "deny" } });
  assert.equal(answered.status, 204);
  await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 120_000 });
  assert.deepEqual(callsOf(fake, "delete_thing"), [], "denied: never sent");
});

test("pi: under approvals ask a ticked tool follows this server's tool settings: its read asks with Allow reads off and runs with no approval row with it on, its write parks, and a server allow of the write runs it unasked", { timeout: 240_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const dir = join(await scratch(t), "templates");
  twoToolPackage(dir, "two-tools-reads", "pi", "ask");
  const server = await serve(t, { faux: FAUX_MCP, templates: dir, accounts: true, openSetup: true });
  const { api } = server;
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" }, toolkit: "fake" })).status, 200);
  const applied = await whenFree(() => api("POST", "/templates/two-tools-reads/apply", { grants: BOTH }));
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const id = applied.body.agent_id;
  assert.equal((await api("GET", `/agents/${id}`)).body.definition.tool_settings, undefined, "the apply wrote no permission: this server's settings decide");
  const started = async (content) => {
    const run = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content } }));
    assert.equal(run.status, 202, JSON.stringify(run.body));
    return { id: run.body.run_id, ...(await follow(api, run.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 120_000 })) };
  };
  const READ = 'Call mcp__fake__add with {"a":2,"b":3}';
  const WRITE = 'Call mcp__fake__delete_thing with {"id":"x1"}';

  // Allow reads off: the ticked read asks, and is not sent while it waits.
  const asked = await started(READ);
  assert.equal(asked.last.status, "input_required", "with Allow reads off a ticked read asks");
  const pending = (await api("GET", `/runs/${asked.id}`)).body.pending;
  assert.deepEqual([pending?.kind, pending?.tool], ["approval", "mcp:fake/add"], JSON.stringify(pending));
  assert.equal(callsOf(fake, "add").length, 0, "not sent while it waits");
  // The owner denies it, so it is never sent, and the run ends before the setting changes.
  const { cookie, origin } = await clientOwnerSession(server);
  const denied = await call(server.port, { method: "POST", path: `/v2/runs/${asked.id}/approvals/${encodeURIComponent(pending.id)}`, headers: { "content-type": "application/json", cookie, origin }, body: { decision: "deny" } });
  assert.equal(denied.status, 204);
  await follow(api, asked.id, ["completed", "failed"], { deadlineMs: 120_000 });
  assert.equal(callsOf(fake, "add").length, 0, "denied: never sent");

  // The owner turns on Allow reads for the server: the same read runs with no approval row.
  assert.equal((await api("PUT", "/settings/tools", READS)).status, 200, "the owner's Allow reads for the server");
  const read = await started(READ);
  assert.equal(read.last.status, "completed", "no one was asked");
  assert.equal(read.rows.filter((row) => row.kind === "tool_approval_requested").length, 0, `no approval row: ${JSON.stringify(read.rows.map((row) => [row.kind, row.tool_name]))}`);
  assert.equal(callsOf(fake, "add").length, 1);

  // Allow reads lifts no write: the ticked write parks.
  const write = await started(WRITE);
  assert.equal(write.last.status, "input_required", "Allow reads lifts no write");
  assert.deepEqual(callsOf(fake, "delete_thing"), [], "the ticked write was not sent unasked");
  const parked = (await api("GET", `/runs/${write.id}`)).body.pending;
  assert.deepEqual([parked?.kind, parked?.tool], ["approval", "mcp:fake/delete_thing"], JSON.stringify(parked));
  const refused = await call(server.port, { method: "POST", path: `/v2/runs/${write.id}/approvals/${encodeURIComponent(parked.id)}`, headers: { "content-type": "application/json", cookie, origin }, body: { decision: "deny" } });
  assert.equal(refused.status, 204);
  await follow(api, write.id, ["completed", "failed"], { deadlineMs: 120_000 });
  assert.deepEqual(callsOf(fake, "delete_thing"), [], "denied: never sent");

  // The owner allows the write in this server's tool settings: a ticked tool follows them, so it runs unasked.
  assert.equal((await api("PUT", "/settings/tools", { ...READS, "mcp:fake/delete_thing": { permission: "allow" } })).status, 200);
  const allowed = await started(WRITE);
  assert.equal(allowed.last.status, "completed", "a server allow of the ticked write: no one was asked");
  assert.equal(allowed.rows.filter((row) => row.kind === "tool_approval_requested").length, 0, `no approval row: ${JSON.stringify(allowed.rows.map((row) => [row.kind, row.tool_name]))}`);
  assert.equal(callsOf(fake, "delete_thing").length, 1);
});

test("pi: under approvals never, a read-only tool left unticked stays refused though its server's Allow reads is on, called directly, through tools_call or from a codemode script: Allow reads widens nothing past the ticks", { timeout: 240_000 }, async (t) => {
  const dir = join(await scratch(t), "templates");
  twoToolPackage(dir, "two-tools-never-reads", "pi", "never");
  const { api, fake, prompt, host, offered, wire } = await harnessSetup(t, "pi", dir);
  assert.equal((await api("PUT", "/settings/tools", READS)).status, 200, "the owner's Allow reads for the server");
  const applied = await whenFree(() => api("POST", "/templates/two-tools-never-reads/apply", { grants: ["mcp:fake/delete_thing"] }));
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const id = applied.body.agent_id;
  const { definition } = (await api("GET", `/agents/${id}`)).body;
  assert.equal(definition.approvals, "never");
  assert.ok(!definition.tools.includes("mcp:fake/add"), `the unticked read is not the agent's: ${JSON.stringify(definition.tools)}`);
  const asks = [
    ["direct", prompt("add", { a: 2, b: 3 })],
    ["tools_call", host("tools_call", { name: "mcp__fake__add", args: { a: 2, b: 3 } })],
    ["codemode", host("codemode", { script: "return await tools.mcp__fake__add({ a: 2, b: 3 });" })],
  ];
  for (const [how, content] of asks) {
    const run = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content } }));
    assert.equal(run.status, 202, JSON.stringify(run.body));
    const { last } = await follow(api, run.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 120_000 });
    assert.notEqual(last.status, "input_required", `${how}: nothing asks, the call is refused outright`);
    assert.deepEqual(callsOf(fake, "add"), [], `${how}: the unticked read never reached the MCP server`);
  }
  for (const tools of offered()) assert.ok(!tools.includes(wire("add")), `the unticked read was offered: ${JSON.stringify(tools)}`);
});
