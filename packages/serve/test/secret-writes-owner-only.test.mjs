// Only the owner's signed-in session drops or replaces a secret; the API token, which a run's process, an agent's MCP client
// or a script may hold, never does. Through the server, on the one gate in its dispatch (secret-writes.ts):
// - a save that would drop a saved MCP server's credential (auth none over a bearer) is refused to the token, and the
//   credential stays; the owner's session drops it;
// - a token's save let through against no credential never lands over one the owner saved while it listed (412);
// - removing an MCP server is refused to the token, and the server stays; the console removes it, its request made as the
//   page makes it (the session's cookie, same origin, JSON, no token);
// - a sign-in's start is refused to the token, with no state cookie handed back;
// - every operation on a secret's route (MCP servers, GitHub, sign-ins, tool keys, computers, the workspace, a trigger's
//   secret) is in the one gate's registry, or said on purpose to write none, with why.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { call, clientOwnerSession, serve as serveOf, withEnv } from "./support.mjs";

const { openapiDocument } = await import("../dist/openapi.js");
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
  assert.equal(dropped.json?.error?.message, gate.SECRET_WRITE_REFUSAL);
  assert.equal((await savedAuth(page))?.auth?.type, "bearer", "the bearer is still saved");
  // A save that keeps it (the same auth type, no value) is still the token's to make.
  const keep = await token("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer" } });
  assert.equal(keep.status, 200, keep.text);
  // The owner's session drops it.
  const drop = await page("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } });
  assert.equal(drop.status, 200, drop.text);
  assert.equal((await savedAuth(page))?.auth?.type, "none");
});

test("a token's save let through against no credential never lands over one the owner saved while it listed: it is refused 412, and the owner's credential stays", async (t) => {
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
  // Saved with no credential: a token's save with none is no secret write, so the gate lets it through.
  assert.equal((await page("PUT", "/settings/mcp-servers/fake", { url: fake.url })).status, 200);
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

test("a secret write's path segment that is not valid percent-encoding is answered as any request is: the token's removal of it is refused, never a crash", async (t) => {
  const server = await serve(t);
  const token = asToken(server);
  const odd = await token("DELETE", "/settings/mcp-servers/%");
  assert.equal(odd.status, 403, odd.text);
  assert.equal(odd.json?.error?.message, gate.SECRET_WRITE_REFUSAL);
});

test("removing an MCP server is the owner's alone: the token is refused and the server stays; the console removes it as the page does", async (t) => {
  const { page, token } = await withSavedServer(t);
  const refused = await token("DELETE", "/settings/mcp-servers/fake");
  assert.equal(refused.status, 403, refused.text);
  assert.ok(await savedAuth(page), "still saved");
  const removed = await page("DELETE", "/settings/mcp-servers/fake");
  assert.ok(removed.status >= 200 && removed.status < 300, `the console's remove: ${removed.status} ${removed.text}`);
  assert.equal(await savedAuth(page), undefined, "removed");
});

test("a sign-in's start is the owner's alone: the token is refused, and gets no state cookie to finish one with", async (t) => {
  const { fake, token } = await withSavedServer(t);
  const started = await token("POST", "/settings/mcp-servers/fake/oauth/start", { url: fake.url });
  assert.equal(started.status, 403, started.text);
  assert.equal(started.headers["set-cookie"], undefined, "no state cookie");
});

test("every operation on a secret's route is in the one gate's registry, or said on purpose to write none, with why: an unregistered one is named", () => {
  const doc = openapiDocument(() => undefined);
  const secretRoutes = [/^\/settings\/mcp-servers(\/|$)/, /^\/integrations\/github(\/|$)/, /^\/agents\/\{[^}]+\}\/sign-ins(\/|$)/, /^\/settings\/tool-keys(\/|$)/, /^\/computers(\/|$)/, /^\/workspace(\/|$)/, /^\/triggers\/\{[^}]+\}\/secret$/];
  const unregistered = [];
  const noReason = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!secretRoutes.some((route) => route.test(path))) continue;
    for (const [method, op] of Object.entries(item)) {
      // A read writes nothing; every other method on these routes is decided by the registry.
      if (method === "get" || method === "head" || typeof op?.operationId !== "string") continue;
      const reason = gate.notSecretWriteReason(op.operationId);
      if (!gate.isSecretWriteOperation(op.operationId) && !reason) unregistered.push(`${method.toUpperCase()} ${path} (${op.operationId})`);
      // Registered, and no secret write whatever its request, with no body to decide by: said so with why, or it is one.
      else if (!reason && !gate.writesSecret(op.operationId, undefined) && !body(op)) noReason.push(op.operationId);
    }
  }
  assert.deepEqual(unregistered, [], `unregistered operations on a secret's route: ${unregistered.join(", ")}`);
  assert.deepEqual(noReason, [], `operations registered as no secret write without a reason: ${noReason.join(", ")}`);
  for (const operation of ["startMcpOAuth", "deleteMcpServer", "connectGitHub", "disconnectGitHub", "forgetSignIn"]) assert.equal(gate.writesSecret(operation, undefined), true, `${operation} is a secret write whatever its request`);
});

/** Whether an operation decides by its body (a predicate that says yes to some body): one with a request body. */
const body = (op) => op.requestBody !== undefined;
