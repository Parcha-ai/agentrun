// Composio's catalog on an API-only server (AGENTRUN_API_ONLY=1): the toolkit list and a toolkit's actions, read with the
// server's own key named by api_key_env (COMPOSIO_API_KEY), by the token scoped to a workspace or not, for a backend's own
// picker. A key the caller sends (api_key) is still the owner's session alone (403, nothing sent to Composio), and on any
// other server the token's listing is refused whatever names the key. Fake Composio on loopback; no key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { secretWritePath, serve, serverLog, withEnv } from "./support.mjs";

secretWritePath(["POST"], /^\/settings\/mcp-servers\/composio\/(toolkits|tools)$/);

const { API_ONLY_ROUTES, WORKSPACE_ROUTES } = await import("../dist/api-only.js");

const KEY_ENV = "COMPOSIO_API_KEY";
const KEY = `not-a-secret-${"composio-env-key-0202"}`;
const ADD = { slug: "add", name: "Add", description: "Add two numbers." };
const TOOLKITS = { github: { name: "GitHub", no_auth: false, tools: [ADD] }, hackernews: { name: "Hacker News", no_auth: true, tools: [ADD] } };
const LISTED = { toolkits: [{ slug: "github", name: "GitHub" }, { slug: "hackernews", name: "Hacker News" }] };
const TOOLS = { toolkit: "github", no_auth: false, tools: [ADD] };
const SCOPED = randomBytes(24).toString("hex");
const OPERATOR = randomBytes(24).toString("hex");
/** The refusal a real secret write gets (secret-writes.ts SECRET_WRITE_REFUSAL), and the listings' own, which save nothing. */
const SECRET_REFUSAL = "Saving, replacing or removing a secret takes the owner's signed-in session in the console; the API token can't write secrets.";
const LISTING_API_ONLY = "A listing that sends a key's value takes the owner's signed-in session; on this server name the key by api_key_env instead.";
const LISTING_ELSEWHERE = "Listing Composio's toolkits or tools takes the owner's signed-in session in the console; the API token lists them only on an API-only server, with the key named by api_key_env.";
/** A 403's words before the console link the refusal may add (secret-writes.ts secretWriteRefusal). */
const words = (refused) => String(refused.body.error.message).split(" Finish it in the console: ")[0];
const TOOLKITS_PATH = "/v2/settings/mcp-servers/composio/toolkits";
const TOOLS_PATH = "/v2/settings/mcp-servers/composio/tools";

/** A server (API-only unless `full`) beside a fake Composio whose key is KEY, set as COMPOSIO_API_KEY unless `unset`;
 *  `v2` (scoped) and `ops` (unscoped) its tokens on the API-only one. */
async function setup(t, { full = false, unset = false } = {}) {
  withEnv(t, unset ? {} : { [KEY_ENV]: KEY }, [KEY_ENV]);
  const composio = await startFakeComposio({ apiKey: KEY, toolkits: TOOLKITS });
  t.after(() => composio.close());
  const log = serverLog(t);
  const server = await serve(t, { composioControl: { baseUrl: composio.baseUrl }, ...(full ? {} : { apiOnly: true, tokens: [{ id: "v2", token: SCOPED }, { id: "ops", token: OPERATOR }], workspaceTokens: ["v2"] }) });
  return { composio, log, server };
}

