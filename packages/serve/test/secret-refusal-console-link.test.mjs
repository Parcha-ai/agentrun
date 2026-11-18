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
import { call, serve, withEnv } from "./support.mjs";

const gate = await import("../dist/secret-writes.js");
// The planes register their operations as their modules load: the server's own imports, as a started server has them.
await import("../dist/server.js");

const json = { "content-type": "application/json" };
/** A fake credential, made fresh each run: none of these is a real token. */
const fake = (label) => `not-a-secret-${label}-${randomBytes(12).toString("hex")}`;

async function started(t) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { runner: false });
  const origin = `http://127.0.0.1:${server.port}`;
  const token = (method, path, body) => call(server.port, { method, path: `/v2${path}`, headers: { ...(body !== undefined ? json : {}), authorization: `Bearer ${server.token}` }, ...(body !== undefined ? { body } : {}) });
  return { server, origin, token };
}

/** The refusal `res` is: 403 forbidden in the one sentence, then "Finish it in the console: <link>", the link also in
 *  details.console_url. Answers the link. */
function refusedWithLink(res, origin) {
  assert.equal(res.status, 403, res.text);
  assert.equal(res.json?.error?.code, "forbidden");
  const { message, details } = res.json.error;
  const link = details?.console_url;
  assert.equal(typeof link, "string", `details.console_url: ${res.text}`);
  assert.ok(link.startsWith(`${origin}/#/`), `the link is on the console's own address: ${link}`);
  assert.equal(message, `${gate.SECRET_WRITE_REFUSAL} Finish it in the console: ${link}`);
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
  };
  for (const [what, url] of Object.entries(urls)) {
    const res = await token("PUT", "/settings/mcp-servers/leaky", { url, auth: { type: "bearer", token: fake("bearer") } });
    const link = refusedWithLink(res, origin);
    assert.deepEqual(queryOf(link), { add: "leaky", auth: "bearer" }, `${what}: ${link}`);
    for (const part of [secret, key, "ghp_"]) assert.ok(!link.includes(part), `${what}: the link holds none of the URL: ${link}`);
  }
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

test("every other secret write links to its own page: a trigger's, the webhook's, an agent's sign-ins, each settings page", async (t) => {
  const { origin, token } = await started(t);
  const pages = [
    ["POST", "/triggers/trg_abc/secret", undefined, "/#/triggers/trg_abc"],
    ["DELETE", "/settings/webhook", undefined, "/#/settings/webhook"],
    ["PUT", "/settings/mcp-servers/oauth/private-hosts", { hosts: ["auth.internal.test"] }, "/#/settings/mcp"],
    ["PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: fake("tool") } }, "/#/settings/keys"],
    ["DELETE", "/agents/triage/sign-ins/github", undefined, "/#/agents/triage"],
    ["DELETE", "/integrations/github", undefined, "/#/settings/github"],
    ["PUT", "/workspace/archil", { disk: "d", token: fake("archil") }, "/#/settings/workspace"],
    ["DELETE", "/settings/chatgpt", undefined, "/#/settings/keys"],
  ];
  for (const [method, path, body, page] of pages) {
    const res = await token(method, path, body);
    assert.equal(refusedWithLink(res, origin), `${origin}${page}`, `${method} ${path}`);
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
