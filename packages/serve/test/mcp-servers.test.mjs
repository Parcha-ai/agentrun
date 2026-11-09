// Remote MCP servers through /v2/settings/mcp-servers: preview one (connect, agree a protocol revision, list its tools,
// store nothing), save it with its credential sealed under the launcher's seal key, read it back without the
// credential, refresh its tools, and forget it. The servers are the fake on loopback (fixtures/fake-mcp-server.mjs),
// a plain web page, a closed port and a redirect.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { client, FAUX, scratch, serve, storeBytes, withEnv } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const TOOLS = ["add", "slow_write", "delete_thing", "paid"];
const sealKey = () => randomBytes(32).toString("base64");
/** A throwaway value: none is a real token. */
const made = () => `not-a-secret-${randomBytes(12).toString("hex")}`;
const formsOf = (value) => [value, ...["base64", "base64url", "hex"].map((code) => Buffer.from(value).toString(code))];
const holdsNone = (text, value, where) => { for (const form of formsOf(value)) assert.ok(!String(text).includes(form), `${where} holds the token`); };

async function fake(t, options) {
  const server = await startFakeMcp(options);
  t.after(() => server.close());
  return server;
}
/** A loopback HTTP server answering every request with `answer(req, res)`. */
async function plain(t, answer) {
  const server = createServer(answer);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
/** A server on `data` that a test closes before starting another on it, and that is closed after the test whatever
 *  happens. */
async function started(t, data) {
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  let closed;
  const close = () => (closed ??= server.close());
  t.after(close);
  return { api: client(server.baseUrl, server.token), close };
}
/** A 2025-era MCP server answering tools/list in `pages` pages of `perPage` tools, each with `bytes` of description;
 *  `asked` counts the pages requested. */
async function paged(t, { pages, perPage, bytes = 10 }) {
  const asked = { pages: 0 };
  const url = await plain(t, async (req, res) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) return void res.writeHead(202).end();
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
    if (message.method === "initialize") return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "big", version: "1" } });
    if (message.method === "tools/list") {
      asked.pages++;
      const page = Number(message.params?.cursor ?? 0);
      const tools = Array.from({ length: perPage }, (_, i) => ({ name: `t${page}_${i}`, description: "x".repeat(bytes), inputSchema: { type: "object" } }));
      return reply({ tools, ...(page + 1 < pages ? { nextCursor: String(page + 1) } : {}) });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
  });
  return { url: `${url}/mcp`, asked };
}
/** A loopback port nothing listens on: privileged, so no test process can bind it, and outside fetch's blocked ports.
 *  A port a test frees and then calls can be taken meanwhile by another file's fake, which then logs that call. */
const CLOSED_PORT = 2;

test("preview agrees the protocol with a 2026-07-28 server and with a 2025 one, lists every tool, and stores nothing", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api, data } = await serve(t);
  const modern = await fake(t);
  const legacy = await fake(t, { era: "legacy" });
  const now = await api("POST", "/settings/mcp-servers/preview", { url: modern.url, auth: { type: "none" } });
  assert.equal(now.status, 200, JSON.stringify(now.body));
  assert.equal(now.body.protocol, "2026-07-28");
  assert.deepEqual(now.body.server_info, { name: "fake-mcp", version: "1.0.0" });
  assert.deepEqual(now.body.tools.map((tool) => tool.name), TOOLS);
  const add = now.body.tools.find((tool) => tool.name === "add");
  assert.equal(add.description, "Add two numbers.");
  assert.equal(add.title, "Add");
  assert.deepEqual(add.input_schema.required, ["a", "b"]);
  assert.deepEqual(add.annotations, { readOnlyHint: true });
  const old = await api("POST", "/settings/mcp-servers/preview", { url: legacy.url });
  assert.equal(old.status, 200, JSON.stringify(old.body));
  assert.equal(old.body.protocol, "2025-11-25");
  assert.deepEqual(old.body.tools.map((tool) => tool.name), TOOLS);
  assert.ok(legacy.log.some((entry) => entry.method === "initialize"), "the 2025 server was met with initialize");
  assert.ok(!existsSync(join(data, "mcp-servers.json")), "a preview stores nothing");
  assert.deepEqual((await api("GET", "/settings/mcp-servers")).body, { servers: [] });
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.features.mcp_client, { transports: ["streamable-http"], auth: ["none", "bearer", "headers", "oauth", "github_app"], at_rest: "sealed", harnesses: ["pi", "claude-agent", "codex"] });
});

