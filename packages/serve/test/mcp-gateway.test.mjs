// The run's MCP gateway against the fake MCP server: a call stopped mid-way is cancelled upstream, a refused credential
// and a redirect are words the model reads (never a header, never a hop), a long answer is filed in work/, and a server
// whose address changed is sent nothing.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mcpRoute, startModelProxy } from "@parcha/agentrun-kernel/host";
import { MCP_CLIP, mcpGateway } from "../dist/mcp-gateway.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const TOKEN = `not-a-secret-${"gateway-bearer-0123"}`;
const schema = { type: "object" };
const tools = ["add", "slow_write", "long"].map((name) => ({ name, inputSchema: schema }));

async function setup(t, { token = TOKEN, url } = {}) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  fake.tools.long = { description: "A long answer.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: "x".repeat(MCP_CLIP + 10) }] }) };
  const work = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const pinned = url ?? fake.url;
  const gateway = mcpGateway({ pin: { fake: { url: pinned, tools } }, credentials: { fake: { url: pinned, headers: { authorization: `Bearer ${token}` } } }, work: () => work });
  return { fake, gateway, work };
}
const signal = () => new AbortController().signal;
const textOf = (result) => result.content.map((block) => block.text).join("");

test("a call answers its text; one stopped mid-way is cancelled upstream and answers stopped", async (t) => {
  const { fake, gateway } = await setup(t);
  assert.deepEqual(await gateway.call("fake", "add", { a: 2, b: 3 }, { signal: signal() }), { content: [{ type: "text", text: "5" }] });
  const stop = new AbortController();
  const slow = gateway.call("fake", "slow_write", { line: "x", seconds: 30 }, { signal: stop.signal });
  while (!fake.log.some((entry) => entry.tool === "slow_write")) await new Promise((resolve) => setTimeout(resolve, 20));
  stop.abort();
  const stopped = await slow;
  assert.equal(stopped.isError, true);
  assert.match(textOf(stopped), /stopped/);
  for (let i = 0; !fake.log.some((entry) => entry.method === "notifications/cancelled"); i++) {
    assert.ok(i < 100, `the server is told the call was cancelled: ${JSON.stringify(fake.log.map((entry) => entry.method))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("a refused credential says where to update it and never shows it; an answer past the clip is filed in work/", async (t) => {
  const { gateway: refused } = await setup(t, { token: `not-a-secret-${"wrong-token-0123456"}` });
  const said = await refused.call("fake", "add", { a: 1, b: 1 }, { signal: signal() });
  assert.equal(said.isError, true);
  assert.equal(textOf(said), "The MCP server fake refused its credential; update it in Settings → MCP servers.");
  const { gateway, work } = await setup(t);
  const long = textOf(await gateway.call("fake", "long", {}, { signal: signal() }));
  const filed = /evidence\/mcp\/fake\/(\S+\.json)\]$/.exec(long)?.[1];
  assert.ok(long.startsWith("x".repeat(MCP_CLIP)) && filed, long.slice(-200));
  assert.equal(JSON.parse(await readFile(join(work, "evidence", "mcp", "fake", filed), "utf8")).content[0].text.length, MCP_CLIP + 10);
});

test("a redirect is never followed: the credential goes nowhere else", async (t) => {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const hop = createServer((req, res) => res.writeHead(307, { location: fake.url }).end());
  await new Promise((resolve) => hop.listen(0, "127.0.0.1", resolve));
  t.after(() => hop.close());
  const { gateway } = await setup(t, { url: `http://127.0.0.1:${hop.address().port}/mcp` });
  const said = await gateway.call("fake", "add", { a: 1, b: 1 }, { signal: signal() });
  assert.equal(said.isError, true);
  assert.match(textOf(said), /redirect/);
  assert.ok(!textOf(said).includes(TOKEN));
  assert.equal(fake.log.length, 0, "the redirect's target saw nothing");
});

test("a server whose address changed, or that is no longer saved, is sent nothing", async (t) => {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const pin = { fake: { url: fake.url, tools } };
  const moved = mcpGateway({ pin, credentials: { fake: { url: "http://127.0.0.1:9/mcp" } }, work: () => tmpdir() });
  assert.match(textOf(await moved.call("fake", "add", {}, { signal: signal() })), /address changed since this run started; nothing was sent/);
  const gone = mcpGateway({ pin, credentials: {}, work: () => tmpdir() });
  assert.match(textOf(await gone.call("fake", "add", {}, { signal: signal() })), /no longer saved/);
  assert.match(textOf(await gone.call("fake", "delete_thing", {}, { signal: signal() })), /not a tool of the MCP server fake in this run/);
  assert.equal(fake.log.length, 0);
});

test("at the session proxy's /mcp/<server>: a client that drops a held tools/call cancels it at the server", async (t) => {
  const { fake, gateway } = await setup(t);
  const key = "session-key-for-tests";
  const policy = { id: "test", routes: [], keyOf: (headers) => String(headers.authorization ?? "").replace(/^Bearer /, ""), authHeaders: () => ({}), apply: (body) => body, usageOf: () => undefined };
  const proxy = await startModelProxy({ policy, model: "m", origin: "https://provider.invalid", credential: () => "c", hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, mcp: mcpRoute(gateway) }, key);
  t.after(() => proxy.close());
  const gone = new AbortController();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow_write", arguments: { line: "x", seconds: 30 } } });
  const held = new Promise((resolve) => {
    const req = request(`${proxy.url}/mcp/fake`, { method: "POST", signal: gone.signal, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => res.resume());
    req.once("error", () => resolve("dropped"));
    req.end(body);
  });
  while (!fake.log.some((entry) => entry.tool === "slow_write")) await new Promise((resolve) => setTimeout(resolve, 20));
  gone.abort();
  assert.equal(await held, "dropped");
  for (let i = 0; !fake.log.some((entry) => entry.method === "notifications/cancelled"); i++) {
    assert.ok(i < 150, `the server is told the call was cancelled: ${JSON.stringify(fake.log.map((entry) => entry.method))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fake.log.filter((entry) => entry.tool === "slow_write").length, 1, "and it was sent once");
});
