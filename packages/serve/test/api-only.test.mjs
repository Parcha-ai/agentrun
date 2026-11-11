// The API-only profile (api-only.ts, AGENTRUN_API_ONLY=1): the server serves the run routes alone, for a caller's
// backend, and refuses every other address with a 404 before the request is read further: the console, the store page's
// data, sign-in, setup, settings writes, MCP, triggers and their webhook hooks, agents, and a live view's WebSocket. It
// has no owner. Off by default: the same server without it serves those routes as before.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { serve } from "./support.mjs";

const { API_ONLY_ENV, API_ONLY_ROUTES, apiOnlyFrom, servedApiOnly } = await import("../dist/api-only.js");
const { ROUTES } = await import("../dist/server.js");
const { banner } = await import("../dist/print.js");
/** A password or key for a request the profile refuses before reading it, plainly no secret (as mcp.test.mjs makes them). */
const notSecret = (name) => `not-a-secret-${name}`;

test("AGENTRUN_API_ONLY is on for 1 or true, off when unset, empty, 0 or false, and refused in words otherwise", () => {
  assert.equal(API_ONLY_ENV, "AGENTRUN_API_ONLY");
  for (const value of ["1", "true", "TRUE", " 1 "]) assert.equal(apiOnlyFrom({ AGENTRUN_API_ONLY: value }), true, value);
  for (const value of [undefined, "", "0", "false", "False"]) assert.equal(apiOnlyFrom(value === undefined ? {} : { AGENTRUN_API_ONLY: value }), false, String(value));
  for (const value of ["yes", "on", "2", "api"]) {
    assert.throws(() => apiOnlyFrom({ AGENTRUN_API_ONLY: value }), (error) => error instanceof TypeError && error.message === `AGENTRUN_API_ONLY is 1 (serve the run API only) or 0 (the whole server), not ${JSON.stringify(value)}`, value);
  }
});

test("every route the profile serves is a route of the server", () => {
  const names = new Set(ROUTES.map((route) => route.name));
  for (const name of API_ONLY_ROUTES) assert.ok(names.has(name), `${name} is in ROUTES`);
});

test("the profile serves a run's routes by method and path, and nothing else", () => {
  const served = (method, raw) => servedApiOnly(ROUTES, method, raw);
  for (const [method, raw] of [
    ["POST", "/v2/agents/a1/runs"], ["POST", "/v2/runs"], ["GET", "/v2/runs"], ["GET", "/v2/agents/a1/runs"],
    ["GET", "/v2/runs/run_1"], ["HEAD", "/v2/runs/run_1"], ["PATCH", "/v2/runs/run_1"], ["GET", "/v2/runs/run_1/timeline"],
    ["POST", "/v2/runs/run_1/messages"], ["POST", "/v2/runs/run_1/stop"], ["POST", "/v2/runs/run_1/cancel"], ["POST", "/v2/runs/run_1/kill"],
    ["GET", "/v2/runs/run_1/files"], ["GET", "/v2/runs/run_1/files/out/report.md"], ["POST", "/v2/files"], ["GET", "/v2/files/file_1"],
    ["GET", "/v2/capabilities"], ["GET", "/v2/health"], ["GET", "/v2/usage"],
  ]) assert.equal(served(method, raw), true, `${method} ${raw}`);
  for (const [method, raw] of [
    ["GET", "/"], ["GET", "/assets/index.js"], ["GET", "/llms.txt"],
    ["POST", "/v2/setup"], ["POST", "/v2/auth/sign-in"], ["GET", "/v2/auth/session"],
    ["PUT", "/v2/settings/tool-keys/monid"], ["PUT", "/v2/settings/tools"], ["PUT", "/v2/settings/mcp-servers/x"], ["PUT", "/v2/settings/webhook"], ["GET", "/v2/settings/tools"],
    ["POST", "/v2/mcp"], ["GET", "/v2/triggers"], ["POST", "/v2/triggers"], ["POST", "/v2/hooks/trg_1"],
    ["GET", "/v2/agents"], ["POST", "/v2/agents"], ["DELETE", "/v2/runs/run_1"], ["POST", "/v2/runs/run_1/approvals/a"], ["GET", "/v2/runs/run_1/browser"],
    ["GET", "/v2/openapi.json"], ["POST", "/v2/templates/x/apply"], ["GET", "/v2/v2/runs"],
  ]) assert.equal(served(method, raw), false, `${method} ${raw}`);
});

