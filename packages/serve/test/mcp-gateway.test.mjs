// The run's MCP gateway against the fake MCP server: a call stopped mid-way is cancelled upstream, a refused credential
// and a redirect are words the model reads (never a header, never a hop), a long answer is filed in work/ as lines the
// read tool pages through, and a server whose address changed is sent nothing.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { FILED_LINE_MAX, fileable, laidOut } from "../dist/filed-answer.js";
import { HEADER_SCAN_DEPTH, MCP_CLIP, mcpGateway, mcpHeaderProblem, mcpPinOf } from "../dist/mcp-gateway.js";
import { bookedIn } from "../dist/paid-calls.js";
import { localWorkspace, WORKSPACE_ERRORS } from "../dist/workspace/index.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const cap = await import("../../run-adapters/dist/kernel/cap/index.js");

const TOKEN = `not-a-secret-${"gateway-bearer-0123"}`;
const schema = { type: "object" };
const tools = ["add", "slow_write", "long", "echo", "paid", "hang", "json", "file"].map((name) => ({ name, inputSchema: schema }));
/** A long answer of many lines, as a pull request's diff is: past the clip. */
const LONG = Array.from({ length: 3_000 }, (_, i) => `+line ${i} ${"x".repeat(40)}`).join("\n");
/** A long answer of one line of JSON, as most of GitHub's are, with one value longer than a filed line. */
const JSON_LONG = JSON.stringify({ items: Array.from({ length: 2_000 }, (_, i) => ({ id: i, name: `item ${i}` })), patch: "p".repeat(3 * FILED_LINE_MAX) });

