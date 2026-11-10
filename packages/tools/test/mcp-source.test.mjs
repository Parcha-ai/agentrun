// The MCP source against the adapter half of the tools protocol's conformance, over a fake network (fake-mcp-network.mjs):
// list shape and schema validity; the version stable for one snapshot and moved by a change; credentials only to the
// bound origin, never through a redirect, never echoed; each fault mapped to its refusal; a stop answered within 250 ms;
// check() touching the handshake alone; every unsupported cap refused in words. No sockets, no keys.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpSource, snapshotVersion, MCP_CLIP, MAX_TOOLS } from "../dist/sources/mcp/index.js";
import { baseTools, credentialOf, ELSEWHERE, fakeMcpNetwork, ORIGIN, URL_ } from "./fake-mcp-network.mjs";

const SECRET = "sk-live-0123456789abcdef";
const bearer = { url: URL_, auth: "bearer", name: "fake" };
const ctxOf = (fake, settings = bearer, extra = {}) => ({ signal: new AbortController().signal, fetch: fake.fetch, credential: credentialOf({ authorization: SECRET }), settings, ...extra });
const callCtxOf = (fake, settings = bearer, extra = {}) => ({ ...ctxOf(fake, settings), callId: "call-1", attempt: 1, filed: [], async file(name, body) { this.filed.push({ name, body }); return name; }, ...extra });
const specOf = async (source, fake, tool, settings = bearer) => (await source.actions("mcp:fake", ctxOf(fake, settings))).find((spec) => spec.id === `mcp:fake/${tool}`);
const leaks = (text) => text.includes(SECRET);

test("actions lists every page, each tool an ActionSpec of the protocol's shape with a valid schema", async () => {
  const fake = fakeMcpNetwork();
  fake.tools.COMPOSIO_MULTI_EXECUTE_TOOL = { description: "Run tools by slug.", inputSchema: { type: "object" }, run: () => ({ content: [] }) };
  fake.tools["dotted.name"] = { description: "A name outside the grammar.", inputSchema: { type: "object" }, run: () => ({ content: [] }) };
  fake.tools.headered = { description: "A header declared at the root.", inputSchema: { type: "object", "x-mcp-header": "X-Root" }, run: () => ({ content: [] }) };
  const source = mcpSource();
  const specs = await source.actions("mcp:fake", ctxOf(fake, { ...bearer, "price.add": "0.25" }));
  assert.deepEqual(specs.map((spec) => spec.id).sort(), ["mcp:fake/COMPOSIO_MULTI_EXECUTE_TOOL", "mcp:fake/add", "mcp:fake/delete_thing", "mcp:fake/dotted.name", "mcp:fake/headered", "mcp:fake/write_line"]);
  assert.ok(fake.methods().filter((method) => method === "tools/list").length >= 3, "every page was read (two tools a page)");
  for (const spec of specs) {
    assert.equal(typeof spec.title, "string");
    assert.equal(typeof spec.description, "string");
    assert.equal(spec.inputSchema.type, "object", `${spec.id}'s schema is an object schema`);
    assert.doesNotThrow(() => JSON.stringify(spec.inputSchema));
    assert.equal(spec.replay, "never");
    assert.equal(spec.resultMaxChars, MCP_CLIP);
    assert.deepEqual(spec.custody, { kind: "sealed_key", keyRef: "mcp:fake", boundTo: ORIGIN });
    assert.match(spec.version, /^sha256:[0-9a-f]{64}$/);
    assert.equal(spec.risk.from, "source_hint");
  }
  const by = Object.fromEntries(specs.map((spec) => [spec.id.slice("mcp:fake/".length), spec]));
  assert.equal(by.add.title, "Add");
  assert.equal(by.add.risk.level, "read");
  assert.equal(by.delete_thing.risk.level, "destructive");
  assert.equal(by.write_line.risk.level, "write");
  assert.deepEqual(by.add.price, { kind: "metered", usdPerCall: 0.25, holdUsd: 0.25 });
  assert.deepEqual(by.write_line.price, { kind: "not_metered" });
  assert.equal(by.add.grantable, true);
  assert.match(by.COMPOSIO_MULTI_EXECUTE_TOOL.grantable.reason, /runs other actions by name/);
  assert.match(by["dotted.name"].grantable.reason, /letters, digits, _ and -/);
  assert.match(by.headered.grantable.reason, /declares a header it cannot send/);
  assert.equal(new Set(specs.map((spec) => spec.version)).size, 1, "one version for the whole snapshot");
  // `only` narrows the expansion, by tool name or by action id.
  assert.deepEqual((await source.actions("mcp:fake", ctxOf(fake), ["add", "mcp:fake/write_line"])).map((spec) => spec.id).sort(), ["mcp:fake/add", "mcp:fake/write_line"]);
});

