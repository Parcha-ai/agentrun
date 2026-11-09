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

test("a pre-registered sign-in's client secret is sealed in the pending row: it is nowhere in the DB file", async (t) => {
  const { store, file, mcp, reg } = await signIns(t);
  const started = await reg().oauthStart("crm", { url: mcp.url, client_id: "owner-app", client_secret: SECRET });
  assert.match(started.authorization_url, /\/authorize\?/, "the owner is sent to the authorization server");
  await store.flush();
  // The sign-in is in flight: its row is live. The client secret the owner gave is a secret the store must never hold in
  // the clear, so it is sealed in the row like the registry credential is.
  for (const path of [file, `${file}-wal`]) {
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    assert.equal(bytes.includes(Buffer.from(SECRET, "utf8")), false, `the client secret is not in ${path.endsWith("-wal") ? "the WAL" : "the DB file"}`);
  }
});
