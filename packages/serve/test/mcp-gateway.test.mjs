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
import { HEADER_SCAN_DEPTH, MCP_CLIP, mcpCredentialsOf, mcpGateway, mcpHeaderProblem, mcpPinOf } from "../dist/mcp-gateway.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const TOKEN = `not-a-secret-${"gateway-bearer-0123"}`;
const schema = { type: "object" };
const tools = ["add", "slow_write", "long", "echo"].map((name) => ({ name, inputSchema: schema }));

async function setup(t, { token = TOKEN, url } = {}) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  fake.tools.echo = { description: "Echoes what it was sent.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: `seen Bearer ${TOKEN} and ${TOKEN}` }, { type: "image", data: Buffer.from(TOKEN).toString("base64"), mimeType: "image/png" }], structuredContent: { token: TOKEN } }) };
  fake.tools.long = { description: "A long answer.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: "x".repeat(MCP_CLIP + 10) }] }) };
  const work = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const pinned = url ?? fake.url;
  // Each tools/call request the client sends, with its signal: on 2026-07-28 a call is cancelled by closing its request.
  const sent = [];
  const spy = (input, init) => {
    if (typeof init?.body === "string" && init.body.includes('"tools/call"')) sent.push(init);
    return fetch(input, init);
  };
  const gateway = mcpGateway({ pin: { fake: { url: pinned, tools } }, credentials: { fake: { url: pinned, headers: { authorization: `Bearer ${token}` } } }, work: () => work, fetch: spy });
  /** Whether the server was told the call was cancelled: notifications/cancelled (2025 era), or its request closed. */
  const cancelled = () => fake.log.some((entry) => entry.method === "notifications/cancelled") || sent.some((init) => init.signal?.aborted);
  return { fake, gateway, work, cancelled };
}
const signal = () => new AbortController().signal;
const textOf = (result) => result.content.map((block) => block.text).join("");

test("a call answers its text; one stopped mid-way is cancelled upstream and answers stopped", async (t) => {
  const { fake, gateway, cancelled } = await setup(t);
  assert.deepEqual(await gateway.call("fake", "add", { a: 2, b: 3 }, { signal: signal() }), { content: [{ type: "text", text: "5" }] });
  const stop = new AbortController();
  const slow = gateway.call("fake", "slow_write", { line: "x", seconds: 30 }, { signal: stop.signal });
  while (!fake.log.some((entry) => entry.tool === "slow_write")) await new Promise((resolve) => setTimeout(resolve, 20));
  stop.abort();
  const stopped = await slow;
  assert.equal(stopped.isError, true);
  assert.match(textOf(stopped), /stopped/);
  for (let i = 0; !cancelled(); i++) {
    assert.ok(i < 100, `the server is told the call was cancelled: ${JSON.stringify(fake.log.map((entry) => entry.method))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("a refused credential says where to update it and never shows it; an answer past the clip is filed in work/", async (t) => {
  const { gateway: refused } = await setup(t, { token: `not-a-secret-${"wrong-token-0123456"}` });
  const said = await refused.call("fake", "add", { a: 1, b: 1 }, { signal: signal() });
  assert.equal(said.isError, true);
  assert.equal(textOf(said), "The MCP server fake refused its credential (its sign-in expired or was revoked, or its key changed): sign in again in Settings → MCP servers, or update its credential there.");
  const { gateway, work } = await setup(t);
  const long = textOf(await gateway.call("fake", "long", {}, { signal: signal() }));
  const filed = /evidence\/mcp\/fake\/(\S+\.json)\]$/.exec(long)?.[1];
  assert.ok(long.startsWith("x".repeat(MCP_CLIP)) && filed, long.slice(-200));
  assert.equal(JSON.parse(await readFile(join(work, "evidence", "mcp", "fake", filed), "utf8")).content[0].text.length, MCP_CLIP + 10);
});

test("a server that echoes its credential never shows it: not to the model, not in the run's files", async (t) => {
  const { gateway, work } = await setup(t);
  const text = textOf(await gateway.call("fake", "echo", {}, { signal: signal() }));
  assert.ok(!text.includes(TOKEN) && text.startsWith("seen [redacted] and [redacted]"), text);
  const filed = /evidence\/mcp\/fake\/(\S+\.json)\]$/.exec(text)?.[1];
  assert.ok(filed, "a block that is not text is filed");
  assert.ok(!(await readFile(join(work, "evidence", "mcp", "fake", filed), "utf8")).includes(TOKEN));
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

test("names that are an object's own properties are servers and tools like any other: the pin and the credentials hold them", async () => {
  const listed = [{ name: "toString", inputSchema: schema }];
  const source = { server: (name) => (name === "constructor" ? { url: "http://127.0.0.1:9/mcp", tools: listed } : undefined), headers: () => ({ authorization: `Bearer ${TOKEN}` }) };
  const pin = mcpPinOf(["mcp:constructor/toString", "mcp:toString/add"], source);
  assert.deepEqual(Object.keys(pin), ["constructor"]);
  assert.deepEqual(pin.constructor.tools.map((tool) => tool.name), ["toString"]);
  assert.deepEqual(Object.keys(mcpCredentialsOf(pin, source)), ["constructor"]);
  const none = mcpGateway({ pin: {}, credentials: {}, work: () => tmpdir() });
  assert.match(textOf(await none.call("constructor", "toString", {}, { signal: signal() })), /not a tool of the MCP server constructor/);
  assert.match(textOf(await none.call("__proto__", "toString", {}, { signal: signal() })), /not a tool/);
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
  const { fake, gateway, cancelled } = await setup(t);
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
  for (let i = 0; !cancelled(); i++) {
    assert.ok(i < 150, `the server is told the call was cancelled: ${JSON.stringify(fake.log.map((entry) => entry.method))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fake.log.filter((entry) => entry.tool === "slow_write").length, 1, "and it was sent once");
});

test("a tool's x-mcp-header parameter is mirrored into its Mcp-Param header on a 2026-07-28 server, from the pinned definition; a legacy server is called as before", async (t) => {
  const tagged = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" }, n: { type: "integer" } }, required: ["region"] };
  for (const era of ["modern", "legacy"]) {
    const fake = await startFakeMcp({ token: TOKEN, era });
    t.after(() => fake.close());
    fake.tools.tagged = { description: "Answers its region.", input: tagged, run: ({ region }) => ({ content: [{ type: "text", text: `region ${region}` }] }) };
    const sent = [];
    const spy = async (input, init) => (sent.push(Object.fromEntries(new Headers(init?.headers))), fetch(input, init));
    const gateway = mcpGateway({ pin: { fake: { url: fake.url, tools: [{ name: "tagged", inputSchema: tagged }] } }, credentials: { fake: { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } } }, work: () => tmpdir(), fetch: spy });
    const said = await gateway.call("fake", "tagged", { region: "eu", n: 1 }, { signal: signal() });
    assert.deepEqual(said, { content: [{ type: "text", text: "region eu" }] }, era);
    const mirrored = sent.filter((headers) => headers["mcp-param-region"] !== undefined).map((headers) => headers["mcp-param-region"]);
    assert.deepEqual(mirrored, era === "modern" ? ["eu"] : [], `${era}: ${JSON.stringify(sent.map((h) => Object.keys(h)))}`);
  }
});

test("a declared header that cannot be sent is named, and its tool is never pinned", () => {
  const valid = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" }, flag: { type: "boolean", "x-mcp-header": "Flag" } } };
  assert.equal(mcpHeaderProblem(valid), undefined);
  assert.equal(mcpHeaderProblem({ type: "object", properties: { a: { type: "string" } } }), undefined);
  for (const [schema, said] of [
    [{ type: "object", properties: { region: { type: "object", "x-mcp-header": "Region" } } }, /string, integer or boolean/],
    [{ type: "object", properties: { list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } } } }, /reached through properties alone/],
    [{ type: "object", properties: { a: { type: "string", "x-mcp-header": "Region" }, b: { type: "string", "x-mcp-header": "region" } } }, /declared twice/],
    [{ type: "object", properties: { a: { type: "string", "x-mcp-header": "Two words" } } }, /RFC 9110 token/],
  ]) assert.match(mcpHeaderProblem(schema) ?? "", said);
  const source = { server: () => ({ url: "http://127.0.0.1:9/mcp", tools: [{ name: "bad", inputSchema: { type: "object", properties: { a: { type: "object", "x-mcp-header": "A" } } } }, { name: "good", inputSchema: valid }] }), headers: () => undefined };
  assert.deepEqual(mcpPinOf(["mcp:fake/bad", "mcp:fake/good"], source).fake.tools.map((tool) => tool.name), ["good"]);
});