test("an OAuth server's actions are in oauth custody bound to its origin; auth none sends nothing and holds none", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  const [oauth] = await source.actions("mcp:fake", ctxOf(fake, { url: URL_, auth: "oauth" }), ["add"]);
  assert.deepEqual(oauth.custody, { kind: "oauth", holder: "local", connectionRef: "mcp:fake", boundTo: ORIGIN });
  fake.log.length = 0;
  const [open] = await source.actions("mcp:fake", ctxOf(fake, { url: URL_ }, { credential: undefined }), ["add"]);
  assert.deepEqual(open.custody, { kind: "none" });
  assert.ok(fake.log.every((entry) => entry.headers.authorization === undefined));
});

test("the version is stable for one snapshot (whatever order it is listed in) and moves when a tool changes", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  const first = (await source.actions("mcp:fake", ctxOf(fake)))[0].version;
  assert.equal((await source.actions("mcp:fake", ctxOf(fake)))[0].version, first, "listed again, the same");
  fake.tools = Object.fromEntries(Object.entries(fake.tools).reverse());
  fake.pageSize = 1;
  assert.equal((await source.actions("mcp:fake", ctxOf(fake)))[0].version, first, "listed in another order and other pages, the same");
  fake.tools.add = { ...fake.tools.add, description: "Add two numbers, now with rounding." };
  const changed = (await source.actions("mcp:fake", ctxOf(fake)))[0].version;
  assert.notEqual(changed, first, "a changed description moves it");
  delete fake.tools.write_line;
  assert.notEqual((await source.actions("mcp:fake", ctxOf(fake)))[0].version, changed, "a removed tool moves it");
});

test("the snapshot version matches the vector serve's registry computes", () => {
  const tools = [
    { name: "b", inputSchema: { type: "object", properties: { x: { type: "string" } } }, annotations: { readOnlyHint: true } },
    { name: "a", title: "A", description: "The first.", inputSchema: { type: "object" } },
  ];
  assert.equal(snapshotVersion(tools), VECTOR);
  assert.equal(snapshotVersion([...tools].reverse()), VECTOR);
});
// The same vector is in serve's test/mcp-save-pin.test.mjs: the two copies of the rule give one answer.
const VECTOR = "sha256:8828911138affb8490da4ded4bddb2e72379655d739a4beec6e4ea0676b327df";

test("a listing past the probe's bounds stops, in words", async () => {
  const many = Object.fromEntries(Array.from({ length: MAX_TOOLS + 1 }, (_, i) => [`t${i}`, { inputSchema: { type: "object" }, run: () => ({ content: [] }) }]));
  const fake = fakeMcpNetwork({ tools: many, pageSize: 100 });
  await assert.rejects(mcpSource().actions("mcp:fake", ctxOf(fake)), (error) => error.code === "invalid" && /more than 500 tools/.test(error.message));
});

