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
import { useSpend } from "../dist/cap.js";
import { isParked, MCP_CLIP, mcpCredentialsOf, mcpGateway, mcpPinOf } from "../dist/mcp-gateway.js";
import { deniedText, gateOf, waitingText } from "../dist/tool-gate.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const TOKEN = `not-a-secret-${"gateway-bearer-0123"}`;
const schema = { type: "object" };
const tools = ["add", "slow_write", "long", "echo", "paid"].map((name) => ({ name, inputSchema: schema }));

async function setup(t, { token = TOKEN, url, prices, gate, commit } = {}) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  fake.tools.echo = { description: "Echoes what it was sent.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: `seen Bearer ${TOKEN} and ${TOKEN}` }, { type: "image", data: Buffer.from(TOKEN).toString("base64"), mimeType: "image/png" }], structuredContent: { token: TOKEN } }) };
  fake.tools.long = { description: "A long answer.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: "x".repeat(MCP_CLIP + 10) }] }) };
  const work = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const pinned = url ?? fake.url;
  const gateway = mcpGateway({ pin: { fake: { url: pinned, tools, ...(prices ? { prices } : {}) } }, credentials: { fake: { url: pinned, headers: { authorization: `Bearer ${token}` } } }, work: () => work, ...(gate ? { gate } : {}), ...(commit ? { commit } : {}) });
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

/** The run's store as the gateway writes it: each entry its commits append to the root. */
function store() {
  const entries = [];
  return { entries, commit: () => async (change) => change({ appendEntry: async (_conversation, entry) => entries.push(entry) }) };
}

test("the gate: each call enters it as mcp:<server>/<tool> with its id and its harness's park; a denied call answers the gate's words and nothing is sent; an allowed one is sent; one with no id is never sent", async (t) => {
  const entered = [];
  const inner = gateOf((tool) => (tool === "mcp:fake/add" ? "deny" : "allow"));
  const gate = { ...inner, enter: (tool, args, callId, park, ...rest) => (entered.push({ tool, args, callId, park: typeof park?.commit === "function", rest: rest.length }), inner.enter(tool, args, callId, park)) };
  const { fake, gateway } = await setup(t, { gate, prices: { paid: 0.05 }, commit: store().commit });
  const denied = await gateway.call("fake", "add", { a: 2, b: 3 }, { signal: signal(), callId: "c1" });
  assert.deepEqual(denied, { content: [{ type: "text", text: deniedText("mcp:fake/add") }], isError: true });
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 0, "nothing was sent");
  assert.deepEqual(await gateway.call("fake", "paid", { query: "ada" }, { signal: signal(), callId: "c2" }), { content: [{ type: "text", text: "paid for ada" }] });
  assert.deepEqual(entered, [
    { tool: "mcp:fake/add", args: { a: 2, b: 3 }, callId: "c1", park: true, rest: 0 },
    { tool: "mcp:fake/paid", args: { query: "ada" }, callId: "c2", park: true, rest: 0 },
  ]);
  assert.match(textOf(await gateway.call("fake", "paid", { query: "ada" }, { signal: signal() })), /came with no call id/);
  assert.equal(entered.length, 2, "never at the gate");
});

test("a call the gate parks answers its waiting text, marked parked, with the harness's own park, and nothing is sent", async (t) => {
  const parks = [];
  const gate = { ...gateOf(() => "allow"), enter: async (tool, _args, callId, park) => (parks.push(park), park.parked?.(callId), { text: waitingText(tool), isError: false, parked: true }) };
  const { fake, gateway } = await setup(t, { gate });
  const parked = [];
  const park = { commit: async (change) => change({}), parked: (id) => parked.push(id) };
  const said = await gateway.call("fake", "add", { a: 1, b: 1 }, { signal: signal(), callId: "c1", park });
  assert.deepEqual([textOf(said), said.isError, isParked(said), JSON.stringify(said).includes("parked")], [waitingText("mcp:fake/add"), undefined, true, false]);
  assert.deepEqual([parks[0] === park, parked], [true, ["c1"]], "the harness's park, told the call parked");
  assert.equal(isParked(await setup(t).then(({ gateway: plain }) => plain.call("fake", "add", { a: 1, b: 1 }, { signal: signal() }))), false);
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 0);
});

test("a priced call is marked at its price, sent and booked at it; over the run's cap it is refused unsent; with nowhere to book it, refused unsent; an unpriced call is marked not metered", async (t) => {
  t.after(() => useSpend(undefined));
  const { entries, commit } = store();
  const { fake, gateway } = await setup(t, { prices: { paid: 0.05 }, commit });
  let spent = 0;
  useSpend({ cap: 0.04, spent: () => spent, add: (usd) => void (spent += usd) });
  const refused = await gateway.call("fake", "paid", { query: "ada" }, { signal: signal(), callId: "c1" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /^spend_cap_reached: mcp:fake\/paid was not sent\. It could cost up to \$0\.05 \(the price its owner set for mcp:fake\/paid\)/);
  assert.deepEqual(entries, [], "no mark: nothing was sent");
  useSpend({ cap: 1, spent: () => spent, add: (usd) => void (spent += usd) });
  assert.equal(textOf(await gateway.call("fake", "paid", { query: "ada" }, { signal: signal(), callId: "c2" })), "paid for ada");
  assert.equal(spent, 0.05, "the cap counts it");
  assert.deepEqual(await gateway.call("fake", "add", { a: 2, b: 3 }, { signal: signal(), callId: "c3" }), { content: [{ type: "text", text: "5" }] });
  const label = (tool, call) => ({ tool, charged_by: "fake", call });
  assert.deepEqual(entries, [
    { kind: "agentrun.tool_started", data: { ...label("mcp:fake/paid", "c2"), heldUsd: 0.05 } },
    { kind: "agentrun.tool_cost", data: { ...label("mcp:fake/paid", "c2"), usd: 0.05 } },
    { kind: "agentrun.tool_unmetered", data: label("mcp:fake/add", "c3") },
  ]);
  const { gateway: unbooked } = await setup(t, { prices: { paid: 0.05 } });
  assert.match(textOf(await unbooked.call("fake", "paid", { query: "ada" }, { signal: signal(), callId: "c4" })), /was not sent: this call has no run to book its price under/);
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 2, "the refused calls were never sent");
});

test("the gateway registers the gate's mcp: executor, which sends an approved call once through the same path, booked as any", async (t) => {
  const executors = new Map();
  const gate = { ...gateOf(() => "allow"), executor: (prefix, run) => void executors.set(prefix, run) };
  const { entries, commit } = store();
  const { fake } = await setup(t, { gate, commit });
  assert.deepEqual([...executors.keys()], ["mcp:"]);
  assert.deepEqual(await executors.get("mcp:")("mcp:fake/add", { a: 2, b: 3 }, "c1", signal()), { text: "5", isError: false });
  assert.equal(fake.log.filter((entry) => entry.tool === "add").length, 1);
  assert.deepEqual(entries.map((entry) => entry.kind), ["agentrun.tool_unmetered"]);
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