/** POST `path` with `body` as `token`, in `workspace` (no header when undefined): status and parsed body. */
async function post(server, path, body, { token = OPERATOR, workspace } = {}) {
  const res = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(workspace === undefined ? {} : { "agentrun-workspace": workspace }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("both listings are API-only routes a scoped request is served", () => {
  for (const name of ["listComposioToolkits", "listComposioTools"]) {
    assert.ok(API_ONLY_ROUTES.has(name), `${name} is served API-only`);
    assert.ok(WORKSPACE_ROUTES.has(name), `${name} is served scoped`);
  }
});

test("on an API-only server the token lists the toolkits and a toolkit's actions with the key api_key_env names, scoped or not, and never answers or logs the key", async (t) => {
  const s = await setup(t);
  for (const [who, options] of [["unscoped", {}], ["scoped to W1", { token: SCOPED, workspace: "org:w1" }], ["scoped to W2", { token: SCOPED, workspace: "org:w2" }]]) {
    const toolkits = await post(s.server, TOOLKITS_PATH, { api_key_env: KEY_ENV }, options);
    assert.equal(toolkits.status, 200, `${who}: ${JSON.stringify(toolkits.body)}`);
    assert.deepEqual(toolkits.body, LISTED, who);
    const tools = await post(s.server, TOOLS_PATH, { api_key_env: KEY_ENV, toolkit: "github" }, options);
    assert.equal(tools.status, 200, `${who}: ${JSON.stringify(tools.body)}`);
    assert.deepEqual(tools.body, TOOLS, who);
  }
  assert.ok(s.composio.calls.length > 0 && s.composio.calls.every((call) => call.keyOk), "every Composio call sent the environment's key");
  assert.ok(!s.log.text().includes(KEY), "the key is in no log line");
});

test("on an API-only server a key the caller sends is still 403 to the token, scoped or not, and nothing reaches Composio", async (t) => {
  const s = await setup(t);
  for (const options of [{}, { token: SCOPED, workspace: "org:w1" }]) {
    for (const [path, body] of [[TOOLKITS_PATH, { api_key: KEY }], [TOOLS_PATH, { api_key: KEY, toolkit: "github" }], [TOOLKITS_PATH, { api_key: KEY, api_key_env: KEY_ENV }], [TOOLS_PATH, { toolkit: "github" }]]) {
      const refused = await post(s.server, path, body, options);
      assert.equal(refused.status, 403, `${path} ${JSON.stringify(body)}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error.code, "forbidden");
      assert.equal(words(refused), LISTING_API_ONLY, "a listing saves nothing: its own words, never the secret write's");
      assert.ok(!JSON.stringify(refused.body).includes(KEY), "the refusal never echoes the key");
    }
  }
  assert.equal(s.composio.calls.length, 0, "Composio was never called");
});

test("api_key_env names COMPOSIO_API_KEY alone, set: another name is 422 invalid, an unset one 422 missing, and nothing reaches Composio", async (t) => {
  const s = await setup(t);
  const other = await post(s.server, TOOLKITS_PATH, { api_key_env: "PATH" });
  assert.deepEqual([other.status, other.body.error.fields?.[0]?.field, other.body.error.fields?.[0]?.reason], [422, "api_key_env", "invalid"], JSON.stringify(other.body));
  const extra = await post(s.server, TOOLKITS_PATH, { api_key_env: KEY_ENV, toolkit: "github" });
  assert.deepEqual([extra.status, extra.body.error.fields?.[0]?.field, extra.body.error.fields?.[0]?.reason], [422, "toolkit", "not_allowed"], JSON.stringify(extra.body));
  const tools = await post(s.server, TOOLS_PATH, { api_key_env: "HOME", toolkit: "github" });
  assert.deepEqual([tools.status, tools.body.error.fields?.[0]?.field], [422, "api_key_env"], JSON.stringify(tools.body));
  assert.equal(s.composio.calls.length, 0);
  const u = await setup(t, { unset: true });
  for (const [path, body] of [[TOOLKITS_PATH, { api_key_env: KEY_ENV }], [TOOLS_PATH, { api_key_env: KEY_ENV, toolkit: "github" }]]) {
    const missing = await post(u.server, path, body);
    assert.deepEqual([missing.status, missing.body.error.fields?.[0]?.field, missing.body.error.fields?.[0]?.reason], [422, "api_key_env", "missing"], JSON.stringify(missing.body));
  }
  assert.equal(u.composio.calls.length, 0);
});

test("on a server that is not API-only the token's listing stays 403 whatever names the key, and the owner's session lists with api_key_env too", async (t) => {
  const s = await setup(t, { full: true });
  const token = { authorization: `Bearer ${s.server.token}` };
  for (const [path, body] of [[TOOLKITS_PATH.slice(3), { api_key_env: KEY_ENV }], [TOOLS_PATH.slice(3), { api_key_env: KEY_ENV, toolkit: "github" }]]) {
    const refused = await s.server.api("POST", path, body, token);
    assert.equal(refused.status, 403, `${path}: ${JSON.stringify(refused.body)}`);
    assert.equal(words(refused), LISTING_ELSEWHERE);
  }
  for (const [method, path, body] of [["PUT", "/settings/mcp-servers/gh/composio", { api_key: KEY, toolkit: "github", tools: ["add"] }], ["POST", "/settings/mcp-servers/gh/composio/rotate-secret", {}]]) {
    const refused = await s.server.api(method, path, body, token);
    assert.equal(refused.status, 403, `${path}: ${JSON.stringify(refused.body)}`);
    assert.equal(words(refused), SECRET_REFUSAL, `${path}: a real secret write keeps its words`);
  }
  assert.equal(s.composio.calls.length, 0, "Composio was never called for the token");
  const owners = await s.server.api("POST", TOOLKITS_PATH.slice(3), { api_key_env: KEY_ENV });
  assert.equal(owners.status, 200, JSON.stringify(owners.body));
  assert.deepEqual(owners.body, LISTED);
  const ownersTools = await s.server.api("POST", TOOLS_PATH.slice(3), { api_key_env: KEY_ENV, toolkit: "github" });
  assert.equal(ownersTools.status, 200, JSON.stringify(ownersTools.body));
});