test("a call sends the credential to the bound origin alone and answers the tool's text, charged at the owner's price", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  const priced = { ...bearer, "price.add": "0.25" };
  const spec = await specOf(source, fake, "add", priced);
  fake.log.length = 0;
  const outcome = await source.call(spec, { a: 2, b: 3 }, callCtxOf(fake, priced));
  assert.deepEqual(outcome, { text: "5", isError: false, chargedUsd: 0.25 });
  assert.ok(fake.log.length > 0 && fake.log.every((entry) => entry.origin === ORIGIN && entry.headers.authorization === `Bearer ${SECRET}` && entry.redirect === "manual"));
  assert.ok(!fake.methods().includes("tools/list"), "a call does not list");
  // Unpriced: nothing charged, chargedUsd absent.
  const unpriced = await source.call(await specOf(source, fake, "write_line"), { line: "x" }, callCtxOf(fake));
  assert.deepEqual(unpriced, { text: "wrote x", isError: false });
});

test("credentials only to boundTo: a server moved since its action was pinned is sent nothing at all", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  const spec = await specOf(source, fake, "add");
  fake.log.length = 0;
  const outcome = await source.call(spec, { a: 1, b: 1 }, callCtxOf(fake, { ...bearer, url: `${ELSEWHERE}/mcp` }));
  assert.equal(outcome.refusal, "blocked_address");
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /address changed since this action was pinned/);
  assert.equal(fake.log.length, 0, "nothing sent anywhere");
  assert.equal(outcome.chargedUsd, undefined);
});

test("never through a redirect: a 3xx sends nothing further, and the token in its URL is never shown", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  const spec = await specOf(source, fake, "add");
  fake.log.length = 0;
  fake.fault["tools/call"] = { status: 307, location: (headers) => `${ELSEWHERE}/steal?token=${encodeURIComponent(headers.authorization)}&raw=${SECRET}` };
  const outcome = await source.call(spec, { a: 1, b: 1 }, callCtxOf(fake));
  assert.equal(outcome.refusal, "upstream_error");
  assert.match(outcome.text, /redirect \(HTTP 307\) to https:\/\/elsewhere\.example\.test, which is never followed/);
  assert.ok(!leaks(outcome.text), outcome.text);
  assert.ok(fake.log.every((entry) => entry.origin === ORIGIN), "nothing reached the redirect's target");
  // A redirect on the handshake: the same.
  fake.log.length = 0;
  fake.fault = { "server/discover": { status: 302, location: `${ELSEWHERE}/?key=${SECRET}` } };
  const early = await source.call(spec, { a: 1, b: 1 }, callCtxOf(fake));
  assert.equal(early.refusal, "upstream_error");
  assert.ok(!leaks(early.text));
  assert.deepEqual(fake.methods(), ["server/discover"], "nothing after the redirect");
});

test("never echoed: a credential the server sends back in a result, structured content, an error or a body is cut", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  fake.tools.echo = {
    inputSchema: { type: "object" },
    run: (_args, headers) => ({ content: [{ type: "text", text: `you sent ${headers.authorization} (token ${SECRET})` }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }),
  };
  fake.tools.structured = { inputSchema: { type: "object" }, run: (_args, headers) => ({ content: [], structuredContent: { echoed: headers.authorization } }) };
  const ctx = callCtxOf(fake);
  const echo = await source.call(await specOf(source, fake, "echo"), {}, ctx);
  assert.equal(echo.isError, false);
  assert.ok(!leaks(echo.text), echo.text);
  assert.match(echo.text, /you sent \[redacted\] \(token \[redacted\]\)/);
  assert.deepEqual(echo.images, [{ mime: "image/png", data: "aGVsbG8=" }]);
  const structured = await source.call(await specOf(source, fake, "structured"), {}, ctx);
  assert.ok(!leaks(structured.text), structured.text);
  // A JSON-RPC error that quotes it.
  fake.fault["tools/call"] = { rpcError: (headers) => `bad credential ${headers.authorization}` };
  const errored = await source.call(await specOf(source, fake, "add"), { a: 1, b: 1 }, ctx);
  assert.equal(errored.isError, true);
  assert.ok(!leaks(errored.text), errored.text);
  // An HTTP failure whose body and headers quote it.
  fake.fault["tools/call"] = { status: 500, body: (headers) => JSON.stringify({ error: `upstream said ${headers.authorization}` }), headers: (headers) => ({ "x-echo": headers.authorization }) };
  const failed = await source.call(await specOf(source, fake, "add"), { a: 1, b: 1 }, ctx);
  assert.equal(failed.refusal, "upstream_error");
  assert.ok(!leaks(failed.text), failed.text);
  // A value only the credential knows (a refresh token never sent) is cut by its own scrub.
  delete fake.fault["tools/call"];
  fake.tools.echo.run = () => ({ content: [{ type: "text", text: "the refresh token is rt-0123456789-secret" }] });
  const own = await source.call(await specOf(source, fake, "echo"), {}, { ...ctx, credential: credentialOf({ authorization: SECRET }, { scrub: (text) => text.split("rt-0123456789-secret").join("[redacted]") }) });
  assert.equal(own.text, "the refresh token is [redacted]");
});

