// The API-only profile (api-only.ts, AGENTRUN_API_ONLY=1): the server serves the run routes and a deploy's routes alone
// (api-only-deploy.test.mjs), for a caller's backend, and refuses every other address with a 404 before the request is
// read further: the console, the store page's data, sign-in, setup, settings writes, the MCP endpoint, the trigger routes
// but their reads and turn on or off (api-only-deploy.test.mjs) and a firing's release, their webhook hooks, the agents
// list and their writes, and a live view's WebSocket. It has no owner. Its token saves a
// Composio server by api_key_env and a per_run server at an origin AGENTRUN_API_ONLY_MCP_ORIGINS lists, deletes a server,
// and lists the servers' names (GET /settings/mcp-server-names); their list, read, any other save, previews, refreshes
// and sign-ins are refused (api-only-mcp.test.mjs). The computer settings' two reads (GET /computers, GET /workspace/archil) are served by the token, their
// writes, tests and key choices refused. So are an agent's learning reads (the loop, promotions, cost per run and a
// run's learning) and its reset (DELETE learning), its learning's other writes and its own texts refused. A run's purge
// (DELETE /runs/{id}) is served wherever the agent's delete is: for a run of an agent its backend made (an inline run's,
// external) and of an agent made here. Off by default: the same server without it serves those routes as before.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { ended } from "./learn-support.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { follow, serve, startRun, WINDOW, withEnv } from "./support.mjs";

