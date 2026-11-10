// The owner's MCP OAuth sign-in over the store (mcp-servers-store.ts on a real temp store): a sign-in starts, its state is
// written as a store row, and the callback takes it back to seal the token set. A sign-in's secret parts (the PKCE verifier
// and the OAuth client with its secret) are sealed in the row, so the DB file never holds them in the clear; the flow
// survives a restart (the row outlives the process); a replayed state is refused in the words. The whole sign-in over HTTP
// (its token set sealed, its expiry, the start-browser cookie gate) is mcp-oauth.test.mjs's. The fakes are an OAuth
// authorization server and an MCP server on loopback (fixtures), reached as a development loopback sign-in is.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { mcpServersOverStore } from "../dist/mcp-servers-store.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";
import { storeOn } from "./store-helpers.mjs";
import { storeAtRest } from "./store-target.mjs";

// Built with the `not-a-secret-` prefix so the source scan that flags a hardcoded credential does not fire on this test.
const SECRET = `not-a-secret-${randomBytes(12).toString("hex")}`;
const PORT = 4321; // the loopback port the registry is attached to below; the port the route's sign-in cookie is named by.
const env = (key) => ({ AGENTRUN_SEAL_KEY: Buffer.from(key).toString("base64") });

/** A registry over the store at a loopback address (so a loopback sign-in is allowed), the fakes it signs in against, and
 *  the sealed-key env. */
async function signIns(t, key = randomBytes(32)) {
  const { store, file } = await storeOn(t);
  const oauth = await startFakeOAuth({ clients: { "owner-app": SECRET } });
  const mcp = await startFakeMcp({ token: oauth.accepts, oauth: oauth.issuer });
  t.after(() => mcp.close());
  t.after(() => oauth.close());
  const reg = () => {
    const r = mcpServersOverStore(store, env(key), "1.0.0");
    r.attach(`http://127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`); // key-gate: this server own loopback address in a test, never an endpoint
    return r;
  };
  return { store, file, oauth, mcp, reg, key };
}

/** The owner's browser following a start's authorization URL: the fake approves at once and redirects back with the code
 *  and state the callback reads. */
async function approved(authorizationUrl) {
  const asked = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(asked.status, 302, await asked.text());
  const back = new URL(asked.headers.get("location"));
  return new URLSearchParams({ code: back.searchParams.get("code"), state: back.searchParams.get("state") });
}

/** The store at rest (store-target.mjs storeAtRest: SQLite's file and its -wal and -shm, a fresh write sitting in the
 *  WAL first; Postgres's every column of every table) holds no byte of any value in `secrets`. The store MUST read: a
 *  scan that silently read nothing would pass having checked nothing. */
async function noSecretInStore(store, file, secrets) {
  await store.flush();
  const atRest = await storeAtRest(file);
  assert.ok(atRest.length > 0, "the store at rest was read");
  for (const [where, bytes] of atRest) {
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret, "utf8")), false, `a secret is not in ${where}`);
  }
}

test("a pre-registered sign-in's client secret is sealed in the pending row: it is nowhere in the DB file", async (t) => {
  const { store, file, mcp, reg } = await signIns(t);
  const started = await reg().oauthStart("crm", { url: mcp.url, client_id: "owner-app", client_secret: SECRET });
  assert.match(started.authorization_url, /\/authorize\?/, "the owner is sent to the authorization server");
  // The sign-in is in flight: its row is live. The client secret the owner gave is a secret the store must never hold in
  // the clear, so it is sealed in the row like the registry credential is.
  await noSecretInStore(store, file, [SECRET]);
});

test("a replayed callback is refused in the words: the state is single-use", async (t) => {
  const { mcp, reg } = await signIns(t);
  const r = reg();
  const started = await r.oauthStart("docs", { url: mcp.url });
  const query = await approved(started.authorization_url);
  assert.equal(await r.oauthCallback(query), "/#/settings/mcp?server=docs&sign_in=ok");
  await assert.rejects(() => r.oauthCallback(query), (e) => e.code === "bad_request" && /used already/.test(e.message), "the same callback again is refused");
});

test("a sign-in survives a restart mid-flight: a fresh registry on the same store finishes the callback", async (t) => {
  const { mcp, reg } = await signIns(t);
  const started = await reg().oauthStart("docs", { url: mcp.url }); // one registry (a process) starts the sign-in
  const query = await approved(started.authorization_url);
  const back = await reg().oauthCallback(query); // a fresh registry (the server restarted) finishes it from the store row
  assert.equal(back, "/#/settings/mcp?server=docs&sign_in=ok");
  assert.equal((await reg().get("docs")).credential, "sealed", "the token set was sealed and kept across the restart");
});