test("a long answer is clipped at resultMaxChars and filed whole, scrubbed", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  fake.tools.long = { inputSchema: { type: "object" }, run: (_args, headers) => ({ content: [{ type: "text", text: `${headers.authorization} ${"x".repeat(MCP_CLIP + 10)}` }] }) };
  const ctx = callCtxOf(fake);
  const outcome = await source.call(await specOf(source, fake, "long"), {}, ctx);
  assert.match(outcome.text, /\[cut at 60000 of \d+ characters; the whole answer is in the run's files at evidence\/mcp\/fake\/long-/);
  assert.equal(ctx.filed.length, 1);
  assert.ok(!leaks(ctx.filed[0].body) && !leaks(outcome.text));
});

for (const [status, auth, code] of [[401, "bearer", "key_refused"], [403, "headers", "key_refused"], [401, "oauth", "connection_expired"], [402, "bearer", "quota_exhausted"], [429, "bearer", "rate_limited"], [500, "bearer", "upstream_error"], [503, "bearer", "upstream_error"]]) {
  test(`fault mapping: HTTP ${status} on a ${auth} server is ${code}`, async () => {
    const fake = fakeMcpNetwork();
    const source = mcpSource();
    const settings = auth === "headers" ? { url: URL_, auth, headers: "x-api-key" } : { url: URL_, auth };
    const ctx = callCtxOf(fake, settings, { credential: credentialOf({ authorization: SECRET, "x-api-key": SECRET }) });
    const spec = await specOf(source, fake, "add", settings);
    fake.fault["tools/call"] = { status };
    const outcome = await source.call(spec, { a: 1, b: 1 }, ctx);
    assert.equal(outcome.refusal, code, outcome.text);
    assert.equal(outcome.isError, true);
    assert.ok(outcome.text.length > 0 && !leaks(outcome.text));
    // Refused from the handshake on: the same code, and no tools/call left.
    fake.fault = { "*": { status } };
    fake.log.length = 0;
    const early = await source.call(spec, { a: 1, b: 1 }, ctx);
    assert.equal(early.refusal, code, early.text);
    assert.ok(!fake.methods().includes("tools/call"));
  });
}

test("fault mapping: a hang past the call's deadline is timeout", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource({ bounds: { callMs: 200 } });
  const spec = await specOf(source, fake, "add");
  fake.fault["tools/call"] = { hang: true };
  const started = performance.now();
  const outcome = await source.call(spec, { a: 1, b: 1 }, callCtxOf(fake));
  assert.equal(outcome.refusal, "timeout", outcome.text);
  assert.ok(performance.now() - started < 2_000);
});

test("fault mapping: an abort is stopped, answered within 250 ms of it", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  const priced = { ...bearer, "price.add": "1.5" };
  const spec = await specOf(source, fake, "add", priced);
  fake.fault["tools/call"] = { hang: true };
  const stop = new AbortController();
  const pending = source.call(spec, { a: 1, b: 1 }, callCtxOf(fake, priced, { signal: stop.signal }));
  // Aborted once the call is out.
  while (!fake.methods().includes("tools/call")) await new Promise((resolve) => setTimeout(resolve, 5));
  const at = performance.now();
  stop.abort();
  const outcome = await pending;
  const took = performance.now() - at;
  assert.equal(outcome.refusal, "stopped");
  assert.ok(took < 250, `answered ${took.toFixed(1)} ms after the abort`);
  assert.equal(outcome.chargedUsd, 1.5, "the call left, so the owner's price stands");
  // Aborted before anything left: stopped, nothing sent, nothing charged.
  fake.log.length = 0;
  const before = new AbortController();
  before.abort();
  const unsent = await source.call(spec, { a: 1, b: 1 }, callCtxOf(fake, priced, { signal: before.signal }));
  assert.equal(unsent.refusal, "stopped");
  assert.equal(unsent.chargedUsd, undefined);
  assert.ok(!fake.methods().includes("tools/call"));
});

