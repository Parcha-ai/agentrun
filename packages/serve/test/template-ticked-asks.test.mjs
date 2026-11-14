// A tool the owner ticks at a template's apply is granted, never allowed: the apply writes no permission for it, so the
// gate's default decides. Under approvals ask a ticked write waits for the owner (and is never sent when they deny it);
// under never, the owner's own choice at apply, it runs unasked. A ticked read is granted the same way (the server's
// reads rule decides it). A deny the owner set on the server still holds, and a pin is written as before. No socket
// leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { compiled, readPackage } from "../dist/templates.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { twoToolPackage } from "./fixtures/two-tool-template.mjs";
import { call, clientOwnerSession, follow, scratch, serve, whenFree, withEnv } from "./support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const BOTH = ["mcp:fake/add", "mcp:fake/delete_thing"];
const callsOf = (fake, tool) => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === tool);

test("a ticked tool is granted with no permission written, a read and a write alike, under ask and never: the gate's default decides", async (t) => {
  const dir = join(await scratch(t), "templates");
  for (const approvals of ["ask", "never"]) {
    const pkg = readPackage(twoToolPackage(dir, `two-tools-${approvals}`, undefined, approvals));
    const made = compiled(pkg, {}, { mcp: pkg.mcp, defaultTools: [], grants: BOTH, approvals }).agent.definition;
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
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
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
