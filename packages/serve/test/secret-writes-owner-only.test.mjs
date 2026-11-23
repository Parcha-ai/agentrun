// Only the owner's signed-in session drops or replaces a secret; the API token, which a run's process, an agent's MCP client
// or a script may hold, never does. Through the server, on the one gate in its dispatch (secret-writes.ts):
// - a save that would drop a saved MCP server's credential (auth none over a bearer) is refused to the token, and the
//   credential stays; the owner's session drops it; the token saves over no server it did not save, keeping its credential
//   or not;
// - a token's save let through over its own server never lands over the owner's save made while it listed, a credential or
//   none (412); and an owner's save refused (412) leaves the server the token's, its row and its record as they were;
// - removing an MCP server that holds a credential is refused to the token, and the server stays; the console removes it,
//   its request made as the page makes it (the session's cookie, same origin, JSON, no token); the token removes only a
//   server the token saved with none, and one the owner saved stays the owner's (mcp-composio-remove.test.mjs: even one the
//   owner saves over after the token's delete was let through);
// - a sign-in's start is refused to the token, with no state cookie handed back;
// - every operation on a secret's route (MCP servers, GitHub, sign-ins, tool keys, computers, the workspace, a trigger's
//   secret) is in the one gate's registry, or said on purpose to write none, with why;
// - every operation the gate can refuse to the token lists that 403 in the API document.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { call, clientOwnerSession, serve as serveOf, withEnv } from "./support.mjs";

const { openapiDocument } = await import("../dist/openapi.js");
const { mcpSourceKey } = await import("../dist/mcp-sources.js");
const gate = await import("../dist/secret-writes.js");
// The planes register their operations as their modules load: the server's own imports, as a started server has them.
await import("../dist/server.js");

const TOKEN = `not-a-secret-${"owner-only-bearer"}`;
const json = { "content-type": "application/json" };
const serve = (t) => (withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }), serveOf(t, { accounts: true, openSetup: true }));

/** The owner's session, as the console sends a request: its cookie, the server's own origin, JSON. */
async function asPage(server) {
  const { cookie, origin } = await clientOwnerSession(server);
  return (method, path, body) => call(server.port, { method, path: `/v2${path}`, headers: { ...json, cookie, origin }, ...(body !== undefined ? { body } : {}) });
}
/** The API token's request. */
const asToken = (server) => (method, path, body) => call(server.port, { method, path: `/v2${path}`, headers: { ...(body !== undefined ? json : {}), authorization: `Bearer ${server.token}` }, ...(body !== undefined ? { body } : {}) });

/** A server with an MCP server `fake` saved with a bearer, by the owner. The fake lists its tools to any request, so a
 *  save with no credential lists too: what is decided is who may drop the credential, not whether the server takes one. */