test("fault mapping: an address the kernel's fetch refuses is blocked_address, nothing sent", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  const priced = { ...bearer, "price.add": "0.5" };
  const spec = await specOf(source, fake, "add", priced);
  const refusing = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("address refused"), { code: "blocked_address" }) }); };
  const outcome = await source.call(spec, { a: 1, b: 1 }, callCtxOf(fake, priced, { fetch: refusing }));
  assert.equal(outcome.refusal, "blocked_address", outcome.text);
  assert.equal(outcome.chargedUsd, undefined);
});

test("a credential missing where the server needs one sends nothing", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  const spec = await specOf(source, fake, "add");
  fake.log.length = 0;
  assert.equal((await source.call(spec, { a: 1, b: 1 }, callCtxOf(fake, bearer, { credential: undefined }))).refusal, "key_refused");
  assert.equal((await source.call(spec, { a: 1, b: 1 }, callCtxOf(fake, { url: URL_, auth: "oauth" }, { credential: undefined }))).refusal, "needs_connection");
  assert.equal(fake.log.length, 0);
});

test("call never throws: an id that is not an MCP action, or settings that do not read, are refusals", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  const spec = await specOf(source, fake, "add");
  assert.equal((await source.call({ ...spec, id: "monid:x/y" }, {}, callCtxOf(fake))).refusal, "unsupported");
  assert.equal((await source.call(spec, {}, callCtxOf(fake, { url: "not a url" }))).isError, true);
  assert.equal((await source.call(spec, {}, callCtxOf(fake, { url: "http://example.test/mcp" }))).isError, true, "plain http off loopback");
});

test("check() makes the handshake alone, never tools/list or tools/call, and says a refused credential", async () => {
  const fake = fakeMcpNetwork();
  const source = mcpSource();
  assert.equal((await source.check(ctxOf(fake))).state, "ok");
  assert.deepEqual([...new Set(fake.methods().filter(Boolean))], ["server/discover"]);
  fake.fault["*"] = { status: 401 };
  const refused = await source.check(ctxOf(fake));
  assert.equal(refused.state, "refused");
  assert.ok(!leaks(refused.words));
  assert.ok(!fake.methods().includes("tools/call") && !fake.methods().includes("tools/list"));
});

test("every unsupported cap refuses in words, and the source offers none of their methods", () => {
  const source = mcpSource();
  for (const cap of ["connect", "quote", "recover", "triggers", "search"]) {
    const value = source.caps[cap];
    assert.equal(typeof value.unsupported, "string", cap);
    assert.ok(value.unsupported.length > 20, `${cap} says why`);
  }
  assert.equal(source.connect, undefined);
  assert.equal(source.quote, undefined);
  assert.equal(source.recover, undefined);
  assert.equal(source.search, undefined);
  assert.equal(source.triggers, undefined);
  assert.equal(source.id, "mcp");
  assert.ok(source.settings.fields.every((field) => field.secret === false), "no secret is a setting: a credential is the kernel's");
});

test("toolkits names the one server its settings describe", async () => {
  const source = mcpSource();
  const fake = fakeMcpNetwork();
  assert.deepEqual(await source.toolkits(ctxOf(fake, { url: URL_, auth: "oauth", name: "fake" })), [{ id: "mcp:fake", label: "fake", actions: "unknown", needsConnection: true }]);
  assert.deepEqual(await source.toolkits(ctxOf(fake, { url: URL_ })), []);
  assert.equal(fake.log.length, 0, "no request");
  assert.ok(baseTools().add);
});