test("preview tells a server that wants a credential (bearer or OAuth), one that is not MCP, one that is down, and one that redirects apart", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api } = await serve(t);
  const token = made();
  const guarded = await fake(t, { token });
  const signIn = await fake(t, { token, oauth: true });
  const preview = (url, auth) => api("POST", "/settings/mcp-servers/preview", { url, ...(auth ? { auth } : {}) });

  const bare = await preview(guarded.url);
  assert.equal(bare.status, 422, JSON.stringify(bare.body));
  assert.equal(bare.body.error.code, "auth_required");
  assert.equal(bare.body.error.details.auth, "bearer");
  const wrong = await preview(guarded.url, { type: "bearer", token: made() });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.error.code, "auth_required", "a refused token is a credential to enter again");
  const right = await preview(guarded.url, { type: "bearer", token });
  assert.equal(right.status, 200, JSON.stringify(right.body));
  holdsNone(JSON.stringify([bare.body, wrong.body, right.body]), token, "a preview's answer");
  const headers = await preview(guarded.url, { type: "headers", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(headers.status, 200, "named headers carry a credential too");

  const oauth = await preview(signIn.url);
  assert.equal(oauth.status, 422);
  assert.equal(oauth.body.error.code, "auth_required");
  assert.equal(oauth.body.error.details.auth, "oauth", "a server that names protected-resource metadata wants OAuth");

  const page = await plain(t, (req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>Hello</body></html>"); });
  const notMcp = await preview(`${page}/`);
  assert.equal(notMcp.status, 422, JSON.stringify(notMcp.body));
  assert.equal(notMcp.body.error.code, "not_mcp");
  const api404 = await plain(t, (req, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"no such route"}'); });
  assert.equal((await preview(`${api404}/mcp`)).body.error.code, "not_mcp");

  const down = await preview(`http://127.0.0.1:${CLOSED_PORT}/mcp`);
  assert.equal(down.status, 424, JSON.stringify(down.body));
  assert.equal(down.body.error.code, "upstream_failed");
  const failing = await plain(t, (req, res) => { res.writeHead(502); res.end("bad gateway"); });
  const broke = await preview(`${failing}/mcp`);
  assert.equal(broke.status, 424);
  assert.equal(broke.body.error.code, "upstream_failed");

  const target = await fake(t);
  const hop = await plain(t, (req, res) => { res.writeHead(307, { location: target.url }); res.end(); });
  const redirected = await preview(`${hop}/mcp`, { type: "bearer", token });
  assert.equal(redirected.status, 422, JSON.stringify(redirected.body));
  assert.equal(redirected.body.error.fields[0].field, "url");
  assert.equal(redirected.body.error.fields[0].reason, "redirect");
  assert.deepEqual(target.log, [], "a redirect is never followed, so the credential never goes where it points");
  const garbled = await plain(t, (req, res) => { res.writeHead(302, { location: `http://[not-a-host/${"p".repeat(300)}` }); res.end(); });
  const unparsed = await preview(`${garbled}/mcp`);
  assert.equal(unparsed.status, 422, JSON.stringify(unparsed.body));
  assert.deepEqual([unparsed.body.error.fields[0].field, unparsed.body.error.fields[0].reason], ["url", "redirect"]);
  assert.match(unparsed.body.error.fields[0].message, /http:\/\/\[not-a-host\/p+/, "names where it points, as sent");
  assert.ok(!unparsed.body.error.fields[0].message.includes("p".repeat(201)), "cut to 200 characters");
  const leakyHop = await plain(t, (req, res) => { res.writeHead(302, { location: `https://elsewhere.example/mcp?token=${token}` }); res.end(); });
  const leakyRedirect = await preview(`${leakyHop}/mcp`, { type: "bearer", token });
  assert.equal(leakyRedirect.body.error.fields[0].reason, "redirect");
  holdsNone(JSON.stringify(leakyRedirect.body), token, "a redirect's refusal");
  assert.match(leakyRedirect.body.error.fields[0].message, /token=\[credential\]/, "where it points is named, the token cut");
  // A server that speaks JSON-RPC but fails every request, echoing the bare token in its error.
  const echo = await plain(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const id = JSON.parse(body || "{}").id ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: `token ${token} is not allowed here` } }));
  });
  const echoed = await preview(`${echo}/mcp`, { type: "bearer", token });
  assert.equal(echoed.status, 424, JSON.stringify(echoed.body));
  holdsNone(JSON.stringify(echoed.body), token, "an upstream failure's message");
  assert.match(echoed.body.error.message, /\[credential\]/, "the server's words are kept, the token cut");
});