/** A schema `levels` deep in additionalProperties, every level also holding a property. */
const deepSchema = (levels) => {
  let schema = { type: "string" };
  for (let i = 0; i < levels; i++) schema = { type: "object", properties: { [`p${i}`]: { type: "string" } }, additionalProperties: schema };
  return schema;
};

test("the header check visits each part of a schema once, within its bounds: deep, wide and shared schemas", () => {
  /** `schema` with each of its objects behind a proxy that counts how often its keys are listed, the one step the check
   *  takes on every object it visits; and how many distinct objects it holds. */
  const counted = (schema) => {
    const proxies = new Map();
    const listed = new Map();
    const wrap = (node) => {
      if (!node || typeof node !== "object") return node;
      if (proxies.has(node)) return proxies.get(node);
      const proxy = new Proxy(node, {
        ownKeys: (target) => (listed.set(target, (listed.get(target) ?? 0) + 1), Reflect.ownKeys(target)),
        get: (target, key) => wrap(Reflect.get(target, key)),
      });
      proxies.set(node, proxy);
      return proxy;
    };
    const objects = new Set();
    const walk = (node) => {
      if (!node || typeof node !== "object" || objects.has(node)) return;
      objects.add(node);
      for (const value of Array.isArray(node) ? node : Object.values(node)) walk(value);
    };
    walk(schema);
    return { schema: wrap(schema), objects: objects.size, visits: () => [...listed.values()] };
  };
  const once = (schema, label) => {
    const { schema: watched, objects, visits } = counted(schema);
    const start = performance.now();
    const said = mcpHeaderProblem(watched);
    const ms = performance.now() - start;
    assert.equal(said, undefined, label);
    assert.deepEqual([visits().length, visits().every((n) => n === 1)], [objects, true], `${label}: every object listed exactly once`);
    assert.ok(ms < 2_000, `${label}: ${ms} ms`);
  };
  once(deepSchema(60), "60 levels of additionalProperties");
  once({ type: "object", properties: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`p${i}`, { type: "string", ...(i === 4999 ? { "x-mcp-header": "Last" } : {}) }])) }, "5,000 properties");
  // One object reached from many places, and a cycle, as a parsed schema never holds but an object can.
  const shared = { type: "string" };
  once({ type: "object", properties: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`p${i}`, shared])) }, "one object under 2,000 names");
  const cyclic = { type: "object", properties: {} };
  cyclic.additionalProperties = cyclic;
  once(cyclic, "a cycle");
  assert.match(mcpHeaderProblem(deepSchema(HEADER_SCAN_DEPTH + 10)) ?? "", /nests deeper than 64 levels/);
  assert.match(mcpHeaderProblem({ type: "object", properties: Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`p${i}`, { type: "string" }])) }) ?? "", /larger than 10000 parts/);
});
