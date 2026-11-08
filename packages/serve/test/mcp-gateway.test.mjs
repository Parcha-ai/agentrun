// The run's MCP gateway against the fake MCP server: a call stopped mid-way is cancelled upstream, a refused credential
// and a redirect are words the model reads (never a header, never a hop), a long answer is filed in work/, and a server
// whose address changed is sent nothing.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import { useSpend } from "../dist/cap.js";
import { HEADER_SCAN_DEPTH, isParked, MCP_CLIP, mcpCredentialsOf, mcpGateway, mcpHeaderProblem, mcpPinOf, mcpRegistrations } from "../dist/mcp-gateway.js";
import { deniedText, GATED_BY_GATEWAY, gateOf, waitingText } from "../dist/tool-gate.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const TOKEN = `not-a-secret-${"gateway-bearer-0123"}`;
const schema = { type: "object" };
const tools = ["add", "slow_write", "long", "echo", "paid", "hang"].map((name) => ({ name, inputSchema: schema }));

async function setup(t, { token = TOKEN, url, prices, gate, commit, bounds } = {}) {
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
  const gateway = mcpGateway({ pin: { fake: { url: pinned, tools, ...(prices ? { prices } : {}) } }, credentials: { fake: { url: pinned, headers: { authorization: `Bearer ${token}` } } }, work: () => work, fetch: spy, ...(gate ? { gate } : {}), ...(commit ? { commit } : {}), ...(bounds ? { bounds } : {}) });
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
  const source = { server: (name) => (name === "constructor" ? { url: "http://127.0.0.1:9/mcp", tools: listed } : undefined), headers: () => ({ headers: { authorization: `Bearer ${TOKEN}` } }) };
  const pin = mcpPinOf(["mcp:constructor/toString", "mcp:toString/add"], source);
  assert.deepEqual(Object.keys(pin), ["constructor"]);
  assert.deepEqual(pin.constructor.tools.map((tool) => tool.name), ["toString"]);
  assert.deepEqual(Object.keys(mcpCredentialsOf(pin, source)), ["constructor"]);
  assert.deepEqual(mcpCredentialsOf(pin, source).constructor.headers, { authorization: `Bearer ${TOKEN}` });
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

test("the gate: each call enters it as mcp:<server>/<tool> with its id, its harness's park and its price (or not metered); a denied call answers the gate's words and nothing is sent; an allowed one is sent; one with no id is never sent", async (t) => {
  const entered = [];
  const inner = gateOf((tool) => (tool === "mcp:fake/add" ? "deny" : "allow"));
  const gate = { ...inner, enter: (tool, args, callId, park, options) => (entered.push({ tool, args, callId, park: typeof park?.commit === "function", price: options?.price }), inner.enter(tool, args, callId, park, options)) };
  const { fake, gateway } = await setup(t, { gate, prices: { paid: 0.05 }, commit: store().commit });
  const denied = await gateway.call("fake", "add", { a: 2, b: 3 }, { signal: signal(), callId: "c1" });
  assert.deepEqual(denied, { content: [{ type: "text", text: deniedText("mcp:fake/add") }], isError: true });
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 0, "nothing was sent");
  assert.deepEqual(await gateway.call("fake", "paid", { query: "ada" }, { signal: signal(), callId: "c2" }), { content: [{ type: "text", text: "paid for ada" }] });
  assert.deepEqual(entered, [
    { tool: "mcp:fake/add", args: { a: 2, b: 3 }, callId: "c1", park: true, price: "not metered" },
    { tool: "mcp:fake/paid", args: { query: "ada" }, callId: "c2", park: true, price: 0.05 },
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
  // The gateway's answer carries `parked` for the harness's session; the door never sends it to a harness's own client
  // (run-adapters mcp-route.test.mjs: "never the host's parked flag").
  assert.deepEqual([textOf(said), said.isError, isParked(said), said.parked], [waitingText("mcp:fake/add"), undefined, true, true]);
  assert.deepEqual([parks[0] === park, parked], [true, ["c1"]], "the harness's park, told the call parked");
  assert.equal(isParked(await setup(t).then(({ gateway: plain }) => plain.call("fake", "add", { a: 1, b: 1 }, { signal: signal() }))), false);
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 0);
});

test("a call from a harness that cannot end its turn on a parked call (no `parked` in its park) never parks: the gate's request is refused before it is written, the call is answered so, and nothing is sent", async (t) => {
  const written = [];
  // A gate that parks as the run's does: the request committed through the park, then the waiting text.
  const gate = { ...gateOf(() => "allow"), enter: async (tool, _args, callId, park) => {
    await park.commit(async () => written.push(callId));
    park.parked?.(callId);
    return { text: waitingText(tool), isError: false, parked: true };
  } };
  const { fake, gateway } = await setup(t, { gate, commit: store().commit });
  for (const park of [undefined, { commit: async (change) => change({}) }]) {
    const said = await gateway.call("fake", "add", { a: 1, b: 1 }, { signal: signal(), callId: "c1", ...(park ? { park } : {}) });
    assert.deepEqual([textOf(said), said.isError, isParked(said)], ["The mcp:fake/add call needs a person's approval, which this harness can't wait for yet; nothing was sent.", true, false]);
  }
  assert.deepEqual(written, [], "no approval left waiting");
  // A gate that answers parked without committing is refused too.
  const { gateway: bare } = await setup(t, { gate: { ...gate, enter: async (tool) => ({ text: waitingText(tool), isError: false, parked: true }) } });
  assert.equal(isParked(await bare.call("fake", "add", {}, { signal: signal(), callId: "c2" })), false);
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
  assert.match(textOf(refused), /^spend_cap_reached: Not sent: this run has spent \$0 of its \$0\.04 cap, and the next step, mcp:fake\/paid, could cost up to \$0\.05 \(the price its owner set for mcp:fake\/paid\)/);
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
  const { fake, gateway, cancelled } = await setup(t);
  const key = "session-key-for-tests";
  const policy = { id: "test", routes: [], keyOf: (headers) => String(headers.authorization ?? "").replace(/^Bearer /, ""), authHeaders: () => ({}), apply: (body) => body, usageOf: () => undefined };
  const proxy = await startModelProxy({ policy, model: "m", origin: "https://provider.invalid", credential: () => "c", hooks: { beforeRequest: async () => {}, afterRequest: async () => {} }, mcp: { session: gateway, client: { callIdMeta: "claudecode/toolUseId" } } }, key);
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

test("a tool named like an object's own property (__proto__) keeps its price: pinned, refused over the cap, held and booked once it leaves", async (t) => {
  t.after(() => useSpend(undefined));
  const listed = [{ name: "__proto__", inputSchema: schema }];
  // Saved prices read back from JSON, as the server's file and a PUT's body are.
  const source = { server: () => ({ url: "http://127.0.0.1:9/mcp", tools: listed, prices: JSON.parse('{"__proto__": 0.05}') }), headers: () => undefined };
  const pin = mcpPinOf(["mcp:fake/__proto__"], source);
  assert.deepEqual(Object.entries(pin.fake.prices), [["__proto__", 0.05]]);
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const { entries, commit } = store();
  const gateway = mcpGateway({ pin: JSON.parse(JSON.stringify({ fake: { url: fake.url, tools: listed, prices: pin.fake.prices } })), credentials: { fake: { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } } }, work: () => tmpdir(), commit });
  let spent = 0;
  useSpend({ cap: 0.04, spent: () => spent, add: (usd) => void (spent += usd) });
  assert.match(textOf(await gateway.call("fake", "__proto__", {}, { signal: signal(), callId: "c1" })), /^spend_cap_reached: Not sent: this run has spent \$0 of its \$0\.04 cap, and the next step, mcp:fake\/__proto__, could cost up to \$0\.05/);
  useSpend({ cap: 1, spent: () => spent, add: (usd) => void (spent += usd) });
  // The call leaves (the fake answers it has no such tool): booked at its price, whatever it answers.
  await gateway.call("fake", "__proto__", {}, { signal: signal(), callId: "c2" });
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 1);
  assert.equal(spent, 0.05);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.data.usd ?? entry.data.heldUsd]), [["agentrun.tool_started", 0.05], ["agentrun.tool_cost", 0.05]]);
});

