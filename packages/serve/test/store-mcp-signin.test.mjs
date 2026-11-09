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
    r.attach(`http://127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`); // key-gate: this server's own loopback address in a test, never an endpoint
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

/** The store file and its sidecars hold no byte of any value in `secrets`. A fresh write sits in the write-ahead log
 *  first, so the -wal (and its -shm index) are scanned beside the main file, before any checkpoint moves the write. The
 *  DB file MUST read — a scan that silently skipped it would pass having checked nothing; only the -wal and -shm, which a
 *  checkpointed or tiny store may not have, are optional. */
async function noSecretInStore(store, file, secrets) {
  await store.flush();
  const scan = (bytes, where) => {
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret, "utf8")), false, `a secret is not in ${where}`);
  };
  scan(readFileSync(file), "the DB file"); // required: not caught, so an unreadable DB file fails the test
  for (const [path, where] of [[`${file}-wal`, "the WAL"], [`${file}-shm`, "the WAL index"]]) {
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    scan(bytes, where);
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

test("a callback without the cookie its start set is refused before the store callback runs (the route's startedHere gate)", async (t) => {
  // The browser binding is the route's gate, not a store column: server.ts (mcpOAuthCallback, ~1969) runs
  // startedHere(req.headers.cookie, port, state) and returns 403 BEFORE it ever calls the registry's oauthCallback, for the
  // file and the store registry alike. So a store sign-in a different browser tries to finish never reaches the store. Here
  // is a real store sign-in's state, put through the exact gate the route applies; the end-to-end HTTP 403 runs through
  // serve() once the switch repoints server.ts at the store registry (serve still builds the file class, so it can't here).
  const { mcp, reg } = await signIns(t);
  const r = reg();
  const started = await r.oauthStart("docs", { url: mcp.url });
  const state = new URL(started.authorization_url).searchParams.get("state");
  const cookie = signInCookie(PORT, state, false).split(";")[0]; // what the start route set in the browser
  assert.ok(!startedHere(undefined, PORT, state), "no cookie: the gate refuses (the route returns 403), store callback never runs");
  assert.ok(!startedHere(signInCookie(PORT, "another-sign-in", false).split(";")[0], PORT, state), "another sign-in's cookie: refused");
  assert.ok(startedHere(cookie, PORT, state), "the start's own cookie passes the gate");
  // Only the browser that started it, carrying that cookie, gets past the gate; its callback then finishes the sign-in.
  assert.equal(await r.oauthCallback(await approved(started.authorization_url)), "/#/settings/mcp?server=docs&sign_in=ok");
});
