// The API-only profile (api-only.ts, AGENTRUN_API_ONLY=1): the server serves the run routes alone, for a caller's
// backend, and refuses every other address with a 404 before the request is read further: the console, the store page's
// data, sign-in, setup, settings writes, MCP, triggers and their webhook hooks, agents, and a live view's WebSocket. It
// has no owner. The computer settings' two reads (GET /computers, GET /workspace/archil) are served by the token, their
// writes, tests and key choices refused. So are an agent's learning reads (the loop, promotions, cost per run and a
// run's learning) and its reset (DELETE learning), its learning's other writes and its own texts refused. Off by
// default: the same server without it serves
// those routes as before.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { ended } from "./learn-support.mjs";
import { serve, withEnv } from "./support.mjs";

const { API_ONLY_ENV, API_ONLY_ROUTES, apiOnlyFrom, servedApiOnly } = await import("../dist/api-only.js");
const { ROUTES } = await import("../dist/server.js");
const { banner } = await import("../dist/print.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
/** A password or key for a request the profile refuses before reading it, plainly no secret (as mcp.test.mjs makes them). */
const notSecret = (name) => `not-a-secret-${name}`;
/** The learning reads the profile serves, for the backend whose inline runs made the agent: the loop, the promotions,
 *  the cost per run and a run's learning ({agent}, {run} filled in by each test). */
const LEARNING_READS = ["/v2/agents/{agent}/learning/loop", "/v2/agents/{agent}/learning/promotions", "/v2/agents/{agent}/learning/cost", "/v2/runs/{run}/learning"];
/** The learning routes it still refuses: every write but the reset (served, with the agent's delete), and every read that serves the learning's own text (corrections,
 *  files, the log, a workflow's revisions, the audits, a run's diff). */
const LEARNING_REFUSED = [
  ["GET", "/v2/agents/{agent}/learning"], ["GET", "/v2/agents/{agent}/learning/corrections"], ["PUT", "/v2/agents/{agent}/learning/corrections"],
  ["GET", "/v2/agents/{agent}/learning/log"], ["GET", "/v2/agents/{agent}/learning/audits"],
  ["GET", "/v2/agents/{agent}/learning/files/answer"], ["POST", "/v2/agents/{agent}/learning/files/answer/approve"],
  ["POST", "/v2/agents/{agent}/learning/files/answer/retire"], ["POST", "/v2/agents/{agent}/learning/files/answer/restore"],
  ["GET", "/v2/agents/{agent}/learning/workflows/answer/revisions"], ["POST", "/v2/agents/{agent}/learning/workflows/answer/revisions/d1/replays"],
  ["GET", "/v2/agents/{agent}/learning/workflows/answer/revisions/d1/replays/rp1"], ["GET", "/v2/runs/{run}/learning/diff"],
];
/** `path` with its agent and run filled in. */
const at = (path, agent, run) => path.replace("{agent}", agent).replace("{run}", run);

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
    ["GET", "/v2/runs/run_1/usage"], ["HEAD", "/v2/runs/run_1/usage"],
    ["PUT", "/v2/runs/run_1/grade"], ["POST", "/v2/runs/run_1/messages"], ["POST", "/v2/runs/run_1/stop"], ["POST", "/v2/runs/run_1/cancel"],
    ["GET", "/v2/runs/run_1/files"], ["GET", "/v2/runs/run_1/files/out/report.md"], ["POST", "/v2/files"], ["GET", "/v2/files/file_1"],
    ["GET", "/v2/capabilities"], ["GET", "/v2/health"], ["GET", "/v2/usage"], ["GET", "/v2/capacity"],
    ["GET", "/v2/agents/a1/archil"], ["DELETE", "/v2/agents/a1/archil"], ["DELETE", "/v2/agents/a1"], ["DELETE", "/v2/agents/a1/learning"], ["GET", "/v2/computers/daemon"],
    ["GET", "/v2/computers"], ["HEAD", "/v2/computers"], ["GET", "/v2/workspace/archil"], ["HEAD", "/v2/workspace/archil"],
    ["GET", "/v2/runs/run_1/computer"], ["POST", "/v2/runs/run_1/computer/take-over"], ["POST", "/v2/runs/run_1/computer/hand-back"],
    ["POST", "/v2/runs/run_1/computer/viewer"], ["GET", "/v2/runs/run_1/computer/live/v/x"], ["HEAD", "/v2/runs/run_1/computer/live/computer-viewer.js"],
    ...LEARNING_READS.flatMap((path) => [["GET", at(path, "a1", "run_1")], ["HEAD", at(path, "a1", "run_1")]]),
  ]) assert.equal(served(method, raw), true, `${method} ${raw}`);
  for (const [method, raw] of [
    ["GET", "/"], ["GET", "/assets/index.js"], ["GET", "/llms.txt"],
    ["POST", "/v2/setup"], ["POST", "/v2/auth/sign-in"], ["GET", "/v2/auth/session"],
    ["PUT", "/v2/settings/tool-keys/monid"], ["PUT", "/v2/settings/tools"], ["PUT", "/v2/settings/mcp-servers/x"], ["PUT", "/v2/settings/webhook"], ["GET", "/v2/settings/tools"],
    ["POST", "/v2/mcp"], ["GET", "/v2/triggers"], ["POST", "/v2/triggers"], ["POST", "/v2/hooks/trg_1"],
    ["GET", "/v2/agents"], ["POST", "/v2/agents"], ["DELETE", "/v2/runs/run_1"], ["POST", "/v2/runs/run_1/approvals/a"], ["GET", "/v2/runs/run_1/browser"], ["POST", "/v2/runs/run_1/kill"],
    ["GET", "/v2/runs/run_1/browser/live/v/x"], ["POST", "/v2/runs/run_1/computer/live/v/x"], ["POST", "/v2/runs/run_1/computer/call"], ["POST", "/v2/runs/run_1/computer/release"],
    ["GET", "/v2/openapi.json"], ["POST", "/v2/templates/x/apply"], ["GET", "/v2/v2/runs"],
    ["POST", "/v2/computers/pairings"], ["POST", "/v2/computers/pair"], ["GET", "/v2/computers/attach"],
    ["PUT", "/v2/computers/e2b/keys"], ["POST", "/v2/computers/e2b/test"], ["GET", "/v2/computers/e2b/choices"], ["DELETE", "/v2/computers/pc_1"],
    ["PUT", "/v2/workspace/archil"], ["DELETE", "/v2/workspace/archil"], ["POST", "/v2/workspace/archil/test"],
    ...LEARNING_REFUSED.map(([method, path]) => [method, at(path, "a1", "run_1")]),
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

test("an API-only server serves a run's usage lines with the token, and still refuses a settings route", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { apiOnly: true });
  const inline = await send(server, "POST", "/v2/runs", { body: { external: { source: "backend", kind: "expert", id: "usage-1", version: 1 }, definition: { name: "Counter", instructions: "Answer the question.", skills: [], tools: [], harness: "pi" }, input: { content: "What is six times seven." } } });
  assert.equal(inline.status, 202, JSON.stringify(inline.body));
  const { run_id: run } = inline.body;
  await ended(server.api, run);

  const usage = await send(server, "GET", `/v2/runs/${run}/usage`);
  assert.equal(usage.status, 200, JSON.stringify(usage.body));
  assert.ok(Array.isArray(usage.body.lines), "its lines");
  const read = await send(server, "GET", `/v2/runs/${run}`);
  assert.equal(usage.body.total?.usd ?? null, read.body.cost?.usd ?? null, "its total is the run read's cost.usd");
  assert.equal((await send(server, "GET", `/v2/runs/${run}/usage`, { token: false })).status, 401, "and still takes the token");
  const missing = await send(server, "GET", "/v2/runs/run_missing/usage");
  assert.equal(missing.status, 404, "a run it does not have is the route's own 404");
  assert.notEqual(missing.body.error?.message?.includes("AGENTRUN_API_ONLY"), true, "not the profile's");

  const settings = await send(server, "GET", "/v2/settings/tools");
  assert.deepEqual([settings.status, settings.body.error?.message], [404, "this server serves the run API only (AGENTRUN_API_ONLY=1): /v2/settings/tools is not served here"], "a settings route is the profile's 404");
});