async function withSavedServer(t) {
  const server = await serve(t);
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const page = await asPage(server);
  const saved = await page("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(saved.status, 200, saved.text);
  return { server, fake, page, token: asToken(server) };
}
const savedAuth = async (read) => (await read("GET", "/settings/mcp-servers")).json?.servers?.find((one) => one.name === "fake");

test("a save that would drop a saved MCP server's credential is the owner's alone: the token is refused and the credential stays", async (t) => {
  const { fake, page, token } = await withSavedServer(t);
  const dropped = await token("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } });
  assert.equal(dropped.status, 403, dropped.text);
  assert.ok(String(dropped.json?.error?.message).startsWith(gate.SECRET_WRITE_REFUSAL));
  assert.equal((await savedAuth(page))?.auth?.type, "bearer", "the bearer is still saved");
  // A save that keeps it (the same auth type, no value) is refused too: the token saves over no server it did not save.
  const keep = await token("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer" } });
  assert.equal(keep.status, 403, keep.text);
  // The owner's session drops it.
  const drop = await page("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } });
  assert.equal(drop.status, 200, drop.text);
  assert.equal((await savedAuth(page))?.auth?.type, "none");
});

test("a token's save let through over its own server with no credential never lands over one the owner saved while it listed: it is refused 412, and the owner's credential stays", async (t) => {
  const server = await serve(t);
  // Once `holding`, a listing with no Authorization (the token's save of auth none) waits until released.
  let holding = false;
  let reached;
  const blocked = new Promise((resolve) => (reached = resolve));
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const seen = [];
  const fake = await startFakeMcp({ inspect: (headers) => seen.push(headers.authorization), hold: async (headers) => { if (holding && headers.authorization === undefined) (reached(), await released); } });
  t.after(() => (release(), fake.close()));
  const page = await asPage(server);
  const token = asToken(server);
  // Saved by the token with no credential: a token's save with none over a server the token saved is no secret write, so
  // the gate lets it through.
  assert.equal((await token("PUT", "/settings/mcp-servers/fake", { url: fake.url })).status, 200);
  holding = true;
  const late = token("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } });
  await blocked;
  // The owner saves a bearer while the token's save lists (the owner's listing carries the bearer: not held).
  const saved = await page("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(saved.status, 200, saved.text);
  release();
  const refused = await late;
  assert.equal(refused.status, 412, refused.text);
  assert.equal(refused.json?.error?.code, "precondition_failed");
  assert.equal((await savedAuth(page))?.auth?.type, "bearer", "the owner's credential stays");
  // A refresh lists with it: the token's save wrote nothing over it.
  seen.length = 0;
  const refreshed = await token("POST", "/settings/mcp-servers/fake/refresh");
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.ok(seen.includes(`Bearer ${TOKEN}`), "the bearer is what a refresh lists with");
});

test("a token's save let through over its own server never lands over the owner's save made while it listed, even one with no credential: it is refused 412, and the server stays where the owner saved it", async (t) => {
  const server = await serve(t);
  // Once `holding`, the token's listing (no Authorization, at `fake`) waits until released; the owner's is at `owners`.
  let holding = false;
  let reached;
  const blocked = new Promise((resolve) => (reached = resolve));
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const fake = await startFakeMcp({ hold: async () => { if (holding) (reached(), await released); } });
  const owners = await startFakeMcp();
  t.after(() => (release(), fake.close(), owners.close()));
  const page = await asPage(server);
  const token = asToken(server);
  assert.equal((await token("PUT", "/settings/mcp-servers/fake", { url: fake.url })).status, 200);
  holding = true;
  const late = token("PUT", "/settings/mcp-servers/fake", { url: fake.url });
  await blocked;
  // The owner saves the server elsewhere, with no credential either: its credential's mark is the token's row's, so only the
  // token's mark, dropped by the owner's save and compared in the token's write, tells the two apart.
  const saved = await page("PUT", "/settings/mcp-servers/fake", { url: owners.url, auth: { type: "none" } });
  assert.equal(saved.status, 200, saved.text);
  release();
  const refused = await late;
  assert.equal(refused.status, 412, refused.text);
  assert.equal(refused.json?.error?.code, "precondition_failed");
  // A read shows the address cut to its origin (shownUrl): the two fakes are told apart by their ports.
  const savedAt = async () => new URL(String((await savedAuth(page))?.url).replace("…", "")).origin;
  assert.equal(await savedAt(), new URL(owners.url).origin, "the owner's save stands");
  // And it stays the owner's: the token neither saves over it nor removes it.
  assert.equal((await token("PUT", "/settings/mcp-servers/fake", { url: fake.url })).status, 403);
  assert.equal((await token("DELETE", "/settings/mcp-servers/fake")).status, 403);
  assert.equal(await savedAt(), new URL(owners.url).origin);
});

test("an owner's save refused because the token changed its own server while the owner's listed (412) leaves it the token's: its record still says so, and the token's next save over it and its delete go through", async (t) => {
  const server = await serve(t);
  // Once `holding`, the owner's listing (at `owners`) waits until released, once; the token's lists at `fake`, never held.
  let holding = false;
  let reached;
  const blocked = new Promise((resolve) => (reached = resolve));
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const fake = await startFakeMcp();
  const owners = await startFakeMcp({ hold: async () => { if (holding) (holding = false, reached(), await released); } });
  t.after(() => (release(), fake.close(), owners.close()));
  const page = await asPage(server);
  const token = asToken(server);
  assert.equal((await token("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  const marked = await server.store.settings.get(mcpSourceKey("fake"));
  assert.equal(marked?.by, "token", "the token's save marks its record");
  holding = true;
  const owner = page("PUT", "/settings/mcp-servers/fake", { url: owners.url, auth: { type: "none" } });
  await blocked;
  // While the owner's save lists, the token changes its own server (auth none to per_run): the owner's write, let through
  // against auth none, then finds another credential and writes nothing.
  const moved = await token("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "per_run" } });
  assert.equal(moved.status, 200, moved.text);
  const tokens = await server.store.settings.get(mcpSourceKey("fake"));
  assert.equal(tokens?.by, "token");
  release();
  const refused = await owner;
  assert.equal(refused.status, 412, refused.text);
  assert.equal(refused.json?.error?.code, "precondition_failed");
  // Nothing of the owner's save landed: the row is the token's per_run one, and its record still carries the token's mark.
  const row = await server.store.mcp.server("fake");
  assert.equal(row?.auth, "per_run");
  assert.equal(row?.url, fake.url);
  assert.deepEqual(await server.store.settings.get(mcpSourceKey("fake")), tokens, "the record is as the token's save wrote it");
  const again = await token("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } });
  assert.equal(again.status, 200, `the token saves over its own server still: ${again.text}`);
  const removed = await token("DELETE", "/settings/mcp-servers/fake");
  assert.equal(removed.status, 204, removed.text);
});

test("the token's refresh never undoes the owner's save made while it listed: the owner's address stands, and the refresh is refused in words, nothing written", async (t) => {
  const server = await serve(t);
  // Once `holding`, the refresh's listing (at `fake`) waits until released, once; the owner's lists at `owners`.
  let holding = false;
  let reached;
  const blocked = new Promise((resolve) => (reached = resolve));
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const fake = await startFakeMcp({ hold: async () => { if (holding) (holding = false, reached(), await released); } });
  const owners = await startFakeMcp({ name: "owners-mcp" });
  t.after(() => (release(), fake.close(), owners.close()));
  const page = await asPage(server);
  const token = asToken(server);
  assert.equal((await page("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  holding = true;
  const refresh = token("POST", "/settings/mcp-servers/fake/refresh");
  await blocked;
  // While the refresh lists the address it read, the owner moves the server (no credential either way: the sealed column
  // the refresh compares is the same after it).
  const moved = await page("PUT", "/settings/mcp-servers/fake", { url: owners.url, auth: { type: "none" } });
  assert.equal(moved.status, 200, moved.text);
  const owned = await server.store.mcp.server("fake");
  release();
  const refreshed = await refresh;
  assert.equal(refreshed.status, 503, refreshed.text);
  assert.match(refreshed.json?.error?.message ?? "", /changed while this refresh was made; nothing was saved/);
  const row = await server.store.mcp.server("fake");
  assert.equal(row?.url, owners.url, "the owner's address stands");
  assert.deepEqual([row?.updatedAt, row?.listedAt, row?.serverInfo], [owned.updatedAt, owned.listedAt, owned.serverInfo], "nothing of the refresh was written");
});

test("a secret write's path segment that is not valid percent-encoding is answered as any request is: the token's sign-in start on it is refused, never a crash", async (t) => {
  const server = await serve(t);
  const token = asToken(server);
  const odd = await token("POST", "/settings/mcp-servers/%/oauth/start", { url: "https://mcp.example.test/mcp" });
  assert.equal(odd.status, 403, odd.text);
  assert.ok(String(odd.json?.error?.message).startsWith(gate.SECRET_WRITE_REFUSAL));
});

test("removing an MCP server that holds a credential is the owner's alone: the token is refused and the server stays; the console removes it as the page does", async (t) => {
  const { page, token } = await withSavedServer(t);
  const refused = await token("DELETE", "/settings/mcp-servers/fake");
  assert.equal(refused.status, 403, refused.text);
  assert.ok(await savedAuth(page), "still saved");
  const removed = await page("DELETE", "/settings/mcp-servers/fake");
  assert.ok(removed.status >= 200 && removed.status < 300, `the console's remove: ${removed.status} ${removed.text}`);
  assert.equal(await savedAuth(page), undefined, "removed");
});

test("a server the token saved with no credential is the token's to remove (an eval's fake); one the owner saved with none stays the owner's: 403, and it stays", async (t) => {
  const server = await serve(t);
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const page = await asPage(server);
  const token = asToken(server);
  assert.equal((await token("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  const removed = await token("DELETE", "/settings/mcp-servers/fake");
  assert.equal(removed.status, 204, removed.text);
  assert.equal(await savedAuth(page), undefined, "removed");
  // The owner's, with no credential either: the token deletes only what the token saved.
  assert.equal((await page("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  const refused = await token("DELETE", "/settings/mcp-servers/fake");
  assert.equal(refused.status, 403, refused.text);
  assert.ok(String(refused.json?.error?.message).startsWith(gate.SECRET_WRITE_REFUSAL));
  assert.ok(await savedAuth(page), "still saved");
  // A token's save over it (no credential) is refused as its delete is: the token saves over no server it did not save.
  const over = await token("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } });
  assert.equal(over.status, 403, over.text);
  assert.ok(String(over.json?.error?.message).startsWith(gate.SECRET_WRITE_REFUSAL));
  assert.equal((await token("DELETE", "/settings/mcp-servers/fake")).status, 403, "still the owner's");
  const ownersRemove = await page("DELETE", "/settings/mcp-servers/fake");
  assert.ok(ownersRemove.status >= 200 && ownersRemove.status < 300, ownersRemove.text);
  assert.equal(await savedAuth(page), undefined, "removed");
});

test("the owner's save over a server the token saved makes it the owner's: the token's delete is then 403, and it stays", async (t) => {
  const server = await serve(t);
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const page = await asPage(server);
  const token = asToken(server);
  assert.equal((await token("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  assert.equal((await page("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  const refused = await token("DELETE", "/settings/mcp-servers/fake");
  assert.equal(refused.status, 403, refused.text);
  assert.ok(await savedAuth(page), "still saved");
});

test("a sign-in's start is the owner's alone: the token is refused, and gets no state cookie to finish one with", async (t) => {
  const { fake, token } = await withSavedServer(t);
  const started = await token("POST", "/settings/mcp-servers/fake/oauth/start", { url: fake.url });
  assert.equal(started.status, 403, started.text);
  assert.equal(started.headers["set-cookie"], undefined, "no state cookie");
});

test("every operation on a secret's route is in the one gate's registry, or said on purpose to write none, with why: an unregistered one is named", () => {
  const doc = openapiDocument(() => undefined);
  const secretRoutes = [/^\/settings\/mcp-servers(\/|$)/, /^\/integrations\/github(\/|$)/, /^\/agents\/\{[^}]+\}\/sign-ins(\/|$)/, /^\/settings\/tool-keys(\/|$)/, /^\/computers(\/|$)/, /^\/workspace(\/|$)/, /^\/triggers\/\{[^}]+\}\/secret$/, /^\/settings\/slack(\/|$)/, /^\/settings\/model-gateway(\/|$)/];
  const unregistered = [];
  const noReason = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!secretRoutes.some((route) => route.test(path))) continue;
    for (const [method, op] of Object.entries(item)) {
      // A read writes nothing; every other method on these routes is decided by the registry.
      if (method === "get" || method === "head" || typeof op?.operationId !== "string") continue;
      const reason = gate.notSecretWriteReason(op.operationId);
      if (!gate.isSecretWriteOperation(op.operationId) && !reason) unregistered.push(`${method.toUpperCase()} ${path} (${op.operationId})`);
      // Registered, no secret write by its request alone, with no body and no stored row to decide by: said so with why,
      // or it is one.
      else if (!reason && !gate.writesSecret(op.operationId, undefined) && !body(op) && !gate.readsStore(op.operationId)) noReason.push(op.operationId);
    }
  }
  assert.deepEqual(unregistered, [], `unregistered operations on a secret's route: ${unregistered.join(", ")}`);
  assert.deepEqual(noReason, [], `operations registered as no secret write without a reason: ${noReason.join(", ")}`);
  for (const operation of ["startMcpOAuth", "connectGitHub", "disconnectGitHub", "forgetSignIn"]) assert.equal(gate.writesSecret(operation, undefined), true, `${operation} is a secret write whatever its request`);
});

/** Whether an operation decides by its body (a predicate that says yes to some body): one with a request body. */
const body = (op) => op.requestBody !== undefined;

test("every operation the gate can refuse to the token documents that 403, so a client reading the API document expects it", () => {
  const doc = openapiDocument(() => undefined);
  const ops = new Map(Object.values(doc.paths).flatMap((item) => Object.values(item).map((op) => [op?.operationId, op])));
  const undocumented = gate.registeredOperations().filter((operation) => !("403" in ops.get(operation).responses));
  assert.deepEqual(undocumented, [], `secret writes whose 403 the document leaves out: ${undocumented.join(", ")}`);
});