async function setup(t, { token = TOKEN, url, prices, commit, bounds } = {}) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  fake.tools.echo = { description: "Echoes what it was sent.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: `seen Bearer ${TOKEN} and ${TOKEN}` }, { type: "image", data: Buffer.from(TOKEN).toString("base64"), mimeType: "image/png" }], structuredContent: { token: TOKEN } }) };
  fake.tools.long = { description: "A long answer.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: LONG }] }) };
  fake.tools.json = { description: "A long answer of one line of JSON.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: JSON_LONG }] }) };
  // GitHub's get_file_contents: a line of text, and the file as an embedded text resource.
  fake.tools.file = { description: "A file.", input: { type: "object", properties: { size: { type: "number" } } }, run: (args) => ({ content: [{ type: "text", text: "successfully downloaded text file (SHA: abc)" }, { type: "resource", resource: { uri: "repo://o/r/contents/a.ts", mimeType: "text/plain", text: "const a = 1;\n".repeat(args?.size ?? 2) } }] }) };
  const work = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const pinned = url ?? fake.url;
  // Each tools/call request the client sends, with its signal: on 2026-07-28 a call is cancelled by closing its request.
  const sent = [];
  const spy = (input, init) => {
    if (typeof init?.body === "string" && init.body.includes('"tools/call"')) sent.push(init);
    return fetch(input, init);
  };
  const gateway = mcpGateway({ pin: { fake: { url: pinned, tools, ...(prices ? { prices } : {}) } }, credentials: { fake: { url: pinned, headers: { authorization: `Bearer ${token}` } } }, work: () => localWorkspace(work), fetch: spy, ...(commit ? { commit } : {}), ...(bounds ? { bounds } : {}) });
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
  // Its start is the file's first lines, whole; the note names the file and the read offset that goes on.
  const note = /\n\[cut at line (\d+) of 3000 \((\d+) of (\d+) characters\); the whole answer is in the run's files at evidence\/mcp\/fake\/(\S+\.txt): read it with offset=(\d+) to go on\]$/.exec(long);
  assert.ok(note, long.slice(-300));
  const [, shown, chars, total, file, offset] = note;
  assert.equal(Number(offset), Number(shown) + 1);
  assert.equal(Number(total), LONG.length);
  assert.ok(Number(chars) <= MCP_CLIP && Number(chars) > MCP_CLIP - 100, chars);
  const filed = await readFile(join(work, "evidence", "mcp", "fake", file), "utf8");
  assert.equal(filed, LONG, "the answer filed as its own lines, never inside JSON");
  assert.equal(long.slice(0, long.length - note[0].length), LONG.split("\n").slice(0, Number(shown)).join("\n"));
});

test("a long answer of one line of JSON is filed a value a line, no line past what read shows of one", async (t) => {
  const { gateway, work } = await setup(t);
  const long = textOf(await gateway.call("fake", "json", {}, { signal: signal() }));
  const note = /\n\[cut at line (\d+) of (\d+) \(\d+ of \d+ characters; its JSON laid out a value a line; 1 line longer than 10,000 characters broken into pieces of that length\); the whole answer is in the run's files at evidence\/mcp\/fake\/(\S+\.json): read it with offset=(\d+) to go on\]$/.exec(long);
  assert.ok(note, long.slice(-400));
  const filed = (await readFile(join(work, "evidence", "mcp", "fake", note[3]), "utf8")).split("\n");
  assert.equal(filed.length, Number(note[2]));
  assert.ok(filed.every((line) => line.length <= FILED_LINE_MAX), "every line read shows whole");
  assert.equal(filed.join("\n").replace(/p\n(?=p)/g, "p"), JSON.stringify(JSON.parse(JSON_LONG), null, 2), "the JSON laid out, its long value broken and nothing else changed");
  assert.equal(long.slice(0, long.length - note[0].length), filed.slice(0, Number(note[1])).join("\n"));
});

test("an embedded text resource (GitHub's file contents) is read inline; one past the clip is filed as its lines", async (t) => {
  const { gateway, work } = await setup(t);
  assert.equal(textOf(await gateway.call("fake", "file", {}, { signal: signal() })), "successfully downloaded text file (SHA: abc)\n\n[resource repo://o/r/contents/a.ts (text/plain)]\nconst a = 1;\nconst a = 1;\n");
  assert.deepEqual(await readdir(work), [], "nothing filed for an answer read whole");
  const long = textOf(await gateway.call("fake", "file", { size: 10_000 }, { signal: signal() }));
  const note = /in the run's files at (evidence\/mcp\/fake\/\S+\.txt): read it with offset=(\d+) to go on\]$/.exec(long);
  assert.ok(note, long.slice(-300));
  const filed = await readFile(join(work, note[1]), "utf8");
  assert.ok(filed.startsWith("successfully downloaded text file (SHA: abc)\n\n[resource repo://o/r/contents/a.ts (text/plain)]\nconst a = 1;\n") && filed.endsWith("const a = 1;\n"), filed.slice(0, 200));
});

test("an answer past the clip that cannot be filed (a link at evidence/) still answers, cut, with the port's code and its line", async (t) => {
  const { gateway, work } = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), "mcp-gateway-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(work, "evidence"));
  const long = textOf(await gateway.call("fake", "long", {}, { signal: signal() }));
  assert.ok(long.startsWith(LONG.slice(0, 10_000)), long.slice(0, 40));
  assert.match(long, /\n\[cut at line \d+ of 3000 \(\d+ of \d+ characters\); /);
  assert.ok(long.endsWith(`the whole answer could not be saved (ESCAPE: ${WORKSPACE_ERRORS.ESCAPE})]`), long.slice(-200));
  assert.deepEqual(await readdir(outside), [], "nothing written through the link");
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

test("names that are an object's own properties are servers and tools like any other: the pin holds them, the gateway names them", async () => {
  const listed = [{ name: "toString", inputSchema: schema }];
  const source = { server: (name) => (name === "constructor" ? { url: "http://127.0.0.1:9/mcp", tools: listed } : undefined) };
  const pin = mcpPinOf(["mcp:constructor/toString", "mcp:toString/add"], source);
  assert.deepEqual(Object.keys(pin), ["constructor"]);
  assert.deepEqual(pin.constructor.tools.map((tool) => tool.name), ["toString"]);
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

/** The run's one ledger as a claim opens it (the kernel cap's paid calls under a `capUsd` cap), and a call made under it
 *  as the adapter loop makes each host tool call (paid-calls.ts bookedIn): a priced call is held and booked there. */
async function ledger(capUsd) {
  const sessions = memorySessionStore();
  const paid = await cap.runCap({ sessions, capUsd: () => capUsd, now: () => Date.parse("2026-11-09T04:00:00Z"), modelOf: () => undefined }).tools(await sessions.open(cap.TOOL_SESSION));
  return { paid, call: (work) => bookedIn({ call: "c", record: async () => {}, paid }, work) };
}

/** The run's store as the gateway writes it: each entry its commits append to the root. */
function store() {
  const entries = [];
  return { entries, commit: () => async (change) => change({ appendEntry: async (_conversation, entry) => entries.push(entry) }) };
}

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

test("a tool named like an object's own property (__proto__) keeps its price: pinned, refused unsent over the cap, booked at it once it leaves", async (t) => {
  const listed = [{ name: "__proto__", inputSchema: schema }];
  // Saved prices read back from JSON, as the server's file and a PUT's body are.
  const source = { server: () => ({ url: "http://127.0.0.1:9/mcp", tools: listed, prices: JSON.parse('{"__proto__": 0.05}') }) };
  const pin = mcpPinOf(["mcp:fake/__proto__"], source);
  assert.deepEqual(Object.entries(pin.fake.prices), [["__proto__", 0.05]]);
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const gateway = mcpGateway({ pin: JSON.parse(JSON.stringify({ fake: { url: fake.url, tools: listed, prices: pin.fake.prices } })), credentials: { fake: { url: fake.url, headers: { authorization: `Bearer ${TOKEN}` } } }, work: () => tmpdir(), commit: store().commit });
  const under = await ledger(0.04);
  assert.match(textOf(await under.call(() => gateway.call("fake", "__proto__", {}, { signal: signal(), callId: "c1" }))), /^spend_cap_reached: [^]*mcp:fake\/__proto__, could cost up to \$0\.05/);
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 0, "refused unsent");
  const room = await ledger(1);
  // The call leaves (the fake answers it has no such tool): booked at its price, whatever it answers.
  await room.call(() => gateway.call("fake", "__proto__", {}, { signal: signal(), callId: "c2" }));
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 1);
  assert.equal(room.paid.spentUsd(), 0.05);
});

test("a call that never left (its server is down) books nothing: a priced one is charged nothing on the ledger, an unpriced one is not marked not metered", async () => {
  const { entries, commit } = store();
  const dead = "http://127.0.0.1:9/mcp";
  const priced = mcpGateway({ pin: { fake: { url: dead, tools, prices: { paid: 0.05, add: 0.01 } } }, credentials: { fake: { url: dead } }, work: () => tmpdir(), commit });
  const room = await ledger(1);
  const refused = await room.call(() => priced.call("fake", "paid", { query: "ada" }, { signal: signal(), callId: "c1" }));
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /The MCP server fake could not be reached at http:\/\/127\.0\.0\.1:9 \(.+\); nothing was sent\./);
  assert.deepEqual([room.paid.spentUsd(), entries], [0, []]);
  const unpriced = mcpGateway({ pin: { fake: { url: dead, tools } }, credentials: { fake: { url: dead } }, work: () => tmpdir(), commit });
  const said = await unpriced.call("fake", "add", {}, { signal: signal(), callId: "c2" });
  assert.equal(said.isError, true);
  assert.match(textOf(said), /The MCP server fake could not be reached at http:\/\/127\.0\.0\.1:9 \(.+\); nothing was sent\./);
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
  const source = { server: () => ({ url: "http://127.0.0.1:9/mcp", tools: [{ name: "bad", inputSchema: { type: "object", properties: { a: { type: "object", "x-mcp-header": "A" } } } }, { name: "good", inputSchema: valid }] }) };
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
    assert.equal(mcpHeaderProblem(watched), undefined, label);
    assert.deepEqual([visits().length, visits().every((n) => n === 1)], [objects, true], `${label}: every object listed exactly once`);
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

test("a call to a server that never answers ends at the call's deadline: an error the model reads, the upstream request aborted, and the gateway goes on", async (t) => {
  const { fake, gateway, cancelled } = await setup(t, { commit: store().commit, bounds: { callMs: 500 } });
  fake.tools.hang = { description: "Never answers.", input: { type: "object", properties: {} }, run: () => new Promise(() => {}) };
  // The call's own signal never aborts: only its deadline can end it.
  const answer = await gateway.call("fake", "hang", {}, { signal: signal(), callId: "c1" });
  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /The MCP server fake failed/);
  for (let i = 0; !cancelled() && !fake.log.some((entry) => entry.method === "closed" && entry.closed === "hang"); i++) {
    assert.ok(i < 100, `the server is told the call is over: ${JSON.stringify(fake.log.map((entry) => entry.method))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(await gateway.call("fake", "add", { a: 2, b: 3 }, { signal: signal(), callId: "c2" }), { content: [{ type: "text", text: "5" }] }, "the next call goes on");
});

test("a grant whose server is no longer saved, or whose tool a refresh removed, refuses the pin in words naming it", () => {
  const listed = [{ name: "add", inputSchema: schema }];
  const saved = { server: (name) => (name === "fake" ? { url: "http://127.0.0.1:9/mcp", tools: listed } : undefined) };
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

test("a token refreshed while a call is out is scrubbed too: its request carries the new one, and a server that echoes it never shows it in the answer, the error or the run's files", async (t) => {
  const OLD = `not-a-secret-${"refresh-old-0123456"}`;
  const NEW = `not-a-secret-${"refresh-new-6543210"}`;
  let seen = "";
  const fake = await startFakeMcp({ token: (authorization) => ((seen = authorization ?? ""), authorization === `Bearer ${OLD}` || authorization === `Bearer ${NEW}`) });
  t.after(() => fake.close());
  fake.tools.echo_auth = { description: "Echoes the credential it was sent.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: `sent ${seen}` }, { type: "image", data: Buffer.from("x").toString("base64"), mimeType: "image/png" }], structuredContent: { seen } }) };
  const work = await mkdtemp(join(tmpdir(), "mcp-gateway-refresh-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const echoing = ["echo_auth", "fail_auth"].map((name) => ({ name, inputSchema: schema }));
  /** A gateway whose credential is refreshed to NEW after its first call took its headers (OLD) and before that call's
   *  own request leaves: the refresh lands as the connect's first request goes. fail_auth's request is answered 500 with
   *  the credential it carried. */
  const refreshed = () => {
    const credentials = { fake: { url: fake.url, headers: { authorization: `Bearer ${OLD}` } } };
    const carried = [];
    const spy = async (input, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      carried.push(authorization);
      credentials.fake = { url: fake.url, headers: { authorization: `Bearer ${NEW}` } };
      if (typeof init?.body === "string" && init.body.includes('"fail_auth"')) return new Response(`refused for ${authorization}`, { status: 500 });
      return fetch(input, init);
    };
    return { carried, gateway: mcpGateway({ pin: { fake: { url: fake.url, tools: echoing } }, credentials, work: () => work, fetch: spy }) };
  };
  const one = refreshed();
  const answer = textOf(await one.gateway.call("fake", "echo_auth", {}, { signal: signal() }));
  assert.deepEqual([one.carried[0], one.carried.at(-1), seen], [`Bearer ${OLD}`, `Bearer ${NEW}`, `Bearer ${NEW}`], "the connect left with the old token, the call's request with the refreshed one");
  assert.ok(!answer.includes(NEW) && answer.startsWith("sent [redacted]\n"), `the answer: ${answer.slice(0, 120)}`);
  const filed = /evidence\/mcp\/fake\/(\S+\.json)\]$/.exec(answer)?.[1];
  assert.ok(filed, "a block that is not text is filed");
  const evidence = await readFile(join(work, "evidence", "mcp", "fake", filed), "utf8");
  assert.ok(!evidence.includes(NEW) && !evidence.includes(OLD) && evidence.includes("[redacted]"), "the run's files hold neither token");
  const two = refreshed();
  const failed = await two.gateway.call("fake", "fail_auth", {}, { signal: signal() });
  assert.equal(failed.isError, true);
  assert.ok(!textOf(failed).includes(NEW) && textOf(failed).includes("refused for [redacted]"), `the error: ${textOf(failed).slice(0, 200)}`);
});

test("the credentials a call holds for its scrub go when the call ends: held while it is out, none once the gateway is idle, however many calls and refreshes came", async (t) => {
  const tokens = Array.from({ length: 4 }, (_, i) => `not-a-secret-${`held-token-${i}-0123456`}`);
  let release = () => {};
  const fake = await startFakeMcp({ token: (authorization) => tokens.some((token) => authorization === `Bearer ${token}`) });
  t.after(() => fake.close());
  const work = await mkdtemp(join(tmpdir(), "mcp-gateway-held-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const credentials = { fake: { url: fake.url, headers: { authorization: `Bearer ${tokens[0]}` } } };
  let held;
  fake.tools.wait = { description: "Waits for the test.", input: { type: "object", properties: {} }, run: async () => {
    held = gateway.heldValues();
    await new Promise((resolve) => (release = resolve));
    return { content: [{ type: "text", text: "waited" }] };
  } };
  const gateway = mcpGateway({ pin: { fake: { url: fake.url, tools: [...tools, { name: "wait", inputSchema: schema }] } }, credentials, work: () => work });
  // Three calls, a refresh before each: none of them leaves a value held once it ended.
  for (const token of tokens.slice(1)) {
    credentials.fake = { url: fake.url, headers: { authorization: `Bearer ${token}` } };
    assert.equal(textOf(await gateway.call("fake", "add", { a: 1, b: 1 }, { signal: signal() })), "2");
  }
  assert.deepEqual(gateway.heldValues(), [], "idle, the gateway holds no credential for a scrub");
  // One out: what it took is held while it is out, and goes with it.
  const out = gateway.call("fake", "wait", {}, { signal: signal() });
  while (held === undefined) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(held, [`Bearer ${tokens[3]}`], "a call out holds what it took");
  release();
  assert.equal(textOf(await out), "waited");
  assert.deepEqual(gateway.heldValues(), [], "and none once it ended");
});

test("a server that echoes a Basic credential's bare token never shows it: the token is scrubbed with or without its scheme", async (t) => {
  const basic = Buffer.from(`conformance-user:${"not-a-secret-basic-pass-0123"}`).toString("base64");
  let seen = "";
  const fake = await startFakeMcp({ token: (authorization) => ((seen = authorization ?? ""), authorization === `Basic ${basic}`) });
  t.after(() => fake.close());
  fake.tools.echo_auth = { description: "Echoes the credential's token.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: `token ${seen.replace(/^Basic\s+/, "")} and header ${seen}` }] }) };
  const work = await mkdtemp(join(tmpdir(), "mcp-gateway-basic-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const gateway = mcpGateway({ pin: { fake: { url: fake.url, tools: [{ name: "echo_auth", inputSchema: schema }] } }, credentials: { fake: { url: fake.url, headers: { authorization: `Basic ${basic}` } } }, work: () => work });
  const answer = textOf(await gateway.call("fake", "echo_auth", {}, { signal: signal() }));
  assert.equal(answer, "token [redacted] and header [redacted]", "neither the bare token nor the header shows");
});

test("a filed JSON answer keeps its numbers as the server wrote them: an id past 2^53 and a long decimal are never rounded, and the layout is JSON.stringify's", () => {
  const big = '{"id":9007199254740993,"price":0.1000000000000000055511151231257827,"tags":["a",{"x":[]}],"empty":{},"s":"a,b:{c}[d] \\"q\\""}';
  const filed = fileable(big);
  assert.equal(filed.json, true);
  assert.match(filed.text, /"id": 9007199254740993,/, "the id as sent, not 9007199254740992");
  assert.match(filed.text, /"price": 0\.1000000000000000055511151231257827,/);
  assert.equal(filed.text.replace("9007199254740993", "9007199254740992").replace("0.1000000000000000055511151231257827", "0.1"), JSON.stringify(JSON.parse(big), null, 2), "laid out exactly as JSON.stringify(value, null, 2), numbers aside");
  const plain = JSON.stringify({ a: [1, 2, { b: null, c: true }], d: "x" });
  assert.equal(laidOut(plain), JSON.stringify(JSON.parse(plain), null, 2));
});