test("an API-only server serves an agent's Archil disk, read and removed, with the token", async (t) => {
  const server = await serve(t, { apiOnly: true, runner: false });
  const inline = await send(server, "POST", "/v2/runs", { body: { external: { source: "grep", kind: "expert", id: "9", version: 1 }, definition: { name: "Expert 9", instructions: "Answer.", skills: [], tools: [] }, input: { content: "Hi" } } });
  assert.equal(inline.status, 202, JSON.stringify(inline.body));
  const agent = inline.body.agent_id;
  const read = await send(server, "GET", `/v2/agents/${agent}/archil`);
  assert.deepEqual([read.status, read.body], [200, { on: false, archil_disk: null }], "Mode 1: no disk");
  const removed = await send(server, "DELETE", `/v2/agents/${agent}/archil`);
  assert.deepEqual([removed.status, removed.body], [200, { on: false, archil_disk: null, removed: null }], "nothing to remove");
  assert.equal((await send(server, "GET", "/v2/agents/agent_missing/archil")).status, 404, "an agent it does not have is the route's own 404");
  assert.equal((await send(server, "GET", `/v2/agents/${agent}/archil`, { token: false })).status, 401, "and takes the token");
});

test("an API-only server serves an inline-run agent's learning reads with the token (loop, promotions, cost, a run's learning), and refuses its learning's writes and texts", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { apiOnly: true, learning: "on" });
  const inline = await send(server, "POST", "/v2/runs", { body: { external: { source: "backend", kind: "expert", id: "learner-1", version: 1 }, definition: { name: "Learner", instructions: "Answer the question.", skills: [], tools: [], harness: "pi", learning: true }, input: { content: "What is six times seven." } } });
  assert.equal(inline.status, 202, JSON.stringify(inline.body));
  const { agent_id: agent, run_id: run } = inline.body;
  // The run ends, then its learning (the look-back the runner beside the server runs): both read by the token.
  await ended(server.api, run);

  const [loop, promotions, cost, learning] = await Promise.all(LEARNING_READS.map((path) => send(server, "GET", at(path, agent, run))));
  assert.equal(loop.status, 200, JSON.stringify(loop.body));
  assert.deepEqual([loop.body.agent, loop.body.completed_runs, Array.isArray(loop.body.compiles)], [agent, 1, true], "the loop: its one completed run");
  assert.deepEqual([promotions.status, promotions.body], [200, { agent, promotions: [], serving: [] }], "the promotions: none yet");
  assert.equal(cost.status, 200, JSON.stringify(cost.body));
  assert.deepEqual([cost.body.agent, cost.body.runs.map((one) => one.run_id)], [agent, [run]], "the cost per run: the run");
  assert.equal(learning.status, 200, JSON.stringify(learning.body));
  assert.equal(learning.body.run, run, "the run's learning");
  assert.ok(["merged", "dropped"].includes(learning.body.state), JSON.stringify(learning.body));
  const csv = await fetch(`${server.url}${at(LEARNING_READS[2], agent, run)}?format=csv`, { headers: { authorization: `Bearer ${server.token}` } });
  assert.deepEqual([csv.status, csv.headers.get("content-type"), (await csv.text()).includes(run)], [200, "text/csv; charset=utf-8", true], "the cost per run as CSV");

  for (const path of LEARNING_READS) {
    const refused = await send(server, "GET", at(path, agent, run), { token: false });
    assert.deepEqual([refused.status, refused.body.error?.code], [401, "unauthenticated"], `${path} without the token`);
    const wrong = await fetch(`${server.url}${at(path, agent, run)}`, { headers: { authorization: `Bearer ${notSecret("token")}` } });
    assert.equal(wrong.status, 401, `${path} with a token the server does not take`);
  }
  assert.equal((await send(server, "GET", at(LEARNING_READS[0], "agent_missing", run))).status, 404, "an agent it does not have is the route's own 404");
  assert.equal((await send(server, "GET", at(LEARNING_READS[3], agent, "run_missing"))).status, 404, "a run it does not have is the route's own 404");

  for (const [method, path] of LEARNING_REFUSED) {
    const raw = at(path, agent, run);
    const answer = await send(server, method, raw, method === "GET" ? {} : { body: method === "PUT" ? undefined : {}, headers: method === "PUT" ? { "content-type": "text/markdown" } : {} });
    assert.equal(answer.status, 404, `${method} ${raw}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.error?.message, `this server serves the run API only (AGENTRUN_API_ONLY=1): ${raw} is not served here`, `${method} ${raw} is the profile's refusal`);
  }
});