test("PUT seals the credential: reads say `sealed` and never hold it, nor does the file; a PUT without one keeps it; refresh says what was added, removed and changed; DELETE forgets", async (t) => {
  const umask = process.umask(0o022);
  t.after(() => process.umask(umask));
  const key = sealKey();
  withEnv(t, { AGENTRUN_SEAL_KEY: key });
  const { api, data } = await serve(t);
  const token = made();
  const server = await fake(t, { token });

  const saved = await api("PUT", "/settings/mcp-servers/fake", { url: server.url, auth: { type: "bearer", token } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.name, "fake");
  assert.equal(saved.body.credential, "sealed");
  assert.deepEqual(saved.body.auth, { type: "bearer" });
  assert.equal(saved.body.protocol, "2026-07-28");
  assert.deepEqual(saved.body.tools.map((tool) => tool.name), TOOLS);
  const one = await api("GET", "/settings/mcp-servers/fake");
  assert.equal(one.status, 200);
  assert.equal(one.body.credential, "sealed");
  const all = await api("GET", "/settings/mcp-servers");
  assert.deepEqual(all.body.servers.map((s) => [s.name, s.url, s.credential]), [["fake", server.url, "sealed"]]);
  holdsNone(JSON.stringify([saved.body, one.body, all.body]), token, "a read");

  // Sealed at rest: no store byte (the DB and its WAL/shm) holds the credential in the clear. How it is sealed in its row,
  // bound to its server and header, and told apart from another's is store-mcp-servers' (the store path).
  holdsNone(storeBytes(data), token, "the store");

  // Rotation without the credential: the sealed one is kept, and still reaches the server.
  const before = server.log.length;
  const kept = await api("PUT", "/settings/mcp-servers/fake", { url: server.url, auth: { type: "bearer" } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.credential, "sealed");
  assert.ok(server.log.slice(before).every((entry) => entry.authorization), "the kept credential was sent");
  const named = await api("POST", "/settings/mcp-servers/preview", { name: "fake" });
  assert.equal(named.status, 200, "a saved server previews with its sealed credential");

  server.tools.multiply = { ...server.tools.add, description: "Multiply two numbers.", run: ({ a, b }) => ({ content: [{ type: "text", text: String(a * b) }] }) };
  server.tools.add = { ...server.tools.add, description: "Add two numbers, exactly." };
  delete server.tools.paid;
  const refreshed = await api("POST", "/settings/mcp-servers/fake/refresh");
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.deepEqual([refreshed.body.added, refreshed.body.removed, refreshed.body.changed], [["multiply"], ["paid"], ["add"]]);
  assert.deepEqual(refreshed.body.server.tools.map((tool) => tool.name).sort(), ["add", "delete_thing", "multiply", "slow_write"]);
  assert.deepEqual((await api("GET", "/settings/mcp-servers/fake")).body.tools.map((tool) => tool.name).sort(), ["add", "delete_thing", "multiply", "slow_write"]);
  holdsNone(JSON.stringify(refreshed.body), token, "after a refresh");
  holdsNone(storeBytes(data), token, "the store after a refresh");

  for (const inherited of ["constructor", "tostring"]) {
    assert.equal((await api("GET", `/settings/mcp-servers/${inherited}`)).status, 404, `${inherited} is no saved server`);
    assert.equal((await api("DELETE", `/settings/mcp-servers/${inherited}`)).status, 404);
  }
  assert.equal((await api("DELETE", "/settings/mcp-servers/fake")).status, 204);
  assert.equal((await api("GET", "/settings/mcp-servers/fake")).status, 404);
  assert.equal((await api("DELETE", "/settings/mcp-servers/fake")).status, 404);
  assert.equal((await api("POST", "/settings/mcp-servers/fake/refresh")).status, 404);
});

test("what is refused before any connection: a bad name, OAuth (not yet), plain http off loopback; and a server handed no seal key keeps a credential under the one it made, reading one sealed under the other as unreadable", async (t) => {
  const data = join(await scratch(t), "agents");
  const token = made();
  const server = await fake(t, { token });
  const open = await fake(t);
  const key = sealKey();

  withEnv(t, { AGENTRUN_SEAL_KEY: key });
  const first = await started(t, data);
  const api1 = first.api;
  assert.equal((await api1("PUT", "/settings/mcp-servers/guarded", { url: server.url, auth: { type: "bearer", token } })).status, 200);
  for (const name of ["Fake", "my_server", "1st", "a".repeat(33), "-x"]) {
    const bad = await api1("PUT", `/settings/mcp-servers/${name}`, { url: open.url });
    assert.equal(bad.status, 422, name);
    assert.equal(bad.body.error.fields[0].field, "name", name);
  }
  const oauth = await api1("PUT", "/settings/mcp-servers/signin", { url: open.url, auth: { type: "oauth" } });
  assert.equal(oauth.status, 422);
  assert.deepEqual([oauth.body.error.fields[0].field, oauth.body.error.fields[0].reason], ["auth.type", "missing"], "an OAuth server is signed in to first (mcp-oauth.test.mjs)");
  const cleartext = await api1("POST", "/settings/mcp-servers/preview", { url: "http://mcp.example.com/mcp" });
  assert.equal(cleartext.status, 422);
  assert.deepEqual([cleartext.body.error.fields[0].field, cleartext.body.error.fields[0].reason], ["url", "not_https"]);
  assert.equal(cleartext.body.error.fields[0].message, "url is http://mcp.example.com, which is not this machine's loopback: use https, or http only on loopback.");
  const typeless = await api1("PUT", "/settings/mcp-servers/other", { url: server.url, auth: { type: "bearer" } });
  assert.equal(typeless.status, 422, "a new server's bearer comes with its token");
  await first.close();

  // Handed no seal key, the server makes its own (seal-key.ts): a credential sealed under the first does not open under
  // it, and a new one is sealed under it.
  delete process.env.AGENTRUN_SEAL_KEY;
  const { api } = await serve(t, { data });
  assert.equal((await api("PUT", "/settings/mcp-servers/again", { url: server.url, auth: { type: "bearer", token } })).status, 200, "kept under the key the server made");
  assert.equal((await api("PUT", "/settings/mcp-servers/open", { url: open.url })).status, 200);
  const listed = (await api("GET", "/settings/mcp-servers")).body.servers;
  assert.deepEqual(listed.map((s) => [s.name, s.credential]), [["again", "sealed"], ["guarded", "unreadable"], ["open", null]]);
  assert.equal((await api("GET", "/capabilities")).body.features.mcp_client.at_rest, "sealed");
});

test("a saved credential sealed under another key reads as unreadable, and a PUT must send it again", async (t) => {
  const data = join(await scratch(t), "agents");
  const token = made();
  const server = await fake(t, { token });
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const first = await started(t, data);
  assert.equal((await first.api("PUT", "/settings/mcp-servers/fake", { url: server.url, auth: { type: "bearer", token } })).status, 200);
  await first.close();
  process.env.AGENTRUN_SEAL_KEY = sealKey();
  const { api } = await serve(t, { data });
  assert.equal((await api("GET", "/settings/mcp-servers/fake")).body.credential, "unreadable");
  const again = await api("PUT", "/settings/mcp-servers/fake", { url: server.url, auth: { type: "bearer" } });
  assert.equal(again.status, 422, JSON.stringify(again.body));
  assert.equal(again.body.error.fields[0].field, "auth.token");
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: server.url, auth: { type: "bearer", token } })).body.credential, "sealed");
});

