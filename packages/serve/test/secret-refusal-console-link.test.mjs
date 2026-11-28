// A secret write the API token is refused (secret-writes.ts, the one gate in the dispatch) still says where to finish it:
// the refusal is the same 403 forbidden, its message ends "Finish it in the console: <link>", and `details.console_url` is
// that link. For an MCP server the link opens the add form (or, for a saved server, its Change form) filled with what the
// request held that is no secret: its name, its URL, the kind of credential, its toolkit. Never a token, a header, a
// client secret, or a URL with anything in it that could be a credential (a user or password, a query parameter named
// like one, a key-shaped path segment or value): such a URL is left out whole, and the person pastes it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { asOwner, call, serve, withEnv } from "./support.mjs";

const gate = await import("../dist/secret-writes.js");
// The planes register their operations as their modules load: the server's own imports, as a started server has them.
await import("../dist/server.js");

const json = { "content-type": "application/json" };
/** A fake credential, made fresh each run: none of these is a real token. */
const fake = (label) => `not-a-secret-${label}-${randomBytes(12).toString("hex")}`;
/** A piece of a fake base64 key, 14 characters with both cases of letter: too short alone to look like a key. */
const piece = () => `aZ${randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;

async function started(t) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { runner: false });
  const origin = `http://127.0.0.1:${server.port}`;
  const token = (method, path, body) => call(server.port, { method, path: `/v2${path}`, headers: { ...(body !== undefined ? json : {}), authorization: `Bearer ${server.token}` }, ...(body !== undefined ? { body } : {}) });
  return { server, origin, token };
}

/** The refusal `res` is: 403 forbidden in the one sentence (`words`: an operation's own, else the secret write's), then
 *  "Finish it in the console: <link>", the link also in details.console_url. Answers the link. */
function refusedWithLink(res, origin, words = gate.SECRET_WRITE_REFUSAL) {
  assert.equal(res.status, 403, res.text);
  assert.equal(res.json?.error?.code, "forbidden");
  const { message, details } = res.json.error;
  const link = details?.console_url;
  assert.equal(typeof link, "string", `details.console_url: ${res.text}`);
  assert.ok(link.startsWith(`${origin}/#/`), `the link is on the console's own address: ${link}`);
  assert.equal(message, `${words} Finish it in the console: ${link}`);
  return link;
}
/** The hash route's query of `link`, read as the console reads it. */
const queryOf = (link) => Object.fromEntries(new URLSearchParams(new URL(link).hash.split("?")[1] ?? ""));

test("a token's save of an MCP server's bearer token is refused as before, and its link opens the add form filled with the name, URL and kind of credential, never the token", async (t) => {
  const { origin, token } = await started(t);
  const secret = fake("bearer");
  const url = "https://mcp.example.test/mcp";
  const res = await token("PUT", "/settings/mcp-servers/linear", { url, auth: { type: "bearer", token: secret }, toolkit: "linear" });
  const link = refusedWithLink(res, origin);
  assert.ok(link.startsWith(`${origin}/#/settings/mcp?`), link);
  assert.deepEqual(queryOf(link), { add: "linear", url, auth: "bearer", toolkit: "linear" });
  assert.ok(!res.text.includes(secret), "the refusal never holds the token");
  assert.equal((await token("GET", "/settings/mcp-servers/linear")).status, 404, "nothing was kept");
});

test("headers, a sign-in's client secret and every other credential stay out of the link", async (t) => {
  const { origin, token } = await started(t);
  const header = fake("header");
  const headers = await token("PUT", "/settings/mcp-servers/crm", { url: "https://crm.example.test/mcp", auth: { type: "headers", headers: { "X-Api-Key": header } } });
  assert.deepEqual(queryOf(refusedWithLink(headers, origin)), { add: "crm", url: "https://crm.example.test/mcp", auth: "headers" });
  assert.ok(!headers.text.includes(header), "no header value");
  assert.ok(!headers.text.includes("X-Api-Key"), "no header name either");

  const client = fake("client");
  const signIn = await token("POST", "/settings/mcp-servers/notion/oauth/start", { url: "https://notion.example.test/mcp", client_id: "console-client", client_secret: client });
  assert.deepEqual(queryOf(refusedWithLink(signIn, origin)), { add: "notion", url: "https://notion.example.test/mcp", auth: "oauth" });
  assert.ok(!signIn.text.includes(client), "no client secret");

  const key = fake("composio");
  const composio = await token("PUT", "/settings/mcp-servers/slack/composio", { api_key: key, toolkit: "slack", tools: ["SLACK_SEND_MESSAGE", "SLACK_FIND_CHANNELS"] });
  assert.deepEqual(queryOf(refusedWithLink(composio, origin)), { add: "slack", preset: "composio", toolkit: "slack", tools: "SLACK_SEND_MESSAGE,SLACK_FIND_CHANNELS" });
  assert.ok(!composio.text.includes(key), "no Composio key");
});