test("an API-only server serves the computers list and the Archil settings with the token: key names and saved or not, never a value", async (t) => {
  // A computer key and the Archil account key planted, sealed under a seal key the test knows, and the Archil settings in
  // the server's environment: neither answer may carry a planted value, a sealed blob, the seal key or the token.
  const sealKey = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey.toString("base64"), AGENTRUN_ARCHIL_REGION: "aws-us-east-1", AGENTRUN_ARCHIL_S3_URL: "https://s3.archil.example" }, ["AGENTRUN_SEAL_KEY", "ARCHIL_API_KEY", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE", "FAUX_SANDBOX_KEY"]);
  const server = await serve(t, { apiOnly: true, runner: false });
  // Each sealed row and the value planted in it.
  const planted = [["FAUX_SANDBOX_KEY", "fake-test-key-planted-computer-0001"], [ARCHIL_API_KEY_ROW, "fake-test-key-planted-archil-0001"]];
  for (const [row, value] of planted) await putSealedKey(server.store, sealKey, row, value);
  // Each sealed row's bytes as an answer could carry them: base64 and hex.
  const sealed = (await Promise.all(planted.map(([row]) => server.store.sealedKeys.get(row)))).map((bytes) => Buffer.from(bytes));
  const never = [...planted.map(([, value]) => value), ...sealed.flatMap((bytes) => [bytes.toString("base64"), bytes.toString("hex")]), sealKey.toString("base64"), server.token];

  const computers = await send(server, "GET", "/v2/computers");
  assert.equal(computers.status, 200, JSON.stringify(computers.body));
  const sandbox = computers.body.kinds.flatMap((kind) => kind.providers).find((one) => one.id === "faux-sandbox");
  assert.deepEqual([sandbox.secrets[0].name, sandbox.secrets[0].set, sandbox.secrets[0].source, typeof sandbox.ready], ["computer:faux-sandbox:FAUX_SANDBOX_KEY", true, "console", "boolean"], "the key's name and saved, and whether the provider is ready");
  const archil = await send(server, "GET", "/v2/workspace/archil");
  assert.equal(archil.status, 200, JSON.stringify(archil.body));
  assert.deepEqual(archil.body, { on: true, source: "env", region: "aws-us-east-1", s3Url: "https://s3.archil.example", secret: { name: "workspace:archil", set: true, source: "console", changed_at: archil.body.secret.changed_at } });
  for (const [what, answer] of [["computers", computers], ["archil", archil]]) {
    const text = JSON.stringify(answer.body);
    for (const value of never) assert.ok(!text.includes(value), `${what} carries no planted value, sealed blob, seal key or token`);
  }

  for (const path of ["/v2/computers", "/v2/workspace/archil"]) {
    const refused = await send(server, "GET", path, { token: false });
    assert.equal(refused.status, 401, `${path} without the token`);
    assert.equal(refused.body.error?.code, "unauthenticated");
  }
});