const { API_ONLY_ROUTES, servedApiOnly } = await import("../dist/api-only.js");
const { mintSecret } = await import("../dist/standard-webhooks.js");
const { API_ONLY_ENV, switchFrom } = await import("../dist/env-switch.js");
const { ROUTES } = await import("../dist/server.js");
const { banner } = await import("../dist/print.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { ARCHIL_API_KEY_ROW } = await import("../dist/workspace/index.js");
/** A password or key for a request the profile refuses before reading it, plainly no secret (as mcp.test.mjs makes them). */
const notSecret = (name) => `not-a-secret-${name}`;
/** The learning reads the profile serves, for the backend whose inline runs made the agent: the loop, the promotions,
 *  the cost per run, a run's learning and the audits, which its Learning tab reads ({agent}, {run} filled in by each
 *  test). */
const LEARNING_READS = ["/v2/agents/{agent}/learning/loop", "/v2/agents/{agent}/learning/promotions", "/v2/agents/{agent}/learning/cost", "/v2/runs/{run}/learning", "/v2/agents/{agent}/learning/audits"];
/** The learning routes it still refuses: every write but the reset (served, with the agent's delete), and every read that serves the learning's own text (corrections,
 *  files, the log, a workflow's revisions, a run's diff). */
const LEARNING_REFUSED = [
  ["GET", "/v2/agents/{agent}/learning"], ["GET", "/v2/agents/{agent}/learning/corrections"], ["PUT", "/v2/agents/{agent}/learning/corrections"],
  ["GET", "/v2/agents/{agent}/learning/log"],
  ["GET", "/v2/agents/{agent}/learning/files/answer"], ["POST", "/v2/agents/{agent}/learning/files/answer/approve"],
  ["POST", "/v2/agents/{agent}/learning/files/answer/retire"], ["POST", "/v2/agents/{agent}/learning/files/answer/restore"],
  ["GET", "/v2/agents/{agent}/learning/workflows/answer/revisions"], ["POST", "/v2/agents/{agent}/learning/workflows/answer/revisions/d1/replays"],
  ["GET", "/v2/agents/{agent}/learning/workflows/answer/revisions/d1/replays/rp1"], ["GET", "/v2/runs/{run}/learning/diff"],
];
/** `path` with its agent and run filled in. */
const at = (path, agent, run) => path.replace("{agent}", agent).replace("{run}", run);

test("AGENTRUN_API_ONLY is on for 1 or true, off when unset, empty, 0 or false, and refused in words otherwise", () => {
  assert.equal(API_ONLY_ENV, "AGENTRUN_API_ONLY");
  const read = (value) => switchFrom(API_ONLY_ENV, value === undefined ? {} : { AGENTRUN_API_ONLY: value });
  for (const value of ["1", "true", "TRUE", " 1 "]) assert.equal(read(value), true, value);
  for (const value of [undefined, "", "0", "false", "False"]) assert.equal(read(value), false, String(value));
  for (const value of ["yes", "on", "2", "api"]) {
    assert.throws(() => read(value), (error) => error instanceof TypeError && error.message.startsWith("AGENTRUN_API_ONLY ") && error.message.includes(JSON.stringify(value)), value);
  }
});

test("every route the profile serves is a route of the server", () => {
  const names = new Set(ROUTES.map((route) => route.name));
  for (const name of API_ONLY_ROUTES) assert.ok(names.has(name), `${name} is in ROUTES`);
});

test("with the operator's MCP origins named, the profile also serves the generic MCP save and the preview (each body checked at its route), and no other MCP settings route", () => {
  const served = (method, raw, mcpSave) => servedApiOnly(ROUTES, method, raw, mcpSave);
  for (const [method, raw] of [["PUT", "/v2/settings/mcp-servers/x"], ["POST", "/v2/settings/mcp-servers/preview"]]) {
    assert.deepEqual([served(method, raw, false), served(method, raw, true)], [false, true], `${method} ${raw}`);
  }
  for (const [method, raw] of [
    ["GET", "/v2/settings/mcp-servers"], ["GET", "/v2/settings/mcp-servers/x"],
    ["POST", "/v2/settings/mcp-servers/x/refresh"], ["POST", "/v2/settings/mcp-servers/x/oauth/start"], ["GET", "/v2/settings/mcp-servers/preview"],
  ]) assert.equal(served(method, raw, true), false, `${method} ${raw}`);
});

test("the profile serves a run's routes by method and path, and nothing else", () => {
  const served = (method, raw) => servedApiOnly(ROUTES, method, raw);
  for (const [method, raw] of [
    ["POST", "/v2/agents/a1/runs"], ["POST", "/v2/runs"], ["GET", "/v2/runs"], ["GET", "/v2/agents/a1/runs"],
    ["GET", "/v2/runs/run_1"], ["HEAD", "/v2/runs/run_1"], ["PATCH", "/v2/runs/run_1"], ["GET", "/v2/runs/run_1/timeline"],
    ["GET", "/v2/runs/run_1/usage"], ["HEAD", "/v2/runs/run_1/usage"],
    ["PUT", "/v2/runs/run_1/grade"], ["POST", "/v2/runs/run_1/messages"], ["POST", "/v2/runs/run_1/stop"], ["POST", "/v2/runs/run_1/cancel"],
    ["GET", "/v2/runs/run_1/files"], ["GET", "/v2/runs/run_1/files/out/report.md"], ["POST", "/v2/files"], ["GET", "/v2/files/file_1"],
    ["GET", "/v2/capabilities"], ["GET", "/v2/settings/mcp-server-names"], ["GET", "/v2/settings/prices"], ["GET", "/v2/health"], ["GET", "/v2/usage"], ["GET", "/v2/capacity"], ["POST", "/v2/templates/import"],
    ["GET", "/v2/agents/a1/archil"], ["DELETE", "/v2/agents/a1/archil"], ["DELETE", "/v2/agents/a1"], ["DELETE", "/v2/agents/a1/learning"], ["DELETE", "/v2/runs/run_1"], ["GET", "/v2/computers/daemon"],
    ["GET", "/v2/computers"], ["HEAD", "/v2/computers"], ["GET", "/v2/workspace/archil"], ["HEAD", "/v2/workspace/archil"],
    ["GET", "/v2/runs/run_1/computer"], ["POST", "/v2/runs/run_1/computer/take-over"], ["POST", "/v2/runs/run_1/computer/hand-back"],
    ["POST", "/v2/runs/run_1/computer/viewer"], ["GET", "/v2/runs/run_1/computer/live/v/x"], ["HEAD", "/v2/runs/run_1/computer/live/computer-viewer.js"],
    ...LEARNING_READS.flatMap((path) => [["GET", at(path, "a1", "run_1")], ["HEAD", at(path, "a1", "run_1")]]),
    // A deploy's routes: a template's apply, the agent's read, its revisions, its current revision moved back, and its
    // archive (and unarchive) before its delete.
    ["POST", "/v2/templates/x/apply"], ["GET", "/v2/agents/a1"], ["HEAD", "/v2/agents/a1"], ["GET", "/v2/agents/a1/revisions"],
    ["POST", "/v2/agents/a1/current"], ["POST", "/v2/agents/a1/archive"], ["POST", "/v2/agents/a1/unarchive"],
    // The MCP servers a deploy's agents need: a Composio server saved through the preset, and a server deleted. Their
    // names are listed by GET /settings/mcp-server-names, above.
    ["PUT", "/v2/settings/mcp-servers/x/composio"], ["DELETE", "/v2/settings/mcp-servers/x"],
    // Composio's catalog for that save, its key named by api_key_env (a key sent is 403: mcp-secret-writes.ts).
    ["POST", "/v2/settings/mcp-servers/composio/toolkits"], ["POST", "/v2/settings/mcp-servers/composio/tools"],
    // A trigger's reads and its turn on or off (PATCH takes `enabled` alone here), for one auto-paused to be seen and
    // turned on again: an API-only server has no console to do it in.
    ["GET", "/v2/triggers"], ["HEAD", "/v2/triggers"], ["GET", "/v2/triggers/trg_1"], ["GET", "/v2/triggers/trg_1/firings"], ["PATCH", "/v2/triggers/trg_1"],
    // The launch hook's host releases a firing it took and will start no run for.
    ["POST", "/v2/triggers/trg_1/firings/fir_1/release"],
    // An ended run's share bundle (`agentrun share`'s one request, its ?restore= on the same route), cut as the console's.
    ["GET", "/v2/runs/run_1/export"], ["HEAD", "/v2/runs/run_1/export"],
  ]) assert.equal(served(method, raw), true, `${method} ${raw}`);
  for (const [method, raw] of [
    ["GET", "/"], ["GET", "/assets/index.js"], ["GET", "/llms.txt"],
    ["POST", "/v2/setup"], ["POST", "/v2/auth/sign-in"], ["GET", "/v2/auth/session"],
    ["PUT", "/v2/settings/tool-keys/monid"], ["PUT", "/v2/settings/tools"], ["PUT", "/v2/settings/webhook"], ["GET", "/v2/settings/tools"],
    ["POST", "/v2/settings/mcp-servers/preview"], ["POST", "/v2/settings/mcp-servers/x/refresh"],
    ["POST", "/v2/settings/mcp-servers/x/oauth/start"], ["GET", "/v2/settings/mcp-servers/x/composio/events"], ["PUT", "/v2/settings/mcp-servers/oauth/private-hosts"],
    // No list or read of the MCP servers (their names route is the listing), and no save of a server at an address or
    // with headers of the caller's own.
    ["GET", "/v2/settings/mcp-servers"], ["GET", "/v2/settings/mcp-servers/x"], ["HEAD", "/v2/settings/mcp-servers/x"], ["PUT", "/v2/settings/mcp-servers/x"],
    ["POST", "/v2/mcp"], ["POST", "/v2/triggers"], ["POST", "/v2/hooks/trg_1"],
    ["GET", "/v2/agents"], ["POST", "/v2/agents"], ["POST", "/v2/runs/run_1/approvals/a"], ["GET", "/v2/runs/run_1/browser"], ["POST", "/v2/runs/run_1/kill"],
    ["GET", "/v2/runs/run_1/browser/live/v/x"], ["POST", "/v2/runs/run_1/computer/live/v/x"], ["POST", "/v2/runs/run_1/computer/call"], ["POST", "/v2/runs/run_1/computer/release"],
    ["GET", "/v2/openapi.json"], ["GET", "/v2/v2/runs"],
    ["GET", "/v2/templates"], ["DELETE", "/v2/templates/x"], ["PUT", "/v2/agents/a1/definition"],
    ["DELETE", "/v2/triggers/trg_1"], ["PUT", "/v2/triggers/trg_1"],
    ["POST", "/v2/triggers/trg_1/fire"], ["POST", "/v2/triggers/trg_1/secret"], ["POST", "/v2/hooks/composio/p1"],
    ["GET", "/v2/triggers/trg_1/firings/fir_1/release"], ["POST", "/v2/triggers/trg_1/firings/fir_1"],
    ["POST", "/v2/computers/pairings"], ["POST", "/v2/computers/pair"], ["GET", "/v2/computers/attach"],
    ["PUT", "/v2/computers/e2b/keys"], ["POST", "/v2/computers/e2b/test"], ["GET", "/v2/computers/e2b/choices"], ["DELETE", "/v2/computers/pc_1"],
    ["PUT", "/v2/workspace/archil"], ["DELETE", "/v2/workspace/archil"], ["POST", "/v2/workspace/archil/test"],
    // The share preview is the console's page (an owner's session, which no one has here), and the graph and trace stay
    // refused as routes of their own: the export carries a workflow run's graph cut, as the share page shows it.
    ["GET", "/share/run_1"], ["GET", "/share/run_1/"], ["POST", "/v2/runs/run_1/export"], ["GET", "/v2/runs/run_1/export/x"],
    ["GET", "/v2/runs/run_1/graph"], ["GET", "/v2/runs/run_1/trace"],
    ...LEARNING_REFUSED.map(([method, path]) => [method, at(path, "a1", "run_1")]),
  ]) assert.equal(served(method, raw), false, `${method} ${raw}`);
});

test("with the launch hook the profile serves a POST to one trigger's hook as well, and no path under a hook", () => {
  const hooked = (method, raw) => servedApiOnly(ROUTES, method, raw, false, true);
  assert.equal(hooked("POST", "/v2/hooks/trg_1"), true);
  assert.equal(servedApiOnly(ROUTES, "POST", "/v2/hooks/trg_1", false, false), false, "not without the hook");
  for (const [method, raw] of [["GET", "/v2/hooks/trg_1"], ["POST", "/v2/hooks/composio/p1"], ["POST", "/v2/hooks/trg_1/x"], ["POST", "/v2/hooks"], ["POST", "/v2/triggers"], ["GET", "/v2/settings/tools"]]) {
    assert.equal(hooked(method, raw), false, `${method} ${raw}`);
  }
  assert.equal(hooked("GET", "/v2/runs/run_1"), true, "the rest as before");
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
  const capabilities = await send(server, "GET", "/v2/capabilities");
  assert.equal(capabilities.status, 200, "capabilities");
  // The store's schema and runner floor beside this build's, for a deploy's skew check (runnerfloor/1).
  const { version, runner_floor: floor, known } = capabilities.body.store_schema;
  assert.ok(Number.isSafeInteger(known) && version === known && Number.isSafeInteger(floor) && floor <= known, JSON.stringify(capabilities.body.store_schema));
  // Whether a per-run Composio server here takes each run's own account (composioperrun/1), read by the backend in
  // front from this answer: the API document stays refused here.
  assert.equal(capabilities.body.features.mcp_client.composio_per_run, true, "the per-run Composio binding is said");
  // A message's said (messagesaid/1), which the backend in front reads here before it sends one.
  assert.equal(capabilities.body.features.messages.said, true, "a message's said is offered");
  assert.equal((await send(server, "GET", "/v2/openapi.json")).status, 404, "the API document is not served here");
  const runs = await send(server, "GET", "/v2/runs");
  assert.equal(runs.status, 200, `the runs list: ${JSON.stringify(runs.body)}`);
  assert.equal((await send(server, "GET", "/v2/usage")).status, 200, "usage");
  assert.equal((await send(server, "GET", "/v2/runs/run_missing")).status, 404, "a run it does not have is the route's own 404");
  assert.notEqual((await send(server, "GET", "/v2/runs/run_missing")).body.error?.message?.includes("AGENTRUN_API_ONLY"), true, "not the profile's");
  assert.equal((await send(server, "GET", "/v2/runs", { token: false })).status, 401, "and still takes the token");
});

/** An inline run of the expert `expert` its backend sends (`external`), with `content` its input and `extra` its
 *  definition's other fields: its answer's body ({agent_id, run_id}). */
async function inlineRun(server, expert, content, extra = {}) {
  const inline = await send(server, "POST", "/v2/runs", { body: { external: { source: "backend", kind: "expert", id: expert, version: 1 }, definition: { name: `Expert ${expert}`, instructions: "Answer the question.", skills: [], tools: [], harness: "pi", ...extra }, input: { content } } });
  assert.equal(inline.status, 202, JSON.stringify(inline.body));
  return inline.body;
}

test("an API-only server serves a run's usage lines with the token, and still refuses a settings route", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { apiOnly: true });
  const { run_id: run } = await inlineRun(server, "usage-1", "What is six times seven.");
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

test("an API-only server answers the prices in force with the token, as its meters read them; no token is 401", async (t) => {
  withEnv(t, { AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_DAYTONA: "0.000014" }, ["AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_DAYTONA", "AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_DAYTONA"]);
  const server = await serve(t, { apiOnly: true, runner: false });
  const prices = await send(server, "GET", "/v2/settings/prices");
  assert.equal(prices.status, 200, JSON.stringify(prices.body));
  const row = (resource) => prices.body.compute.find((one) => one.provider === "daytona" && one.resource === resource && one.gpu_type === null);
  assert.deepEqual([row("vcpu")?.usd, row("vcpu")?.source], ["0.000014", "setting"], "a setting as written");
  assert.deepEqual([row("memory")?.usd, row("memory")?.source], [null, "unpriced"], "an unset resource unpriced");
  assert.ok(Array.isArray(prices.body.browser), "its browser rows");
  const anonymous = await send(server, "GET", "/v2/settings/prices", { token: false });
  assert.equal(anonymous.status, 401, `it takes the token: ${JSON.stringify(anonymous.body)}`);
});

test("an API-only server with the launch hook serves a firing's release with the token: an unknown trigger is the route's own 404, and with no launch hook the route's own 422 not_allowed", async (t) => {
  const path = `/v2/triggers/trg_0123456789abcdef01234567/firings/fir_${"0".repeat(32)}/release`;
  const hooked = await serve(t, { apiOnly: true, runner: false, launchHook: { url: "http://127.0.0.1:9/agentrun/firings", secret: mintSecret() } });
  const unknown = await send(hooked, "POST", path, { body: { error: "The job failed at launch." } });
  assert.deepEqual([unknown.status, unknown.body.error?.code], [404, "not_found"], JSON.stringify(unknown.body));
  assert.ok(!unknown.body.error.message.includes("AGENTRUN_API_ONLY"), `the route's own 404, not the profile's: ${unknown.body.error.message}`);
  assert.equal((await send(hooked, "POST", path, { token: false, body: { error: "The job failed at launch." } })).status, 401, "and it takes the token");
  const plain = await serve(t, { apiOnly: true, runner: false });
  const refused = await send(plain, "POST", path, { body: { error: "The job failed at launch." } });
  assert.deepEqual([refused.status, refused.body.error?.fields?.[0]?.reason], [422, "not_allowed"], JSON.stringify(refused.body));
});

test("an API-only server serves an ended run's share bundle with the token: agentrun.share/1 cut, its restore and the route's own 400 and 404; no token or another is 401; the share page is the profile's 404", { timeout: 180_000 }, async (t) => {
  // A synthetic address, made fresh: a personal cut, which a restore may put back.
  const email = `qa.${randomBytes(4).toString("hex")}@mailbox-synthetic.zz`;
  const server = await serve(t, { apiOnly: true });
  const { run_id: run } = await inlineRun(server, "share-1", `Write to ${email} about six times seven.`);
  await ended(server.api, run);

  const none = await send(server, "GET", `/v2/runs/${run}/export`, { token: false });
  assert.deepEqual([none.status, none.body.error?.code], [401, "unauthenticated"], JSON.stringify(none.body));
  const other = await send(server, "GET", `/v2/runs/${run}/export`, { token: false, headers: { authorization: `Bearer ${notSecret("token")}` } });
  assert.deepEqual([other.status, other.body.error?.code], [401, "unauthenticated"], JSON.stringify(other.body));

  const exported = await send(server, "GET", `/v2/runs/${run}/export`);
  assert.equal(exported.status, 200, JSON.stringify(exported.body).slice(0, 600));
  assert.deepEqual([exported.body.format, exported.body.run?.status], ["agentrun.share/1", "completed"], JSON.stringify(exported.body).slice(0, 600));
  assert.ok(!JSON.stringify(exported.body).includes(email), "the address is cut");
  const cut = exported.body.cuts.find((one) => one.kind === "personal" && one.restorable);
  assert.ok(cut, `a restorable personal cut: ${JSON.stringify(exported.body.cuts)}`);

  const restored = await send(server, "GET", `/v2/runs/${run}/export?restore=${cut.id}`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body).slice(0, 600));
  assert.ok(restored.body.restored.some((one) => one.id === cut.id), JSON.stringify(restored.body.restored));
  assert.ok(JSON.stringify(restored.body).includes(email), "the restored address is in place");
  for (const query of ["restore=not-an-id", "restore=c_0000000000000000"]) {
    const refused = await send(server, "GET", `/v2/runs/${run}/export?${query}`);
    assert.deepEqual([refused.status, refused.body.error?.code], [400, "bad_request"], `${query}: ${JSON.stringify(refused.body)}`);
    assert.ok(!refused.body.error.message.includes("AGENTRUN_API_ONLY"), `the route's own 400, not the profile's: ${refused.body.error.message}`);
  }
  const missing = await send(server, "GET", "/v2/runs/run_missing/export");
  assert.equal(missing.status, 404, "a run it does not have is the route's own 404");
  assert.ok(!missing.body.error.message.includes("AGENTRUN_API_ONLY"), `not the profile's: ${missing.body.error.message}`);

  const page = await send(server, "GET", `/share/${run}`);
  assert.deepEqual([page.status, page.body.error?.message], [404, `this server serves the run API only (AGENTRUN_API_ONLY=1): /share/${run} is not served here`], "the share page is the console's");
});