test("a server's tool snapshot is capped at 500 tools and 1 MiB: past either, 422 in plain words, the listing stops early, and nothing is kept", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api, data } = await serve(t);
  const many = await paged(t, { pages: 10, perPage: 100 });
  const tooMany = await api("PUT", "/settings/mcp-servers/many", { url: many.url });
  assert.equal(tooMany.status, 422, JSON.stringify(tooMany.body));
  assert.equal(tooMany.body.error.fields[0].reason, "too_many_tools");
  assert.match(tooMany.body.error.message, /more than 500 tools/);
  assert.ok(many.asked.pages < 10, `stopped after ${many.asked.pages} of 10 pages`);
  const big = await paged(t, { pages: 6, perPage: 3, bytes: 100_000 });
  const tooBig = await api("POST", "/settings/mcp-servers/preview", { url: big.url });
  assert.equal(tooBig.status, 422, JSON.stringify(tooBig.body).slice(0, 500));
  assert.equal(tooBig.body.error.fields[0].reason, "tools_too_large");
  assert.match(tooBig.body.error.message, /more than 1 MiB/);
  assert.ok(big.asked.pages < 6, `stopped after ${big.asked.pages} of 6 pages`);
  const fits = await paged(t, { pages: 5, perPage: 100 });
  const kept = await api("PUT", "/settings/mcp-servers/fits", { url: fits.url });
  assert.equal(kept.status, 200, "500 tools across pages fit");
  assert.equal(kept.body.tools.length, 500);
  assert.deepEqual((await api("GET", "/settings/mcp-servers")).body.servers.map((s) => s.name), ["fits"], "neither refused server was kept");
});