test("a priced call that never left (its server is down) books nothing: no mark, no charge, the cap untouched", async (t) => {
  t.after(() => useSpend(undefined));
  const { entries, commit } = store();
  const dead = "http://127.0.0.1:9/mcp";
  const gateway = mcpGateway({ pin: { fake: { url: dead, tools, prices: { paid: 0.05, add: 0.01 } } }, credentials: { fake: { url: dead } }, work: () => tmpdir(), commit });
  let spent = 0;
  useSpend({ cap: 1, spent: () => spent, add: (usd) => void (spent += usd) });
  const said = await gateway.call("fake", "paid", { query: "ada" }, { signal: signal(), callId: "c1" });
  assert.equal(said.isError, true);
  assert.match(textOf(said), /The MCP server fake could not be reached at http:\/\/127\.0\.0\.1:9 \(.+\); nothing was sent\./);
  assert.deepEqual([spent, entries], [0, []]);
  const unpriced = mcpGateway({ pin: { fake: { url: dead, tools } }, credentials: { fake: { url: dead } }, work: () => tmpdir(), commit });
  await unpriced.call("fake", "add", {}, { signal: signal(), callId: "c2" });
  assert.deepEqual(entries, [], "nor marked not metered");
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

test("a declared header that cannot be sent is named, and a grant of its tool refuses the pin in words", () => {
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
  assert.deepEqual(mcpPinOf(["mcp:fake/good"], source).fake.tools.map((tool) => tool.name), ["good"]);
  // A granted tool that cannot be pinned refuses the pin in words, never a pin without it.
  assert.throws(() => mcpPinOf(["mcp:fake/bad", "mcp:fake/good"], source), /^Error: The MCP tool mcp:fake\/bad declares a header it cannot send: a: x-mcp-header is only allowed on a string, integer or boolean\.$/);
});

test("the header check walks schema keywords only: an x-mcp-header inside default, examples, const or enum is data and never refused; the same under a real keyword still is", () => {
  const stray = { "x-mcp-header": "Stray" };
  const unsendable = { type: "object", "x-mcp-header": "Stray", properties: { inner: { type: "array", items: { type: "string", "x-mcp-header": "Item" } } } };
  for (const [keyword, value] of [["default", stray], ["examples", [stray, unsendable]], ["const", unsendable], ["enum", [stray, { nested: [stray] }]]]) {
    const onProperty = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region", [keyword]: value } } };
    assert.equal(mcpHeaderProblem(onProperty), undefined, `${keyword} on a property holds data, not schema`);
    assert.equal(mcpHeaderProblem({ type: "object", [keyword]: value, properties: { a: { type: "string" } } }), undefined, `${keyword} at the root holds data, not schema`);
  }
  // A vendor annotation holds no schema either, as the SDK client's own check reads it.
  assert.equal(mcpHeaderProblem({ type: "object", "x-ui": { hint: stray }, properties: { a: { type: "string" } } }), undefined, "an annotation is no schema");
  for (const [keyword, schema] of [
    ["items", { type: "object", properties: { list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } } } }],
    ["anyOf", { type: "object", anyOf: [{ type: "string", "x-mcp-header": "Any" }] }],
    ["additionalProperties", { type: "object", additionalProperties: { type: "string", "x-mcp-header": "Extra" } }],
    ["$defs", { type: "object", $defs: { region: { type: "string", "x-mcp-header": "Region" } } }],
    ["patternProperties", { type: "object", patternProperties: { "^r": { type: "string", "x-mcp-header": "Region" } } }],
  ]) assert.match(mcpHeaderProblem(schema) ?? "", /reached through properties alone/, keyword);
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

test("an approved call to a server that never answers ends at the call's deadline: an error the model reads, the upstream request aborted, and the gateway goes on", async (t) => {
  const executors = new Map();
  const gate = { ...gateOf(() => "allow"), executor: (prefix, run) => void executors.set(prefix, run) };
  const { fake, gateway, cancelled } = await setup(t, { gate, commit: store().commit, bounds: { callMs: 500 } });
  fake.tools.hang = { description: "Never answers.", input: { type: "object", properties: {} }, run: () => new Promise(() => {}) };
  const started = Date.now();
  const answer = await executors.get("mcp:")("mcp:fake/hang", {}, "c1", signal());
  assert.equal(answer.isError, true);
  assert.match(answer.text, /The MCP server fake failed/);
  assert.ok(Date.now() - started < 5_000, `ended at its bound, ${Date.now() - started} ms`);
  for (let i = 0; !cancelled() && !fake.log.some((entry) => entry.method === "closed" && entry.closed === "hang"); i++) {
    assert.ok(i < 100, `the server is told the call is over: ${JSON.stringify(fake.log.map((entry) => entry.method))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(await gateway.call("fake", "add", { a: 2, b: 3 }, { signal: signal(), callId: "c2" }), { content: [{ type: "text", text: "5" }] }, "the next call goes on");
});

test("pi's registrations carry GATED_BY_GATEWAY only when the gateway holds the run's gate, so the gate's wrapper leaves exactly those", () => {
  const pin = { fake: { url: "http://127.0.0.1:9/mcp", tools } };
  const gated = mcpRegistrations(mcpGateway({ pin, credentials: {}, work: () => tmpdir(), gate: { enter: async () => undefined } }));
  assert.deepEqual(gated.map((tool) => [tool.name, tool[GATED_BY_GATEWAY]]), tools.map((tool) => [`mcp__fake__${tool.name}`, true]));
  assert.equal(typeof gated[0].execute, "function", "the marked registration is the tool, whole");
  const ungated = mcpRegistrations(mcpGateway({ pin, credentials: {}, work: () => tmpdir() }));
  assert.ok(ungated.every((tool) => tool[GATED_BY_GATEWAY] === undefined), "a gateway without the gate marks none, so the wrapper gates them");
});

test("a grant whose server is no longer saved, or whose tool a refresh removed, refuses the pin in words naming it", () => {
  const listed = [{ name: "add", inputSchema: schema }];
  const saved = { server: (name) => (name === "fake" ? { url: "http://127.0.0.1:9/mcp", tools: listed } : undefined), headers: () => undefined };
  assert.throws(() => mcpPinOf(["mcp:gone/add"], saved), /^Error: The MCP tool mcp:gone\/add cannot be pinned: the MCP server gone is no longer saved\.$/);
  assert.throws(() => mcpPinOf(["mcp:fake/add", "mcp:fake/sub"], saved), /^Error: The MCP tool mcp:fake\/sub cannot be pinned: sub is no longer one of its tools since the last refresh\.$/);
  assert.deepEqual(Object.keys(mcpPinOf(["mcp:fake/add", "read"], saved)), ["fake"], "a name that is no MCP tool's is not the pin's");
});

test("a server that can't be reached reads so, at its address with a short reason and that nothing was sent, never the MCP SDK's own words", async (t) => {
  // A server that cannot be reached: a port this test holds for its whole run, so no other test can take it, where each
  // connection is reset at once (TCP RST) before any HTTP answer. A freed port is not used: another test may bind it
  // between the close and the dial.
  const dead = createTcpServer((socket) => socket.resetAndDestroy());
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => dead.close(resolve)));
  const url = `http://127.0.0.1:${dead.address().port}/mcp`;
  const { gateway } = await setup(t, { url });
  const said = await gateway.call("fake", "add", { a: 2, b: 3 }, { signal: signal() });
  assert.equal(said.isError, true);
  assert.equal(textOf(said), `The MCP server fake could not be reached at ${new URL(url).origin} (the connection was reset); nothing was sent.`);
  assert.doesNotMatch(textOf(said), /Version negotiation|fetch failed/);
});

test("today's construction copies the credentials: a header changed after connect, an entry replaced or one removed is not seen; with liveCredentials each is", async (t) => {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const work = await mkdtemp(join(tmpdir(), "mcp-gateway-live-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const WRONG = `not-a-secret-${"replaced-token-0123"}`;
  const built = (extra = {}) => {
    const credentials = { fake: { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } } };
    return { credentials, gateway: mcpGateway({ pin: { fake: { url: fake.url, tools } }, credentials, work: () => work, ...extra }) };
  };
  const add = (gateway) => gateway.call("fake", "add", { a: 1, b: 1 }, { signal: signal() }).then(textOf);
  const refused = "The MCP server fake refused its credential (its sign-in expired or was revoked, or its key changed): sign in again in Settings → MCP servers, or update its credential there.";
  // Today's construction (app.ts passes no liveCredentials): what it was built with, whatever changes after.
  const today = built();
  assert.equal(await add(today.gateway), "2", "connected with the token it was built with");
  today.credentials.fake.headers = { authorization: `Bearer ${WRONG}` };
  assert.equal(await add(today.gateway), "2", "a header changed after connect is not sent: the client sends the one it connected with");
  today.credentials.fake = { url: fake.url, headers: { authorization: `Bearer ${WRONG}` } };
  assert.equal(await add(today.gateway), "2", "an entry replaced after construction is not seen");
  delete today.credentials.fake;
  assert.equal(await add(today.gateway), "2", "nor one removed");
  // liveCredentials (the runner's claim step only): each change reaches the next call, through the client already connected.
  const live = built({ liveCredentials: true });
  assert.equal(await add(live.gateway), "2");
  live.credentials.fake.headers = { authorization: `Bearer ${WRONG}` };
  assert.equal(await add(live.gateway), refused, "a header changed after connect is sent at the next request");
  live.credentials.fake = { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } };
  assert.equal(await add(live.gateway), "2", "an entry replaced is used");
  delete live.credentials.fake;
  assert.equal(await add(live.gateway), "The MCP server fake is no longer saved on this server; nothing was sent.", "an entry removed is refused unsent");
});
