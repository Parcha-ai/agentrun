// A sign-in with no Client ID entered needs an authorization server that lets this app register itself (dynamic client
// registration). One that doesn't (a code host's login: no metadata, or metadata with no registration endpoint) is said
// up front, on the field that fixes it: the start is 422 on `client_id`, reason `registration_unavailable`, in words that
// say to create an OAuth app and enter its Client ID and Secret; the preview of such a server says
// `details.oauth.registration: false`, so a console asks for them before the owner tries. With a Client ID entered, the
// sign-in starts as before.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { serve, withEnv } from "./support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";

/** A fake MCP server signing in at a fake authorization server made with `options`. */
async function fakes(t, options) {
  const as = await startFakeOAuth(options);
  const mcp = await startFakeMcp({ token: as.accepts, oauth: as.issuer });
  t.after(() => Promise.all([as.close(), mcp.close()]));
  return { as, mcp };
}

test("an authorization server that lets no app register itself: the start without a Client ID is 422 on client_id (registration_unavailable), the preview says registration false; with a Client ID it starts; one that does says true and starts", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t, { runner: false });
  for (const [what, options, registration] of [
    ["no registration endpoint", { registration: false, clients: { "hand-made": "s3" } }, false],
    ["no metadata at all", { metadata: false, registration: false, clients: { "hand-made": "s3" } }, false],
    ["dynamic registration", {}, true],
  ]) {
    const { as, mcp } = await fakes(t, options);
    const preview = await api("POST", "/settings/mcp-servers/preview", { url: mcp.url, auth: { type: "none" } });
    assert.equal(preview.status, 422, `${what}: ${JSON.stringify(preview.body)}`);
    assert.equal(preview.body.error.code, "auth_required", what);
    assert.deepEqual([preview.body.error.details.auth, preview.body.error.details.oauth], ["oauth", { registration }], `${what}: ${JSON.stringify(preview.body.error.details)}`);
    const name = `signin${registration ? "dyn" : what.length}`;
    const started = await api("POST", `/settings/mcp-servers/${name}/oauth/start`, { url: mcp.url });
    if (registration) {
      assert.equal(started.status, 200, `${what}: ${JSON.stringify(started.body)}`);
      assert.ok(as.log.some((entry) => entry.path === "/register"), `${what}: it registered itself`);
      continue;
    }
    assert.equal(started.status, 422, `${what}: ${JSON.stringify(started.body)}`);
    assert.deepEqual(started.body.error.fields.map((field) => [field.field, field.reason, field.message]), [["client_id", "registration_unavailable", `${new URL(mcp.url).host} doesn't let apps register themselves: create an OAuth app with that provider and enter its Client ID and Secret here.`]], what);
    assert.ok(!as.log.some((entry) => entry.path === "/register" || entry.path === "/token"), `${what}: no registration tried, nothing exchanged`);
    // With the Client ID entered, the sign-in starts at the authorization server's page.
    const entered = await api("POST", `/settings/mcp-servers/${name}/oauth/start`, { url: mcp.url, client_id: "hand-made", client_secret: "s3" });
    assert.equal(entered.status, 200, `${what}: ${JSON.stringify(entered.body)}`);
    assert.match(entered.body.authorization_url, /\/authorize\?/, what);
  }
});