test("names an empty object would inherit are no saved servers: 404 on every route, and no file is written", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() });
  const { api, data } = await serve(t);
  for (const name of ["constructor", "tostring"]) {
    assert.equal((await api("GET", `/settings/mcp-servers/${name}`)).status, 404, `GET ${name}`);
    assert.equal((await api("DELETE", `/settings/mcp-servers/${name}`)).status, 404, `DELETE ${name}`);
    assert.equal((await api("POST", `/settings/mcp-servers/${name}/refresh`)).status, 404, `refresh ${name}`);
    assert.equal((await api("POST", "/settings/mcp-servers/preview", { name })).status, 404, `preview ${name}`);
  }
  assert.ok(!existsSync(join(data, "mcp-servers.json")), "nothing was written");
  const headers = await api("POST", "/settings/mcp-servers/preview", { url: (await fake(t)).url, auth: { type: "headers", headers: { constructor: "a-value" } } });
  assert.equal(headers.status, 200, `a header named constructor is no duplicate: ${JSON.stringify(headers.body)}`);
});

test("the launcher's warning for a seal key it cannot use names MCP server credentials, and how to fix the file", (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-seal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = join(dir, "config", "agentrun");
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  writeFileSync(join(keys, "seal.key"), `${randomBytes(32).toString("base64")}\n`);
  chmodSync(join(keys, "seal.key"), 0o644); // another user can read it: refused, never changed
  const { AGENTRUN_SEAL_KEY: _, ...env } = process.env;
  const ran = spawnSync(new URL("../launcher/agentrun-serve", import.meta.url).pathname, ["--", process.execPath, "-e", ""], { encoding: "utf8", env: { ...env, XDG_CONFIG_HOME: join(dir, "config"), TMPDIR: dir } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /so the server keeps no tool key and no MCP server credential: make the file 0600 and its directory 0700 \(chmod 700 \S+; chmod 600 \S+seal\.key\)/);
});

test("the names AgentRun's own tools are called by, hands and monid, are no MCP server's: a PUT under one is 422 on its name, with why, and nothing is saved", async (t) => {
  const { api } = await serve(t);
  const server = await fake(t, {});
  for (const name of ["hands", "monid"]) {
    const refused = await api("PUT", `/settings/mcp-servers/${name}`, { url: server.url, auth: { type: "none" } });
    assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.fields?.map((f) => [f.field, f.reason])], [422, "input_invalid", [["name", "reserved"]]], `${name}: ${JSON.stringify(refused.body)}`);
    assert.match(refused.body.error.fields[0].message, new RegExp(`'${name}' is reserved for AgentRun's own tools`));
    assert.equal((await api("GET", `/settings/mcp-servers/${name}`)).status, 404, `${name}: nothing saved`);
  }
});
