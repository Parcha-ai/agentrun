// A saved MCP server's tool prices (USD a call) stay through a PUT that names none: a save from any client (the console's
// Change, the CLI, a script) never turns a paid tool into an unmetered one, outside the run's cap. `prices: {}` clears
// them, explicit prices replace them, and a new address is another server, whose prices are its own. A read names the
// tools no price meters (`not_metered`), and the served document says all this. The server is the fake on loopback.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { serve } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const NONE = { type: "none" };
const read = async (name) => (await api("GET", `/settings/mcp-servers/${name}`)).body;
async function fake(t) {
  const server = await startFakeMcp({});
  t.after(() => server.close());
  return server;
}
async function put(name, body) {
  const answer = await api("PUT", `/settings/mcp-servers/${name}`, body);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
}

/** One server for the file, with no runner (nothing here runs a model); each test saves under a name of its own. */
let api;
const closing = [];
before(async () => {
  ({ api } = await serve({ after: (close) => closing.push(close) }, { runner: false }));
});
after(async () => {
  for (const close of closing) await close();
});

test("a PUT with no prices keeps the saved ones, for the tools the server still lists at the same address", async (t) => {
  const server = await fake(t);
  await put("kept", { url: server.url, auth: NONE, prices: { paid: 0.05, add: 0.01 } });
  const again = await put("kept", { url: server.url, auth: NONE });
  assert.deepEqual(again.prices, { paid: 0.05, add: 0.01 }, "the PUT's own answer keeps them");
  assert.deepEqual((await read("kept")).prices, { paid: 0.05, add: 0.01 });
  // A tool the server no longer lists takes its price with it.
  delete server.tools.add;
  await put("kept", { url: server.url, auth: NONE });
  assert.deepEqual((await read("kept")).prices, { paid: 0.05 });
});

test("prices: {} clears the saved prices, explicit prices replace them, and a new address keeps none", async (t) => {
  const server = await fake(t);
  const other = await fake(t);
  await put("replaced", { url: server.url, auth: NONE, prices: { paid: 0.05 } });
  await put("replaced", { url: server.url, auth: NONE, prices: { add: 0.02 } });
  assert.deepEqual((await read("replaced")).prices, { add: 0.02 }, "explicit prices replace, never merge");
  await put("replaced", { url: server.url, auth: NONE, prices: {} });
  assert.equal((await read("replaced")).prices, undefined, "an explicit {} clears them");
  await put("replaced", { url: server.url, auth: NONE, prices: { paid: 0.05 } });
  await put("replaced", { url: other.url, auth: NONE });
  assert.equal((await read("replaced")).prices, undefined, "another address is another server");
});

test("a read names each tool no price meters, and the served document says a PUT keeps prices unless it names them", async (t) => {
  const server = await fake(t);
  const saved = await put("metered", { url: server.url, auth: NONE, prices: { paid: 0.05 } });
  assert.deepEqual(saved.not_metered, ["add", "slow_write", "delete_thing"], "the PUT's answer");
  assert.deepEqual((await read("metered")).not_metered, ["add", "slow_write", "delete_thing"], "a read");
  assert.deepEqual((await api("GET", "/settings/mcp-servers")).body.servers.find((one) => one.name === "metered").not_metered, ["add", "slow_write", "delete_thing"], "the list");
  await put("metered", { url: server.url, auth: NONE, prices: { paid: 0.05, add: 0, slow_write: 0, delete_thing: 0 } });
  assert.equal((await read("metered")).not_metered, undefined, "every tool priced, $0 too: none unmetered");
  const doc = (await api("GET", "/openapi.json")).body;
  const put$ = JSON.stringify(doc.paths["/settings/mcp-servers/{name}"].put);
  assert.match(put$, /no `prices` keeps/, "the PUT says it keeps prices");
  const view = doc.paths["/settings/mcp-servers/{name}"].get.responses["200"].content["application/json"].schema;
  assert.ok(view.properties?.not_metered, "the read's schema names not_metered");
});
