// A run on codex through serve, on agentrun-codex's stand-in for Codex's app-server (no Codex binary, no network): its
// model requests go through the adapter's proxy to serve's gateway (a loopback server here), priced from serve's own
// catalog, and the stand-in, Codex's own process, runs under the run's confinement: setpriv's no_new_privs, as pi's
// commands do, under the same user.
import assert from "node:assert/strict";
import { copyFile, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-adapters/host";
import { fileURLToPath } from "node:url";
import { agent, follow, scratch, serve } from "./support.mjs";

/** The gateway's key in these tests: no real one. */
const GATEWAY_KEY = `not-a-secret-${"gateway"}`;
const STAND_IN = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));

/** serve's gateway, on loopback: each Responses request streamed back as one short answer with its usage, once the
 *  test lets it go. */
async function gateway(t) {
  const seen = [];
  let release;
  const held = new Promise((resolve) => (release = resolve));
  // A failing test still lets the turn finish, so the run's process and the server can stop.
  t.after(() => release());
  const server = createServer(async (req, res) => {
    // Only the API's own paths count: a host's loopback prober (a keyless GET /) is not a request of the run's.
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body || "{}") });
    await held;
    const events = [{ type: "response.output_text.delta", delta: "Codex answered." }, { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 100 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, release, origin: `http://127.0.0.1:${server.address().port}` };
}

/** The process whose command line names `path`, and its status. */
async function processOf(path) {
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (cmdline.split("\0").includes(path)) return { pid: Number(pid), status: await readFile(`/proc/${pid}/status`, "utf8") };
  }
  return undefined;
}
const field = (status, name) => new RegExp(`^${name}:\\s+(.*)$`, "m").exec(status)?.[1]?.trim();

/** serve with codex on a copy of the stand-in (its process found by that copy's path), its model through `gw`. */
async function codexServe(t, gw) {
  const dir = await scratch(t);
  const standIn = join(dir, "codex-stand-in.mjs");
  await copyFile(STAND_IN, standIn);
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, {
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: gw.origin,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: GATEWAY_KEY,
    AGENT_MODEL_PRICE: "1,2,0.5",
  });
  const { api, data } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("coder", { harness: "codex" }))).status, 201);
  return { api, standIn, data };
}