test("an API-only server answers 409 run_not_final to the export of a run that has not ended", { timeout: 120_000 }, async (t) => {
  // A run started on the whole server with no runner stays queued; the same data served API-only, no runner either.
  const whole = await serve(t, { runner: false });
  const { run_id: run } = await startRun(whole.api, "share-live", "Take your time.");
  await whole.stop();
  const server = await serve(t, { apiOnly: true, runner: false, data: whole.data });

  const refused = await send(server, "GET", `/v2/runs/${run}/export`);
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "run_not_final"], JSON.stringify(refused.body));
  assert.equal((await send(server, "GET", `/v2/runs/${run}/export`, { token: false })).status, 401, "and takes the token");
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

/** `answer` is 410 purged, its tombstone the run's. */
const purged = (answer, run, what) => assert.deepEqual([answer.status, answer.body.error?.code, answer.body.error?.details?.run_id], [410, "purged", run], `${what}: ${JSON.stringify(answer.body)}`);

test("an API-only server purges a run of an agent its backend made (an inline run's, external): 204, every read of it 410 purged, a second DELETE 204, its cost kept in /usage; an unknown run is the route's own 404; it takes the token", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { apiOnly: true });
  const { run_id: run } = await inlineRun(server, "erase-1", "What is six times seven.");
  await ended(server.api, run);
  const usage = (await send(server, "GET", `/v2/usage?${WINDOW}`)).body;

  const none = await send(server, "DELETE", `/v2/runs/${run}`, { token: false });
  assert.deepEqual([none.status, none.body.error?.code], [401, "unauthenticated"], JSON.stringify(none.body));
  assert.equal((await server.store.runs.get(run)).purgedAt, null, "nothing purged without the token");

  const deleted = await send(server, "DELETE", `/v2/runs/${run}`);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  purged(await send(server, "GET", `/v2/runs/${run}`), run, "its read");
  purged(await send(server, "GET", `/v2/runs/${run}/timeline`), run, "its timeline");
  assert.equal((await send(server, "DELETE", `/v2/runs/${run}`)).status, 204, "a second DELETE: purged before");
  assert.deepEqual((await send(server, "GET", `/v2/usage?${WINDOW}`)).body, usage, "what it cost stays in /usage");

  const missing = await send(server, "DELETE", "/v2/runs/run_missing");
  assert.deepEqual([missing.status, missing.body.error?.message], [404, "no run run_missing"], "a run it does not have is the route's own 404");
});

