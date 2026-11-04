// The run's MCP gateway against the fake MCP server: a call stopped mid-way is cancelled upstream, a refused credential
// and a redirect are words the model reads (never a header, never a hop), a long answer is filed in work/, and a server
// whose address changed is sent nothing.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { useSpend } from "../dist/cap.js";
import { MCP_CLIP, mcpGateway } from "../dist/mcp-gateway.js";
import { deniedText, GateAborted, gateOf } from "../dist/tool-gate.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const TOKEN = `not-a-secret-${"gateway-bearer-0123"}`;
const schema = { type: "object" };
const tools = ["add", "slow_write", "long", "paid"].map((name) => ({ name, inputSchema: schema }));

async function setup(t, { token = TOKEN, url, prices, gate, commit } = {}) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
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

/** The run's store as the gateway writes it: each entry its commits append to the root. */
function store() {
  const entries = [];
  return { entries, commit: () => async (change) => change({ appendEntry: async (_conversation, entry) => entries.push(entry) }) };
}

test("the gate: each call enters it as mcp:<server>/<tool>, held, with its signal and its price; a denied call answers the gate's words and nothing is sent; an allowed one is sent", async (t) => {
  const entered = [];
  const inner = gateOf((tool) => (tool === "mcp:fake/add" ? "deny" : "allow"));
  const gate = { ...inner, enter: (tool, args, callId, park, options) => (entered.push({ tool, args, callId, hold: options?.hold, signal: options?.signal instanceof AbortSignal, price: options?.price }), inner.enter(tool, args, callId, park, options)) };
  const { fake, gateway } = await setup(t, { gate, prices: { paid: 0.05 }, commit: store().commit });
  const denied = await gateway.call("fake", "add", { a: 2, b: 3 }, { signal: signal(), callId: "c1" });
  assert.deepEqual(denied, { content: [{ type: "text", text: deniedText("mcp:fake/add") }], isError: true });
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 0, "nothing was sent");
  assert.deepEqual(await gateway.call("fake", "paid", { query: "ada" }, { signal: signal(), callId: "c2" }), { content: [{ type: "text", text: "paid for ada" }] });
  assert.deepEqual(entered, [
    { tool: "mcp:fake/add", args: { a: 2, b: 3 }, callId: "c1", hold: true, signal: true, price: "not metered" },
    { tool: "mcp:fake/paid", args: { query: "ada" }, callId: "c2", hold: true, signal: true, price: 0.05 },
  ]);
});

test("a held wait that ends on its signal (the client went away, a stop) sends nothing", async (t) => {
  const gate = { ...gateOf(() => "allow"), enter: (tool, _args, callId, _park, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new GateAborted(tool, callId)))) };
  const { fake, gateway } = await setup(t, { gate });
  const stop = new AbortController();
  const waiting = gateway.call("fake", "add", { a: 1, b: 1 }, { signal: stop.signal, callId: "c1" });
  stop.abort();
  const said = await waiting;
  assert.equal(said.isError, true);
  assert.match(textOf(said), /stopped while it waited for a person's approval; nothing was sent/);
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