test("a codex run whose cap is below one request's ceiling is refused before anything reaches the gateway: failed, spend_cap_reached, at $0", { timeout: 90_000 }, async (t) => {
  const gw = await gateway(t);
  gw.release();
  const { api } = await codexServe(t, gw);
  // The gateway's model may answer 32k tokens at $2 a million: $0.064, past a $0.01 cap before anything is spent.
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." }, max_cost_usd: 0.01 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["failed"], { deadlineMs: 60_000 });
  const ended = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.deepEqual([ended.status, ended.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(ended));
  assert.equal(gw.seen.length, 0, "no request reached the gateway");
  assert.equal(ended.cost.usd, 0);
});

test("a run on codex goes through the adapter's proxy to serve's gateway, priced from serve's catalog, with Codex's own process under the run's confinement", { timeout: 90_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const gw = await gateway(t);
  const { api, standIn } = await codexServe(t, gw);
  assert.deepEqual((await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "codex"), { id: "codex", available: true, steer: false });
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  // Mid-turn, with the gateway holding its answer: Codex's process and its rights.
  for (let i = 0; gw.seen.length === 0; i++) {
    assert.ok(i < 300, "the turn's model request reaches the gateway");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const child = await processOf(standIn);
  assert.ok(child, "Codex's process runs");
  assert.equal(field(child.status, "NoNewPrivs"), "1", "under setpriv --no-new-privs, as pi's commands are");
  assert.equal(field(child.status, "Uid")?.split(/\s+/)[0], String(process.getuid()), "as the run's own user");
  gw.release();
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  assert.equal(gw.seen[0].path, "/v1/responses");
  assert.equal(gw.seen[0].authorization, `Bearer ${GATEWAY_KEY}`, "the gateway's key, from serve, at the proxy");
  const usage = rows.findLast((r) => r.kind === "usage")?.usage;
  assert.deepEqual(usage, { usd: 0.0012, requests: 1 }, "1000 in at $1 and 100 out at $2 per million");
});

test("through a gateway, codex sends the model id the revision names whole, as pi does: the gateway's own name, never stripped", { timeout: 90_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const gw = await gateway(t);
  const { api } = await codexServe(t, gw);
  assert.equal((await api("POST", "/agents", agent("named", { harness: "codex", model: "openai/gpt-4o" }))).status, 201);
  const run = await api("POST", "/agents/named/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  for (let i = 0; gw.seen.length === 0; i++) {
    assert.ok(i < 300, "the turn's model request reaches the gateway");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  gw.release();
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  assert.equal(gw.seen[0].body.model, "openai/gpt-4o", "the gateway gets the name it was configured with");
});

/** Whether `pid` still runs: a zombie, waiting to be reaped, does not. */
const alive = processAlive;

test("a codex run whose process dies while its request is in flight leaves no Codex process behind", { timeout: 120_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const gw = await gateway(t);
  const { api, standIn, data } = await codexServe(t, gw);
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  for (let i = 0; gw.seen.length === 0; i++) {
    assert.ok(i < 300, "the turn's model request reaches the gateway");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const child = await processOf(standIn);
  assert.ok(child, "Codex's process runs");
  t.after(() => alive(child.pid) && process.kill(child.pid, "SIGKILL"));
  const { holder } = JSON.parse(await readFile(join(data, "runs", run.body.run_id, "run.json"), "utf8"));
  process.kill(holder.pid, "SIGKILL");
  for (let i = 0; alive(child.pid); i++) {
    assert.ok(i < 20, `the dead process's Codex (pid ${child.pid}) is gone within 2 s`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

/** This test's own caller, by its user-agent. */
const PROBE_AGENT = "serve-log-test";
/** A value no log may carry, sent as a bearer and in a query string. */
const CANARY = `not-a-secret-${"canary"}-0f3c9a`;

test("a codex run's model proxy reports a refusal in the run's log: one harness line, with no key in it, neither the one sent nor serve's own", { timeout: 90_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const gw = await gateway(t);
  const { api, data, standIn } = await codexServe(t, gw);
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const dir = join(data, "runs", run.body.run_id);
  // Codex's own request, not another local process calling the gateway's port.
  for (let i = 0; !gw.seen.some((s) => s.path?.startsWith("/v1/")); i++) {
    assert.ok(i < 300, "the turn's model request reaches the gateway");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The session's proxy, as Codex was told it: base_url in the config.toml of Codex's own CODEX_HOME.
  const child = await processOf(standIn);
  assert.ok(child, "Codex's process runs");
  const home = (await readFile(`/proc/${child.pid}/environ`, "utf8")).split("\0").find((line) => line.startsWith("CODEX_HOME="))?.slice("CODEX_HOME=".length);
  assert.ok(home, "Codex has its CODEX_HOME");
  const base = /base_url\s*=\s*"([^"]+)"/.exec(await readFile(join(home, "config.toml"), "utf8"))?.[1];
  assert.ok(base, "Codex's config names the session's proxy");
  const refused = await fetch(`${new URL(base).origin}/?key=${CANARY}`, { headers: { "user-agent": PROBE_AGENT, authorization: `Bearer ${CANARY}` } });
  assert.equal(refused.status, 401, "a caller without the session's key is refused");
  gw.release();
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  const log = await readFile(join(dir, "process.log"), "utf8");
  const lines = log.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { line }; } });
  // Only this test's own request: another local process may call any loopback port, and is refused (and said) too.
  const said = lines.filter((l) => l.event === "harness" && /^model proxy \(.+\): refused$/.test(l.message ?? "") && l.userAgent === PROBE_AGENT);
  assert.deepEqual(said.map((l) => [l.harness, l.status, l.method, l.path]), [["codex", 401, "GET", "/"]], `the refusal, once, in the run's log: ${log}`);
  for (const secret of [CANARY, GATEWAY_KEY]) assert.ok(!log.includes(secret), `${secret} is not in the run's log`);
});
