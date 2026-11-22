// Resource capabilities cross the ordinary registry -> revision pin -> claim -> gate -> SDK path.
// The model is scripted; the upstream is a real SDK HTTP server with separate account credentials.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startSourceMcp } from "./fixtures/source-mcp-server.mjs";
import { agent, follow, retried, serve, withEnv } from "./support.mjs";

const faux = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
test("a resource-only connection pins and runs through the normal API, and the server deny still wins", { timeout: 120_000 }, async t => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t, { faux });
  const upstream = await startSourceMcp({ resourceOnly: true });
  t.after(() => upstream.close());
  const token = upstream.issue("destination");
  const saved = await api("PUT", "/settings/mcp-servers/resources", { url: upstream.url, auth: { type: "bearer", token } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.tools.map(tool => tool.resource), ["list", "templates", "read"]);
  const name = "mcp:resources/agentrun_read_resource";
  const made = await retried(api)("POST", "/agents", agent("resource-agent", { learning: false, tools: [name], tool_settings: { [name]: { permission: "allow" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.mcp_pin.resources.tools[0].resource, "read");
  const run = async () => {
    const start = await api("POST", "/agents/resource-agent/runs", { input: { content: 'Call mcp__resources__agentrun_read_resource with {"uri":"fixture://catalog/info"}' } });
    assert.equal(start.status, 202, JSON.stringify(start.body));
    assert.equal((await follow(api, start.body.run_id, ["completed", "failed"])).last.status, "completed");
    return (await api("GET", `/runs/${start.body.run_id}`)).body.result.final_answer;
  };
  assert.match(await run(), /destination.*catalog-v1/);
  assert.equal(upstream.audit.filter(row => row.phase === "dispatch" && row.method === "resources/read").length, 1);
  assert.equal((await api("PUT", "/settings/tools", { [name]: { permission: "deny" } })).status, 200);
  assert.match(await run(), /denied|deny|not allowed/i);
  assert.equal(upstream.audit.filter(row => row.phase === "dispatch" && row.method === "resources/read").length, 1, "the deny sends no second resource read");
});