test("a URL with anything in it that could be a credential never reaches the link: the link names the server and leaves the URL out", async (t) => {
  const { origin, token } = await started(t);
  const secret = fake("in-url");
  const key = `${randomBytes(24).toString("base64url")}`;
  const urls = {
    userinfo: Object.assign(new URL("https://mcp.example.test/mcp"), { username: "someone", password: secret }).href,
    query: `https://mcp.example.test/mcp?api_key=${secret}`,
    "query value": `https://mcp.example.test/mcp?k=${key}`,
    path: `https://hooks.example.test/api/mcp/s/${key}/sse`,
    shaped: `https://mcp.example.test/mcp/ghp_${"a".repeat(36)}`,
    // A base64 key holds "/" and "+": split across path segments, or read as two words once a query's "+" is decoded,
    // each piece is too short to look like a key alone.
    "path spanning segments": `https://mcp.example.test/mcp/${piece()}/${piece()}/sse`,
    "query value with a plus": `https://mcp.example.test/mcp?k=${piece()}+${piece()}`,
    // A per-person subdomain can be the key.
    host: `https://${randomBytes(12).toString("hex")}.mcp.example.test/mcp`,
  };
  for (const [what, url] of Object.entries(urls)) {
    const res = await token("PUT", "/settings/mcp-servers/leaky", { url, auth: { type: "bearer", token: fake("bearer") } });
    const link = refusedWithLink(res, origin);
    assert.deepEqual(queryOf(link), { add: "leaky", auth: "bearer" }, `${what}: ${link}`);
    for (const part of [secret, key, "ghp_", "example.test"]) assert.ok(!link.includes(part) && !link.includes(encodeURIComponent(part)), `${what}: the link holds none of the URL: ${link}`);
  }
  // A URL of plain words and version numbers is still filled.
  const plain = "https://mcp.example.test/v1/mcp/stream/events?transport=streamable";
  const res = await token("PUT", "/settings/mcp-servers/plain", { url: plain, auth: { type: "bearer", token: fake("bearer") } });
  assert.deepEqual(queryOf(refusedWithLink(res, origin)), { add: "plain", url: plain, auth: "bearer" });
});

test("a token's change of a saved server's credential links to that server's Change form, not to a new one", async (t) => {
  const { origin, token } = await started(t);
  const open = await startFakeMcp();
  t.after(() => open.close());
  const saved = await token("PUT", "/settings/mcp-servers/docs", { url: open.url, auth: { type: "none" } });
  assert.equal(saved.status, 200, saved.text);
  const res = await token("PUT", "/settings/mcp-servers/docs", { url: open.url, auth: { type: "bearer", token: fake("bearer") } });
  assert.deepEqual(queryOf(refusedWithLink(res, origin)), { change: "docs", url: open.url, auth: "bearer" });
});

