// A saved MCP server's read (GET /settings/mcp-servers, one and the list) carries each tool's permission as this server
// applies it to an agent that sets none: `permission`, the one in force under the server's tool settings
// (`mcp:<server>/<tool>`, else `mcp:<server>/*`, else the default), `default_permission` and `permissions`, the same as an
// agent's read gives once the tool is granted. So the console's Tools step can show a tool's row as soon as it is ticked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, serve } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const NONE = { type: "none" };
const gateOf = (tool) => ({ permission: tool.permission, default_permission: tool.default_permission, permissions: tool.permissions });

test("an MCP server's read gives each tool's permission in force under the server's tool settings, as an agent's read of it does", async (t) => {
  const { api } = await serve(t);
  const server = await startFakeMcp({});
  t.after(() => server.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: server.url, auth: NONE })).status, 200);
  const tools = async () => {
    const one = (await api("GET", "/settings/mcp-servers/fake")).body.tools;
    const listed = (await api("GET", "/settings/mcp-servers")).body.servers.find((s) => s.name === "fake").tools;
    assert.deepEqual(listed, one, "the list and the one read agree");
    return Object.fromEntries(one.map((tool) => [tool.name, gateOf(tool)]));
  };
  // None set: the default, ask.
  assert.deepEqual((await tools()).add, { permission: "ask", default_permission: "ask", permissions: ["allow", "ask", "deny"] });
  // The server's setting for every tool of the server, and one for a tool alone, which wins.
  assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow" }, "mcp:fake/delete_thing": { permission: "deny" } })).status, 200);
  const set = await tools();
  assert.deepEqual(set.add, { permission: "allow", default_permission: "ask", permissions: ["allow", "ask", "deny"] });
  assert.equal(set.delete_thing.permission, "deny");
  // The same as an agent's read once it grants them: its default there is this permission.
  assert.equal((await api("POST", "/agents", agent("granted", { tools: ["mcp:fake/add", "mcp:fake/delete_thing"] }))).status, 201);
  const read = (await api("GET", "/agents/granted")).body.tools;
  for (const name of ["add", "delete_thing"]) {
    const own = read.find((x) => x.name === `mcp:fake/${name}`);
    assert.deepEqual([own.default_permission, own.permissions], [set[name].permission, set[name].permissions], name);
  }
});

test("the run-grant check reads the saved MCP servers from the store: a grant works once the server is saved, and is refused once it is removed", async (t) => {
  // The server keeps a snapshot of the saved servers' tools for the grant check, and is its only writer (a run's runner reads
  // the MCP rows itself at claim): the snapshot is refreshed on each save and delete, so the grant check reads what is saved now.
  const { api } = await serve(t);
  const server = await startFakeMcp({});
  t.after(() => server.close());
  // Not saved yet: a grant of its tool is refused, naming the server.
  const before = await api("POST", "/agents", agent("before", { tools: ["mcp:fake/add"] }));
  assert.equal(before.status, 422, JSON.stringify(before.body));
  assert.match(JSON.stringify(before.body), /No MCP server fake is saved/);
  // Saved: the snapshot is refreshed, so the grant works.
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: server.url, auth: NONE })).status, 200);
  assert.equal((await api("POST", "/agents", agent("granted", { tools: ["mcp:fake/add"] }))).status, 201);
  // Removed: the snapshot is refreshed again, so a new grant is refused once more.
  assert.equal((await api("DELETE", "/settings/mcp-servers/fake")).status, 204);
  const after = await api("POST", "/agents", agent("after", { tools: ["mcp:fake/add"] }));
  assert.equal(after.status, 422, JSON.stringify(after.body));
  assert.match(JSON.stringify(after.body), /No MCP server fake is saved/);
});