test("an API-only server purges a run of an agent made here, as it may purge the whole agent: 204, every read of it 410 purged, the agent and its other run kept; it takes the token", { timeout: 120_000 }, async (t) => {
  // The agent made on the whole server, then the same data served API-only (its agents' routes are refused there).
  const whole = await serve(t);
  const { run_id: run } = await startRun(whole.api, "here", "What is six times seven.");
  await follow(whole.api, run, ["completed"]);
  const other = await whole.api("POST", "/agents/here/runs", { input: { content: "What is six times eight." } });
  assert.equal(other.status, 202, JSON.stringify(other.body));
  await follow(whole.api, other.body.run_id, ["completed"]);
  await whole.stop();
  const server = await serve(t, { apiOnly: true, runner: false, data: whole.data });
  const usage = (await send(server, "GET", `/v2/usage?${WINDOW}`)).body;

  const none = await send(server, "DELETE", `/v2/runs/${run}`, { token: false });
  assert.deepEqual([none.status, none.body.error?.code], [401, "unauthenticated"], JSON.stringify(none.body));
  assert.equal((await server.store.runs.get(run)).purgedAt, null, "nothing purged without the token");

  const deleted = await send(server, "DELETE", `/v2/runs/${run}`);
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.notEqual((await server.store.runs.get(run)).purgedAt, null, "the run is purged");
  purged(await send(server, "GET", `/v2/runs/${run}`), run, "its read");
  purged(await send(server, "GET", `/v2/runs/${run}/timeline`), run, "its timeline");
  assert.equal((await send(server, "DELETE", `/v2/runs/${run}`)).status, 204, "a second DELETE: purged before");
  assert.deepEqual((await send(server, "GET", `/v2/usage?${WINDOW}`)).body, usage, "what it cost stays in /usage");

  const kept = await send(server, "GET", `/v2/runs/${other.body.run_id}`);
  assert.deepEqual([kept.status, kept.body.status], [200, "completed"], `its other run: ${JSON.stringify(kept.body)}`);
  const agent = await server.store.agents.get("here");
  assert.deepEqual([agent.purgedAt, agent.archivedAt], [null, null], "the agent is neither purged nor archived");
});