/** One request to `server` (its path from the root, the token unless `token` is false): its status and body. */
async function send(server, method, path, { token = true, body, headers = {} } = {}) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    redirect: "manual",
    headers: { ...(token ? { authorization: `Bearer ${server.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json ?? text };
}

test("an API-only server serves a run's routes with the token", async (t) => {
  const server = await serve(t, { apiOnly: true, runner: false });
  assert.equal((await send(server, "GET", "/v2/health", { token: false })).status, 200, "health");
  assert.equal((await send(server, "GET", "/v2/capabilities")).status, 200, "capabilities");
  const runs = await send(server, "GET", "/v2/runs");
  assert.equal(runs.status, 200, `the runs list: ${JSON.stringify(runs.body)}`);
  assert.equal((await send(server, "GET", "/v2/usage")).status, 200, "usage");
  assert.equal((await send(server, "GET", "/v2/runs/run_missing")).status, 404, "a run it does not have is the route's own 404");
  assert.notEqual((await send(server, "GET", "/v2/runs/run_missing")).body.error?.message?.includes("AGENTRUN_API_ONLY"), true, "not the profile's");
  assert.equal((await send(server, "GET", "/v2/runs", { token: false })).status, 401, "and still takes the token");
});

const REFUSED = [
  ["the console", "GET", "/", { token: false, headers: { accept: "text/html" } }],
  ["the console's assets", "GET", "/assets/index.js", { token: false }],
  ["setup", "POST", "/v2/setup", { token: false, body: { password: notSecret("password"), code: notSecret("code") }, headers: { origin: "http://127.0.0.1" } }],
  ["sign-in", "POST", "/v2/auth/sign-in", { token: false, body: { password: notSecret("password") } }],
  ["the session", "GET", "/v2/auth/session", {}],
  ["a settings write", "PUT", "/v2/settings/tools", { body: { web_search: "parallel" } }],
  ["a tool key write", "PUT", "/v2/settings/tool-keys/monid", { body: { fields: { MONID_API_KEY: notSecret("key") } } }],
  ["MCP", "POST", "/v2/mcp", { body: { jsonrpc: "2.0", id: 1, method: "ping" }, headers: { accept: "application/json, text/event-stream" } }],
  ["triggers", "GET", "/v2/triggers", {}],
  ["a trigger made", "POST", "/v2/triggers", { body: { agent_id: "a1" } }],
  ["a webhook hook", "POST", "/v2/hooks/trg_1", { token: false, body: {} }],
  ["agents", "GET", "/v2/agents", {}],
  ["llms.txt", "GET", "/llms.txt", { token: false }],
];

for (const [what, method, path, options] of REFUSED) {
  test(`an API-only server refuses ${what} (${method} ${path}) with 404 naming the profile`, async (t) => {
    const server = await serve(t, { apiOnly: true, runner: false });
    const answer = await send(server, method, path, options);
    assert.equal(answer.status, 404, `${method} ${path}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.error?.code, "not_found");
    assert.equal(answer.body.error?.message, `this server serves the run API only (AGENTRUN_API_ONLY=1): ${path} is not served here`);
  });
}

test("an API-only server refuses a live view's WebSocket", async (t) => {
  const server = await serve(t, { apiOnly: true, runner: false });
  const status = await new Promise((resolve, reject) => {
    const req = request(`${server.url}/v2/runs/run_1/browser/live/v/${"a".repeat(22)}/ws`, { headers: { connection: "Upgrade", upgrade: "websocket", origin: server.url, "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    req.on("response", (res) => (res.resume(), resolve(res.statusCode)));
    req.on("upgrade", (_res, socket) => (socket.destroy(), resolve(101)));
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 404);
});

test("an API-only server has no owner, even when accounts are asked for", async (t) => {
  const server = await serve(t, { apiOnly: true, accounts: true, openSetup: true, runner: false });
  assert.equal(server.setupUrl, undefined, "no setup link");
  assert.equal((await send(server, "POST", "/v2/setup", { token: false, body: { password: notSecret("password") }, headers: { origin: server.url } })).status, 404);
  assert.equal((await send(server, "GET", "/v2/runs")).status, 200, "the token opens the run routes");
});

test("off by default: the same routes are served without the profile", async (t) => {
  const server = await serve(t, { runner: false });
  assert.equal((await send(server, "GET", "/v2/agents")).status, 200, "agents");
  assert.equal((await send(server, "GET", "/v2/triggers")).status, 200, "triggers");
  assert.equal((await send(server, "GET", "/v2/runs")).status, 200, "runs");
});

test("the banner says the server is API-only in place of the console's link", () => {
  const lines = banner({ url: "http://127.0.0.1:7340", baseUrl: "http://127.0.0.1:7340/v2", data: "/data", token: "x".repeat(32), source: "env", apiOnly: true });
  assert.ok(lines.includes("API only (AGENTRUN_API_ONLY=1): the run routes are served; the console, sign-in, setup, settings, MCP, triggers and hooks are refused."), lines.join("\n"));
  assert.ok(!lines.some((line) => line.startsWith("Open ")), "no console link");
});