test("a token's save that would drop a saved server's credential links to its Change form on none; one of a kind the form can't fill links to the page alone", async (t) => {
  const { server, origin, token } = await started(t);
  const secret = fake("bearer");
  const mcp = await startFakeMcp({ token: secret });
  t.after(() => mcp.close());
  const saved = await asOwner(server)("PUT", "/settings/mcp-servers/docs", { url: mcp.url, auth: { type: "bearer", token: secret } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  // No auth is none (the save drops the token): the link says none, so the Change form never falls back to bearer.
  const dropped = await token("PUT", "/settings/mcp-servers/docs", { url: mcp.url });
  assert.deepEqual(queryOf(refusedWithLink(dropped, origin)), { change: "docs", url: mcp.url, auth: "none" });
  const perRun = await token("PUT", "/settings/mcp-servers/docs", { url: mcp.url, auth: { type: "per_run" } });
  assert.equal(refusedWithLink(perRun, origin), `${origin}/#/settings/mcp`);
});

test("a token's Composio save over a saved server's name links to replace it (change), never to add a server beside it", async (t) => {
  const { origin, token } = await started(t);
  const open = await startFakeMcp();
  t.after(() => open.close());
  assert.equal((await token("PUT", "/settings/mcp-servers/slack", { url: open.url, auth: { type: "none" } })).status, 200);
  const res = await token("PUT", "/settings/mcp-servers/slack/composio", { api_key: fake("composio"), toolkit: "slack", tools: ["SLACK_SEND_MESSAGE"] });
  assert.deepEqual(queryOf(refusedWithLink(res, origin)), { change: "slack", preset: "composio", toolkit: "slack", tools: "SLACK_SEND_MESSAGE" });
});

test("a Composio link carries the toolkit as the preset takes it: trimmed and lower-cased, with Composio's own underscores", async (t) => {
  const { origin, token } = await started(t);
  const upper = await token("PUT", "/settings/mcp-servers/slack/composio", { api_key: fake("composio"), toolkit: " SLACK ", tools: ["SLACK_SEND_MESSAGE"] });
  assert.deepEqual(queryOf(refusedWithLink(upper, origin)), { add: "slack", preset: "composio", toolkit: "slack", tools: "SLACK_SEND_MESSAGE" });
  const listing = await token("POST", "/settings/mcp-servers/composio/tools", { api_key: fake("composio"), toolkit: "google_sheets" });
  // A listing saves nothing: its own words (mcp-secret-writes.ts COMPOSIO_LISTING_REFUSAL), with the same link.
  const listingWords = "Listing Composio's toolkits or tools takes the owner's signed-in session in the console; the API token lists them only on an API-only server, with the key named by api_key_env.";
  assert.deepEqual(queryOf(refusedWithLink(listing, origin, listingWords)), { add: "google-sheets", preset: "composio", toolkit: "google_sheets" });
  // A toolkit the preset would refuse opens the page alone, never the plain form under a Composio name.
  const bad = await token("PUT", "/settings/mcp-servers/slack/composio", { api_key: fake("composio"), toolkit: "not a toolkit" });
  assert.equal(refusedWithLink(bad, origin), `${origin}/#/settings/mcp`);
});

test("every other secret write links to its own page: a trigger's, the webhook's, Slack's, an agent's sign-ins, each settings page", async (t) => {
  const { origin, token } = await started(t);
  // A Slack incoming-webhook URL no Slack has, built from parts: its token, the credential, is a fresh fake.
  const slackToken = fake("slack").replace(/-/g, "");
  const slackUrl = ["https://hooks.slack.com", "services", "TTEST0000", "BTEST0000", slackToken].join("/");
  const pages = [
    ["POST", "/triggers/trg_abc/secret", undefined, "/#/triggers/trg_abc"],
    ["DELETE", "/settings/webhook", undefined, "/#/settings/webhook"],
    ["POST", "/settings/webhook/secret", undefined, "/#/settings/webhook"],
    ["PUT", "/settings/mcp-servers/oauth/private-hosts", { hosts: ["auth.internal.test"] }, "/#/settings/mcp"],
    ["PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: fake("tool") } }, "/#/settings/keys"],
    ["DELETE", "/agents/triage/sign-ins/github", undefined, "/#/agents/triage"],
    ["DELETE", "/integrations/github", undefined, "/#/settings/github"],
    ["PUT", "/workspace/archil", { disk: "d", token: fake("archil") }, "/#/settings/workspace"],
    ["DELETE", "/settings/chatgpt", undefined, "/#/settings/keys"],
    ["PUT", "/settings/slack", { url: slackUrl }, "/#/settings/slack"],
    ["DELETE", "/settings/slack", undefined, "/#/settings/slack"],
  ];
  for (const [method, path, body, page] of pages) {
    const res = await token(method, path, body);
    assert.equal(refusedWithLink(res, origin), `${origin}${page}`, `${method} ${path}`);
    assert.ok(!res.text.includes(slackToken), `${method} ${path}: the refusal never holds Slack's URL`);
  }
});

test("every registered secret write names its console page, or is listed here as having none yet", () => {
  // The console has no page for these yet: their refusal says the one sentence and carries no link.
  const NO_PAGE = new Set(["getCalendar", "saveCalendar", "deleteCalendar", "testCalendar", "getClaudeLogin", "turnOnClaudeLogin", "turnOffClaudeLogin", "startClaudeLogin"]);
  const missing = gate.registeredOperations().filter((op) => !NO_PAGE.has(op) && !gate.hasSecretPage(op));
  assert.deepEqual(missing, [], "each secret write says where in the console it is finished");
  for (const op of NO_PAGE) assert.equal(gate.hasSecretPage(op), false, `${op} has a page now: take it off NO_PAGE`);
});

test("the API document says what a refusal's details hold: console_url, a URI, alone", async () => {
  const { openapiDocument } = await import("../dist/openapi.js");
  const doc = openapiDocument(() => undefined);
  const shape = doc.components.schemas.ErrorBody.properties.details["x-agentrun-serve-details"]?.forbidden;
  assert.deepEqual(shape?.required, ["console_url"]);
  assert.equal(shape.additionalProperties, false);
  assert.equal(shape.properties.console_url.format, "uri");
});

test("the link never carries a value the request sent, whatever the plane: a property over the MCP page builder", async () => {
  const { mcpSecretPage } = await import("../dist/mcp-secret-writes.js");
  const store = { mcp: { server: async () => undefined } };
  const secret = fake("prop");
  const bodies = [
    { url: `https://x.example.test/mcp?token=${secret}`, auth: { type: "bearer", token: secret } },
    { url: `https://${secret}@x.example.test/mcp`, auth: { type: "headers", headers: { [secret]: secret } } },
    { url: "https://x.example.test/mcp", auth: { type: secret, token: secret }, toolkit: secret, client_secret: secret },
    { url: `https://x.example.test/${secret}`, auth: { type: "oauth" } },
  ];
  for (const body of bodies) {
    const page = await mcpSecretPage("saveMcpServer")(body, { params: ["named"], store });
    assert.ok(!page.includes(secret) && !page.includes(encodeURIComponent(secret)), `${JSON.stringify(body)} gave ${page}`);
  }
});