test("an API-only server answers 409 run_not_final to DELETE of a live run of an agent made here, nothing purged", { timeout: 120_000 }, async (t) => {
  // A run started on the whole server with no runner stays queued; the same data served API-only, no runner either.
  const whole = await serve(t, { runner: false });
  const { run_id: run } = await startRun(whole.api, "here-live", "Take your time.");
  await whole.stop();
  const server = await serve(t, { apiOnly: true, runner: false, data: whole.data });

  const refused = await send(server, "DELETE", `/v2/runs/${run}`);
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.details?.runs], [409, "run_not_final", [run]], JSON.stringify(refused.body));
  assert.equal((await server.store.runs.get(run)).purgedAt, null, "nothing purged");
  assert.equal((await send(server, "GET", `/v2/runs/${run}`)).status, 200, "the run is kept");
});

test("an API-only server's purge of a run of a learning agent (its expert's id `<workspace>:<expert>`) leaves the agent and its other runs alone", { timeout: 180_000 }, async (t) => {
  const server = await serve(t, { apiOnly: true, learning: "on" });
  const first = await inlineRun(server, "ws_1:expert-9", "What is six times seven.", { learning: true });
  await ended(server.api, first.run_id);
  const second = await inlineRun(server, "ws_1:expert-9", "What is six times eight.", { learning: true });
  assert.equal(second.agent_id, first.agent_id, "one agent for the expert");
  await ended(server.api, second.run_id);

  assert.equal((await send(server, "DELETE", `/v2/runs/${first.run_id}`)).status, 204);
  purged(await send(server, "GET", `/v2/runs/${first.run_id}`), first.run_id, "the purged run");
  const other = await send(server, "GET", `/v2/runs/${second.run_id}`);
  assert.deepEqual([other.status, other.body.status, other.body.result?.final_answer], [200, "completed", "On What is six times eight.: done."], `its other run: ${JSON.stringify(other.body)}`);
  assert.equal((await send(server, "GET", `/v2/runs/${second.run_id}/timeline`)).status, 200, "its other run's timeline");
  assert.equal((await send(server, "GET", `/v2/agents/${first.agent_id}/learning/loop`)).status, 200, "the agent's learning");
  const agent = await server.store.agents.get(first.agent_id);
  assert.deepEqual([agent.purgedAt, agent.archivedAt], [null, null], "the agent is neither purged nor archived");
  const listed = await send(server, "GET", `/v2/agents/${first.agent_id}/runs`);
  assert.deepEqual(listed.body.runs.map((one) => one.run_id), [second.run_id], `the agent's list: its other run alone: ${JSON.stringify(listed.body)}`);
});

