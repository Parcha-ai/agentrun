// A saved MCP server's credential as every secret is read (SECRETS-PLAN.md): `secret: { name, set, source, changed_at }`
// beside the header names and the sign-in's note, never a value. `source` is how it came: "console" pasted (bearer or
// headers), "sign-in" an OAuth sign-in, null for none. `changed_at` is the credential's own time (mcp_servers
// credential_changed_at): a save with a new credential or a sign-in moves it; a save that keeps the sealed one, a refresh
// of the tools, and a token refresh (the server keeping the sign-in) leave it. A real store, and a fake MCP server on
// loopback for the registry's own saves.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { storeOn, T0 } from "./store-helpers.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const { mcpServersOverStore } = await import("../dist/mcp-servers-store.js");
const { saveMcpServer } = await import("../dist/mcp-store.js");
const { sealMcpCredential } = await import("../dist/store/index.js");

const KEY = Buffer.from(randomBytes(32));
/** The registry as a local install's server attaches it (listening on loopback alone), so its fake MCP server on
 *  loopback is one it may reach. */
const reg = (store) => {
  const registry = mcpServersOverStore(store, { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, "test");
  registry.attach("http://127.0.0.1:9", "http://127.0.0.1:9", true); // key-gate: loopback-rule a local install's own address in a test, never an endpoint
  return registry;
};
const TOKEN = `not-a-secret-${"first-token"}`;
const NEXT = `not-a-secret-${"next-token"}`;
const iso = (ms) => new Date(ms).toISOString();

test("the shape: pasted is console, a sign-in is sign-in, none is unset; never a value", async (t) => {
  const { store } = await storeOn(t);
  await saveMcpServer(store, KEY, { name: "gh", url: "https://mcp.example.test/gh", auth: "headers", tools: [], credential: { type: "headers", headers: { "x-api-key": TOKEN } } });
  await saveMcpServer(store, KEY, { name: "lin", url: "https://mcp.example.test/lin", auth: "oauth", tools: [], credential: { type: "oauth", set: { tokens: { access_token: TOKEN, token_type: "Bearer" }, obtained_at: iso(T0), client: { client_id: "c" }, kind: "dynamic", discovery: {} } } });
  await saveMcpServer(store, KEY, { name: "pub", url: "https://mcp.example.test/pub", auth: "none", tools: [] });
  const r = reg(store);
  assert.deepEqual((await r.get("gh")).secret, { name: "mcp:gh", set: true, source: "console", changed_at: iso(T0) });
  assert.deepEqual((await r.get("gh")).auth, { type: "headers", headers: ["x-api-key"] }, "the header names stay");
  assert.deepEqual((await r.get("lin")).secret, { name: "mcp:lin", set: true, source: "sign-in", changed_at: iso(T0) });
  assert.deepEqual((await r.get("pub")).secret, { name: "mcp:pub", set: false, source: null, changed_at: null });
  assert.deepEqual([(await r.get("pub")).credential, (await r.get("pub")).auth], [null, { type: "none" }], "none: no credential and no header names");
  assert.ok(!JSON.stringify(await r.list()).includes(TOKEN), "no value anywhere in a read");
});

test("changed_at moves with a new credential only: a save that keeps the sealed one, a refresh of the tools and a token refresh leave it", async (t) => {
  const { store, clock } = await storeOn(t);
  const fake = await startFakeMcp({ token: (got) => got === `Bearer ${TOKEN}` || got === `Bearer ${NEXT}` });
  t.after(() => fake.close());
  const r = reg(store);
  await r.save("fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal((await r.get("fake")).secret.changed_at, iso(T0), "a save with a credential");
  clock.now += 60_000;
  await r.save("fake", { url: fake.url, auth: { type: "bearer" } });
  assert.equal((await r.get("fake")).secret.changed_at, iso(T0), "a save that keeps the sealed credential");
  clock.now += 60_000;
  await r.refresh("fake");
  assert.equal((await r.get("fake")).secret.changed_at, iso(T0), "a refresh of the tools");
  // A token refresh: the runner's lease, then its write of the set it keeps.
  clock.now += 60_000;
  const row = await store.mcp.server("fake");
  const lease = await store.mcp.leaseRefresh("fake", { seen: row.sealed, holder: "run-1@1" });
  assert.equal(lease.leased, true);
  await store.mcp.keepRefreshed("fake", { seen: row.sealed, holder: "run-1@1", sealed: sealMcpCredential(KEY, "fake", { type: "headers", headers: { authorization: `Bearer ${TOKEN}` } }, fake.url) });
  assert.equal((await r.get("fake")).secret.changed_at, iso(T0), "a token refresh is the server keeping it");
  clock.now += 60_000;
  await r.save("fake", { url: fake.url, auth: { type: "bearer", token: NEXT } });
  assert.equal((await r.get("fake")).secret.changed_at, iso(clock.now), "a new credential moves it");
});

test("the document's MCP server read takes its secret from the one SecretMeta schema, not a copy", async () => {
  const { openapiDocument } = await import("../dist/openapi.js");
  const doc = openapiDocument(() => undefined);
  const read = doc.paths["/settings/mcp-servers/{name}"].get.responses["200"].content["application/json"].schema;
  const view = read.$ref ? doc.components.schemas[read.$ref.split("/").pop()] : read;
  assert.equal(view.properties.secret.$ref, "#/components/schemas/SecretMeta");
});