test("an API-only server's computers list says the run's folder each provider's computer holds: a bind in Mode 1 where it binds this machine's, else null", async (t) => {
  withEnv(t, {}, ["ARCHIL_API_KEY", "AGENTRUN_ARCHIL_REGION", "AGENTRUN_ARCHIL_S3_URL", "AGENTRUN_ARCHIL_IMAGE"]);
  const server = await serve(t, { apiOnly: true, runner: false });
  const computers = await send(server, "GET", "/v2/computers");
  assert.equal(computers.status, 200, JSON.stringify(computers.body));
  const folderOf = (kind, id) => computers.body.kinds.find((one) => one.kind === kind).providers.find((one) => one.id === id).folder;
  assert.deepEqual([folderOf("sandbox", "faux-sandbox"), folderOf("desktop", "faux-desktop")], ["bind", null], "Mode 1: the faux sandbox binds this machine's folder; the faux desktop takes none");
  for (const row of computers.body.kinds.flatMap((kind) => kind.providers)) assert.ok(["bind", "archil", "sync", null].includes(row.folder), `${row.id}: ${JSON.stringify(row.folder)}`);
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
  ["the Archil settings' save", "PUT", "/v2/workspace/archil", { body: { region: "aws-us-east-1", s3Url: "https://s3.archil.example", keys: { ARCHIL_API_KEY: notSecret("key") } } }],
  ["Archil turned off", "DELETE", "/v2/workspace/archil", {}],
  ["the Archil settings' test", "POST", "/v2/workspace/archil/test", {}],
  ["a computer key's save", "PUT", "/v2/computers/faux-sandbox/keys", { body: { FAUX_SANDBOX_KEY: notSecret("key") } }],
  ["a computer provider's test", "POST", "/v2/computers/faux-sandbox/test", {}],
  ["a computer key's choices", "GET", "/v2/computers/faux-sandbox/choices", {}],
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
