import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { listServer, boundTool } from "../dist/mcp-probe.js";
import { mcpGateway, mcpPinOf } from "../dist/mcp-gateway.js";
import { resourceTools, RESOURCE_LIST_MAX, RESOURCE_LIST_BYTES } from "../dist/mcp-resources.js";
import { pinView } from "../dist/agents-store.js";

const url = new URL("https://mcp.example/mcp");
const token = "fake-test-key";
const names = ["agentrun_list_resources", "agentrun_list_resource_templates", "agentrun_read_resource"];
const text = (answer) => answer.content.map(block => block.text ?? "").join("\n");
function upstream({ resources = true, tools = [], answer } = {}) {
  const calls = [];
  const send = async (_input, init) => {
    if (init.method !== "POST") return new Response(null, { status: init.method === "DELETE" ? 200 : 405 });
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { ...(resources ? { resources: {} } : {}), ...(tools.length ? { tools: {} } : {}) }, serverInfo: { name: "fixture", version: "1" } };
    else if (body.method === "tools/list") result = { tools };
    else result = await answer?.(body, init);
    return Response.json(result === undefined ? { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unsupported method" } } : { jsonrpc: "2.0", id: body.id, result });
  };
  return { calls, send };
}
async function setup(t, options = {}) {
  const fake = upstream(options);
  const listed = await listServer(url, { authorization: `Bearer ${token}` }, "test", undefined, fake.send);
  const work = await mkdtemp(join(tmpdir(), "mcp-resources-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const pin = mcpPinOf(listed.tools.map(tool => `mcp:fixture/${tool.name}`), { server: () => ({ url: url.href, tools: listed.tools.map(boundTool) }) });
  const credentials = { fixture: { url: url.href, headers: { authorization: `Bearer ${token}` } } };
  const gateway = mcpGateway({ pin, credentials, fetch: fake.send, work: () => work, bounds: { callMs: 1000 } });
  return { ...fake, listed, pin, credentials, gateway, work };
}

test("a resource-only MCP server is represented by pinned resource operations, without inventing upstream tools", async t => {
  const f = await setup(t);
  assert.deepEqual(f.listed.tools.map(tool => tool.name), names);
  assert.deepEqual(f.listed.tools.map(tool => tool.resource), ["list", "templates", "read"]);
  assert.deepEqual(f.pin.fixture.tools.map(tool => tool.resource), ["list", "templates", "read"]);
  assert.ok(f.pin.fixture.tools.every(tool => tool.annotations.readOnlyHint === true));
  assert.deepEqual(pinView(f.pin).fixture.tools.map(tool => tool.resource), ["list", "templates", "read"], "the public revision pin preserves operation identity");
  assert.equal(f.calls.some(call => call.method === "tools/list"), false);
});

test("resource listings include every page, and a resource URI is sent only as an argument to the pinned MCP endpoint", async t => {
  const f = await setup(t, { answer: body => {
    if (body.method === "resources/list") return body.params?.cursor === "second" ? { resources: [{ uri: "fixture:two", name: "Two" }] } : { resources: [{ uri: "fixture:one", name: "One" }], nextCursor: "second" };
    if (body.method === "resources/templates/list") return { resourceTemplates: [{ uriTemplate: "fixture:item/{id}", name: "Item" }] };
    if (body.method === "resources/read") return { contents: [{ uri: body.params.uri, mimeType: "text/plain", text: `Resource body; ${token}` }] };
  } });
  const call = (name, args = {}) => f.gateway.call("fixture", name, args, { signal: AbortSignal.timeout(2000) });
  assert.deepEqual(JSON.parse(text(await call(names[0]))).resources.map(resource => resource.uri), ["fixture:one", "fixture:two"]);
  assert.equal(JSON.parse(text(await call(names[1]))).resourceTemplates[0].uriTemplate, "fixture:item/{id}");
  const result = text(await call(names[2], { uri: "https://private.example/document" }));
  assert.match(result, /Resource body; \[redacted\]/);
  assert.ok(!result.includes(token));
  assert.deepEqual(f.calls.filter(call => call.method === "resources/read").map(call => call.params), [{ uri: "https://private.example/document" }]);
  assert.equal(f.calls.some(call => call.method === "tools/call"), false);
});

test("a resource cursor cycle is an observable failure, never a silently incomplete listing", async t => {
  const f = await setup(t, { answer: body => body.method === "resources/list" ? { resources: [], nextCursor: body.params?.cursor === "a" ? "b" : "a" } : undefined });
  const result = await f.gateway.call("fixture", names[0], {}, { signal: AbortSignal.timeout(2000) });
  assert.equal(result.isError, true);
  assert.match(text(result), /cursor|page/i);
  assert.equal(f.calls.filter(call => call.method === "resources/list").length, 3);
});

test("upstream tool names cannot impersonate generated resource operations, even on a server without resources", async () => {
  const fake = upstream({ resources: false, tools: [{ name: names[2], inputSchema: { type: "object" }, resource: "read" }] });
  await assert.rejects(listServer(url, {}, "test", undefined, fake.send), /reserved|resource operation/i);
});

test("ordinary upstream tool metadata cannot confer resource authority", async t => {
  const f = await setup(t, { resources: false, tools: [{ name: "ordinary", inputSchema: { type: "object" }, resource: "read" }], answer: body => body.method === "tools/call" ? { content: [{ type: "text", text: "ordinary tool" }] } : undefined });
  assert.equal(f.listed.tools[0].resource, undefined);
  assert.equal(text(await f.gateway.call("fixture", "ordinary", {}, { signal: AbortSignal.timeout(2000) })), "ordinary tool");
  assert.equal(f.calls.some(call => call.method === "resources/read"), false);
});

test("a changed destination account URL or missing resource grant sends no resource operation", async t => {
  const f = await setup(t);
  f.credentials.fixture.url = "https://other.example/mcp";
  const result = await f.gateway.call("fixture", names[2], { uri: "fixture:one" }, { signal: AbortSignal.timeout(2000) });
  assert.equal(result.isError, true);
  assert.match(text(result), /address changed/);
  assert.equal((await f.gateway.call("other", names[2], { uri: "fixture:one" }, { signal: AbortSignal.timeout(2000) })).isError, true);
  assert.equal(f.calls.some(call => call.method.startsWith("resources/")), false);
});

test("a stored resource marker with the wrong name, schema or effect cannot be pinned or dispatched", async t => {
  const f = await setup(t);
  const original = boundTool(resourceTools()[2]);
  for (const changed of [{ ...original, name: "ordinary" }, { ...original, resource: "delete" }, { ...original, inputSchema: { type: "object" } }, { ...original, annotations: { readOnlyHint: false } }]) {
    assert.throws(() => mcpPinOf([`mcp:fixture/${changed.name}`], { server: () => ({ url: url.href, tools: [changed] }) }), /resource/i);
    const gateway = mcpGateway({ pin: { fixture: { url: url.href, tools: [changed] } }, credentials: f.credentials, fetch: f.send, work: () => f.work });
    const answer = await gateway.call("fixture", changed.name, { uri: "fixture:one" }, { signal: AbortSignal.timeout(2000) });
    assert.equal(answer.isError, true);
  }
  assert.equal(f.calls.some(call => call.method.startsWith("resources/")), false);
});

test("resource operations reject malformed arguments before sending a resource request", async t => {
  const f = await setup(t);
  for (const [name, args] of [[names[0], { cursor: "untrusted" }], [names[2], {}], [names[2], { uri: "" }], [names[2], { uri: "bad\nuri" }], [names[2], { uri: "a".repeat(8193) }], [names[2], { uri: "fixture:one", extra: true }]]) {
    assert.equal((await f.gateway.call("fixture", name, args, { signal: AbortSignal.timeout(2000) })).isError, true);
  }
  assert.equal(f.calls.some(call => call.method.startsWith("resources/")), false);
});

test("resource pagination has aggregate item and byte limits and never returns a partial list", async t => {
  for (const tooLarge of [false, true]) {
    const f = await setup(t, { answer: body => body.method === "resources/list" ? { resources: tooLarge
      ? [{ uri: "fixture:large", name: "Large", description: "x".repeat(RESOURCE_LIST_BYTES) }]
      : Array.from({ length: RESOURCE_LIST_MAX + 1 }, (_, index) => ({ uri: `fixture:${index}`, name: String(index) })) } : undefined });
    const answer = await f.gateway.call("fixture", names[0], {}, { signal: AbortSignal.timeout(2000) });
    assert.equal(answer.isError, true);
    assert.match(text(answer), /limit|large/i);
    assert.doesNotMatch(text(answer), /fixture:/);
  }
});

test("cancelling resource pagination sends no later page", async t => {
  const stop = new AbortController();
  const f = await setup(t, { answer: body => {
    if (body.method !== "resources/list") return;
    stop.abort();
    return { resources: [{ uri: "fixture:one", name: "One" }], nextCursor: "later" };
  } });
  const answer = await f.gateway.call("fixture", names[0], {}, { signal: stop.signal });
  assert.equal(answer.isError, true);
  assert.match(text(answer), /stopped/);
  assert.equal(f.calls.filter(call => call.method === "resources/list").length, 1);
});

test("binary resource evidence is filed through the existing workspace and credential scrub", async t => {
  const f = await setup(t, { answer: body => body.method === "resources/read" ? { contents: [{ uri: `fixture:${token}`, mimeType: "application/octet-stream", blob: "YWJj" }] } : undefined });
  const answer = await f.gateway.call("fixture", names[2], { uri: "fixture:binary" }, { signal: AbortSignal.timeout(2000) });
  assert.equal(answer.isError, undefined);
  assert.match(text(answer), /whole answer is in the run's files/);
  const files = await readdir(join(f.work, "evidence/mcp/fixture"));
  assert.equal(files.length, 1);
  const saved = await readFile(join(f.work, "evidence/mcp/fixture", files[0]), "utf8");
  assert.ok(!saved.includes(token));
  assert.equal(JSON.parse(saved).content[0].resource.blob, "YWJj");
});

test("a credential encoded inside a binary resource is withheld before model-readable evidence is written", async t => {
  const encoded = Buffer.from(`binary-prefix:${token}:suffix`).toString("base64");
  const f = await setup(t, { answer: body => body.method === "resources/read" ? { contents: [{ uri: "fixture:binary", mimeType: "application/octet-stream", blob: encoded }] } : undefined });
  const answer = await f.gateway.call("fixture", names[2], { uri: "fixture:binary" }, { signal: AbortSignal.timeout(2000) });
  assert.equal(answer.isError, true);
  assert.match(text(answer), /credential.*withheld/i);
  assert.ok(!text(answer).includes(token) && !text(answer).includes(encoded));
  assert.deepEqual(await readdir(f.work), [], "no resource file written");
});
