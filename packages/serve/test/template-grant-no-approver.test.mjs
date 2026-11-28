// A template applied under approvals ask, the owner ticking both of a saved MCP server's tools. Where someone can answer
// an ask (accounts on), a tick writes no permission: each ticked tool follows the server's settings and asks. Where no one
// can (accounts off: the store's approvers row says so), an ask could only ever be refused, so the tick is the owner's one
// answer: each ticked tool is allowed in the agent's own settings, and a run calls it with no one asked. A tick this server
// denies gets no allow (a later lift of that deny is the owner's own call). Faux model (fixtures/faux-mcp.mjs) and fake MCP server on loopback; no key, no network.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { twoToolPackage } from "./fixtures/two-tool-template.mjs";
import { follow, scratch, serve, whenFree } from "./support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const TICKED = ["mcp:fake/add", "mcp:fake/delete_thing"];

async function applied(t, accounts, { deny } = {}) {
  const dir = join(await scratch(t), "templates");
  twoToolPackage(dir, "two-tools-ask", undefined, "ask");
  const server = await serve(t, { faux: FAUX_MCP, templates: dir, accounts, openSetup: true });
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const saved = await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" }, toolkit: "fake" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  if (deny) assert.equal((await server.api("PUT", "/settings/tools", { [deny]: { permission: "deny" } })).status, 200);
  const made = await whenFree(() => server.api("POST", "/templates/two-tools-ask/apply", { grants: TICKED }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const agent = (await server.api("GET", `/agents/${made.body.agent_id}`)).body;
  const gates = Object.fromEntries(agent.tools.filter((tool) => TICKED.includes(tool.name)).map((tool) => [tool.name, [tool.permission, tool.permission_from]]));
  return { api: server.api, fake, id: made.body.agent_id, agent, gates };
}

test("accounts off: a ticked tool is allowed in the agent's own settings, and a run calls it with no one asked", { timeout: 120_000 }, async (t) => {
  const { api, fake, id, agent, gates } = await applied(t, false);
  assert.equal(agent.definition.approvals ?? "ask", "ask");
  assert.deepEqual(gates, { "mcp:fake/add": ["allow", "agent"], "mcp:fake/delete_thing": ["allow", "agent"] });
  const run = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: 'Call mcp__fake__add with {"a":2,"b":3}' } }));
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length, 1, "the ticked tool ran once");
});

test("accounts on: a tick still writes no permission, so each ticked tool asks, as the server's settings say", { timeout: 120_000 }, async (t) => {
  const { gates } = await applied(t, true);
  assert.deepEqual(gates, { "mcp:fake/add": ["ask", "default"], "mcp:fake/delete_thing": ["ask", "default"] });
});

test("accounts off: a ticked tool this server denies stays denied, with no allow of the agent's written under the deny", { timeout: 120_000 }, async (t) => {
  const { agent, gates } = await applied(t, false, { deny: "mcp:fake/delete_thing" });
  assert.deepEqual(gates, { "mcp:fake/add": ["allow", "agent"], "mcp:fake/delete_thing": ["deny", "server"] });
  assert.equal(agent.definition.tool_settings?.["mcp:fake/delete_thing"]?.permission, undefined, "no allow written under the server's deny");
});