test("an API-only server answers 409 run_not_final to DELETE of a live run of an agent its backend made, nothing purged; once cancelled, it purges it", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { apiOnly: true });
  const { run_id: run } = await inlineRun(server, "erase-live", "Take your time.");
  await follow(server.api, run, ["working"]);

  const refused = await send(server, "DELETE", `/v2/runs/${run}`);
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.details?.runs], [409, "run_not_final", [run]], JSON.stringify(refused.body));
  assert.equal((await server.store.runs.get(run)).purgedAt, null, "nothing purged");
  assert.equal((await send(server, "GET", `/v2/runs/${run}`)).status, 200, "the run is kept");

  assert.equal((await send(server, "POST", `/v2/runs/${run}/cancel`)).status, 202);
  await follow(server.api, run, ["cancelled"]);
  assert.equal((await send(server, "DELETE", `/v2/runs/${run}`)).status, 204);
  purged(await send(server, "GET", `/v2/runs/${run}`), run, "the cancelled run");
});

test("an API-only server serves an inline-run agent's learning reads with the token (loop, promotions, cost, a run's learning, audits), and refuses its learning's writes and texts", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { apiOnly: true, learning: "on" });
  const { agent_id: agent, run_id: run } = await inlineRun(server, "learner-1", "What is six times seven.", { learning: true });
  // The run ends, then its learning (the look-back the runner beside the server runs): both read by the token.
  await ended(server.api, run);

  const [loop, promotions, cost, learning, audits] = await Promise.all(LEARNING_READS.map((path) => send(server, "GET", at(path, agent, run))));
  assert.equal(loop.status, 200, JSON.stringify(loop.body));
  assert.deepEqual([loop.body.agent, loop.body.completed_runs, Array.isArray(loop.body.compiles)], [agent, 1, true], "the loop: its one completed run");
  assert.deepEqual([promotions.status, promotions.body], [200, { agent, promotions: [], serving: [] }], "the promotions: none yet");
  assert.equal(cost.status, 200, JSON.stringify(cost.body));
  assert.deepEqual([cost.body.agent, cost.body.runs.map((one) => one.run_id)], [agent, [run]], "the cost per run: the run");
  assert.equal(learning.status, 200, JSON.stringify(learning.body));
  assert.equal(learning.body.run, run, "the run's learning");
  assert.ok(["merged", "dropped"].includes(learning.body.state), JSON.stringify(learning.body));
  assert.deepEqual([audits.status, audits.body], [200, { agent, audits: [] }], "the audits: none yet");
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

