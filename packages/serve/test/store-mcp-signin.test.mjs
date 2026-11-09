// The owner's MCP OAuth sign-in over the store (mcp-servers-store.ts on a real temp store): a sign-in starts, its state is
// written as a store row, and the callback takes it back to seal the token set. A sign-in's secret parts (the PKCE verifier
// and the OAuth client with its secret) are sealed in the row, so the DB file never holds them in the clear; the flow
// survives a restart (the row outlives the process); a replayed or expired state is refused in the words. The fakes are an
// OAuth authorization server and an MCP server on loopback (fixtures), reached as a development loopback sign-in is.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { signInCookie, startedHere } from "../dist/mcp-oauth.js";
import { mcpServersOverStore } from "../dist/mcp-servers-store.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";
import { storeOn } from "./store-helpers.mjs";

const SECRET = `client-secret-${randomBytes(12).toString("hex")}`;
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
    r.attach("http://127.0.0.1:4321", "http://127.0.0.1:4321"); // key-gate: this server's own loopback address in a test, never an endpoint
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

/** The store file and its WAL hold no byte of any value in `secrets`. */
async function noSecretInStore(store, file, secrets) {
  await store.flush();
  for (const path of [file, `${file}-wal`]) {
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret, "utf8")), false, `a secret is not in ${path.endsWith("-wal") ? "the WAL" : "the DB file"}`);
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

test("a sign-in over the store: start, approve and the callback seal the token set and list the tools; no token is in the clear", async (t) => {
  const { store, file, oauth, mcp, reg } = await signIns(t);
  const r = reg();
  const started = await r.oauthStart("docs", { url: mcp.url, scopes: ["read"] });
  assert.equal(new URL(started.authorization_url).searchParams.get("scope"), "read");
  const back = await r.oauthCallback(await approved(started.authorization_url));
  assert.equal(back, "/#/settings/mcp?server=docs&sign_in=ok", "the owner is sent back to the console, signed in");
  const view = await r.get("docs");
  assert.equal(view.auth.type, "oauth");
  assert.equal(view.credential, "sealed", "the token set is kept sealed");
  assert.deepEqual(view.oauth.scopes, ["read"]);
  assert.deepEqual(view.tools.map((tool) => tool.name).sort(), ["add", "delete_thing", "paid", "slow_write"], "its tools are listed at sign-in");
  assert.ok(!JSON.stringify(view).includes(oauth.issued[0]), "no token is in a read");
  await noSecretInStore(store, file, oauth.issued);
});

test("a replayed callback is refused in the words: the state is single-use", async (t) => {
  const { mcp, reg } = await signIns(t);
  const r = reg();
  const started = await r.oauthStart("docs", { url: mcp.url });
  const query = await approved(started.authorization_url);
  assert.equal(await r.oauthCallback(query), "/#/settings/mcp?server=docs&sign_in=ok");
  await assert.rejects(() => r.oauthCallback(query), (e) => e.code === "bad_request" && /used already/.test(e.message), "the same callback again is refused");
});

test("an expired state is refused in the words: a callback after ten minutes takes nothing", async (t) => {
  const { mcp, reg } = await signIns(t);
  const r = reg();
  const started = await r.oauthStart("docs", { url: mcp.url });
  const query = await approved(started.authorization_url);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 11 * 60_000 });
  await assert.rejects(() => r.oauthCallback(query), (e) => e.code === "bad_request");
  t.mock.timers.reset();
  await assert.rejects(() => r.get("docs"), (e) => e.code === "not_found", "nothing was written for the expired sign-in");
});

test("a sign-in survives a restart mid-flight: a fresh registry on the same store finishes the callback", async (t) => {
  const { mcp, reg } = await signIns(t);
  const started = await reg().oauthStart("docs", { url: mcp.url }); // one registry (a process) starts the sign-in
  const query = await approved(started.authorization_url);
  const back = await reg().oauthCallback(query); // a fresh registry (the server restarted) finishes it from the store row
  assert.equal(back, "/#/settings/mcp?server=docs&sign_in=ok");
  assert.equal((await reg().get("docs")).credential, "sealed", "the token set was sealed and kept across the restart");
});

test("the cookie check binds a callback to the browser that started the sign-in (server.ts applies it to this class too)", () => {
  // The store registry's oauthCallback does not read cookies: server.ts gates both the file and the store registry with
  // startedHere before it calls the callback, so a sign-in started in another browser never reaches it. These are the
  // exported functions it uses; the end-to-end 403 is server.ts's, carried by the serve() integration test the switch
  // repoints at the store registry.
  const port = 7700;
  const state = "state-abc";
  const cookie = signInCookie(port, state, false).split(";")[0];
  assert.ok(startedHere(cookie, port, state), "the start's own cookie matches its state");
  assert.ok(!startedHere("", port, state), "no cookie: refused");
  assert.ok(!startedHere(signInCookie(port, "other-state", false).split(";")[0], port, state), "another sign-in's cookie does not match");
});