test("an API-only server serves the saved MCP servers' names with the token, and nothing else of them; no token, or a wrong one, is 401", async (t) => {
  const secret = "names-route-sealed-header-value-0001";
  const upstream = await startFakeMcp({ token: secret });
  t.after(() => upstream.close());
  const whole = await serve(t, { runner: false });
  const empty = await send(whole, "GET", "/v2/settings/mcp-server-names");
  assert.deepEqual([empty.status, empty.body], [200, { names: [] }], "none saved: an empty list");
  for (const name of ["mail-reader", "crm"]) {
    const saved = await whole.api("PUT", `/settings/mcp-servers/${name}`, { url: upstream.url, auth: { type: "headers", headers: { authorization: `Bearer ${secret}` } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  const listed = await send(whole, "GET", "/v2/settings/mcp-server-names");
  assert.deepEqual([listed.status, listed.body], [200, { names: ["crm", "mail-reader"] }], "each saved server once, by name, sorted");
  await whole.stop();

  const server = await serve(t, { apiOnly: true, runner: false, data: whole.data });
  const names = await send(server, "GET", "/v2/settings/mcp-server-names");
  assert.deepEqual([names.status, names.body], [200, { names: ["crm", "mail-reader"] }], "the API-only server serves it");
  const text = JSON.stringify(names.body);
  for (const value of [secret, upstream.url, new URL(upstream.url).host, "headers", "authorization"]) assert.equal(text.includes(value), false, `the answer holds no ${value}`);
  // Beside it, the full list (URLs, auth types, tools) stays refused on the API-only server.
  assert.equal((await send(server, "GET", "/v2/settings/mcp-servers")).status, 404, "the full list is not served API-only");
  for (const [options, why] of [[{ token: false }, "no token"], [{ token: false, headers: { authorization: `Bearer ${notSecret("token")}` } }, "a wrong token"]]) {
    const refused = await send(server, "GET", "/v2/settings/mcp-server-names", options);
    assert.equal(refused.status, 401, `${why}: ${JSON.stringify(refused.body)}`);
    assert.equal(/mail-reader|crm/.test(JSON.stringify(refused.body)), false, `${why}: no name in the refusal`);
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
  assert.deepEqual(archil.body, { on: true, source: "env", region: "aws-us-east-1", s3Url: "https://s3.archil.example", s3UrlFrom: "given", regions: archil.body.regions, secret: { name: "workspace:archil", set: true, source: "console", changed_at: archil.body.secret.changed_at } });
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
  assert.ok(lines.includes("API only (AGENTRUN_API_ONLY=1): the run and deploy routes, a trigger's reads and its turn on or off, the MCP server names, a Composio server's save, a per_run server's save at an origin AGENTRUN_API_ONLY_MCP_ORIGINS lists and a server's delete are served; the console, sign-in, setup, other settings, the MCP endpoint, the other trigger routes and hooks are refused."), lines.join("\n"));
  assert.ok(!lines.some((line) => line.startsWith("Open ")), "no console link");
});
