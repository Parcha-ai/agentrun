// A run on opencode through serve, on the OpenCode adapter's stand-in for `opencode serve` (no OpenCode binary, no
// network): its model requests go through the adapter's proxy to serve's gateway (a loopback server here), priced from
// serve's own catalog, and the stand-in, OpenCode's own process, runs under the run's confinement, in the run's
// workspace. A run whose process is killed mid-turn is relaunched by the server and completes: the new process gives
// OpenCode its session back from the run's store.
import assert from "node:assert/strict";
import { copyFile, readdir, readFile, readlink } from "node:fs/promises";
import { createServer } from "node:http";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agent, follow, scratch, serve } from "./support.mjs";

/** The gateway's key in these tests: no real one. */
const GATEWAY_KEY = `not-a-secret-${"gateway"}`;
const STAND_IN = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** serve's gateway, on loopback: each Responses request answered with `text(i)` and its usage, once the test lets it go
 *  (the first `held` requests wait for `release`). */
async function gateway(t, { text = () => "OpenCode answered.", held = Infinity } = {}) {
  const seen = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const i = seen.length;
    seen.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body || "{}") });
    if (i < held) await gate;
    const events = [{ type: "response.output_text.delta", delta: text(i) }, { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 100 } } }];
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

/** serve with opencode on a copy of the stand-in (its process found by that copy's path), its model through `gw`. */
async function opencodeServe(t, gw) {
  const dir = await scratch(t);
  const standIn = join(dir, "opencode-stand-in.mjs");
  await copyFile(STAND_IN, standIn);
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, {
    AGENTRUN_OPENCODE_STANDIN: "1",
    AGENTRUN_SERVE_OPENCODE_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn] }),
    AGENT_MODEL_BASE_URL: gw.origin,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: GATEWAY_KEY,
    AGENT_MODEL_PRICE: "1,2,0.5",
  });
  const { api, data } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("coder", { harness: "opencode" }))).status, 201);
  return { api, standIn, data };
}

test("an opencode run whose cap can't cover one request's least pauses before anything reaches the gateway, as every harness does: input_required, waiting on its cap, at $0, in plain words", { timeout: 90_000 }, async (t) => {
  const gw = await gateway(t);
  gw.release();
  const { api } = await opencodeServe(t, gw);
  // The gateway's model answers at $2 a million output tokens: the least a request may be limited to, its answer's 1,024
  // tokens, costs $0.002048 before its input, past a $0.001 cap.
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." }, max_cost_usd: 0.001 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["input_required", "failed"], { deadlineMs: 60_000 });
  const ended = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.deepEqual([ended.status, ended.state, ended.error, ended.pending?.kind], ["input_required", "waiting", null, "budget"], JSON.stringify(ended));
  const words = /^Not sent: this run's cap of \$0\.001 can't cover one .+ request \(at least \$(\d+\.\d+)\)\. Raise the cap to at least \$(\d+\.\d+) to run it\.$/.exec(ended.pending.said);
  assert.ok(words, ended.pending.said);
  assert.equal(words[2], words[1], "nothing spent or held: the cap to raise to is the least");
  assert.ok(Number(words[1]) >= 0.002048, `the least covers the answer's 1,024 tokens: $${words[1]}`);
  assert.equal(gw.seen.length, 0, "no request reached the gateway");
  assert.equal(ended.cost.usd, 0);
});

test("an opencode run whose cap is under one request's ceiling runs: its request reaches the gateway with the output tokens the cap can buy, and the run completes", { timeout: 90_000 }, async (t) => {
  const gw = await gateway(t);
  gw.release();
  const { api } = await opencodeServe(t, gw);
  // 32,000 output tokens at $2 a million is $0.064, past a $0.05 cap: the request goes, limited to what is left buys.
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." }, max_cost_usd: 0.05 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  assert.equal(gw.seen.length, 1, "one model request");
  const limit = gw.seen[0].body.max_output_tokens;
  assert.ok(Number.isSafeInteger(limit) && limit >= 1024 && limit < 32_000, `max_output_tokens is what $0.05 buys, at least the answer's 1,024 and under the ceiling: ${limit}`);
  assert.deepEqual(rows.findLast((r) => r.kind === "usage")?.usage, { usd: 0.0012, requests: 1 });
  assert.equal(rows.findLast((r) => r.kind === "final_answer" || r.kind === "text_block")?.text, "OpenCode answered.");
});

test("a run on opencode goes through the adapter's proxy to serve's gateway, priced from serve's catalog and booked once, with OpenCode's own process under the run's confinement, in the run's workspace", { timeout: 90_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const gw = await gateway(t);
  const { api, standIn, data } = await opencodeServe(t, gw);
  // How many fit at once is this host's memory (admission.test.mjs).
  const { max_concurrent_runs, ...offer } = (await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "opencode");
  assert.deepEqual(offer, { id: "opencode", available: true, steer: false, default_model: "agent-model/gpt-test", run_memory_mib: 704 });
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  for (let i = 0; gw.seen.length === 0; i++) {
    assert.ok(i < 300, "the turn's model request reaches the gateway");
    await sleep(100);
  }
  const child = await processOf(standIn);
  assert.ok(child, "OpenCode's process runs");
  assert.equal(field(child.status, "NoNewPrivs"), "1", "under setpriv --no-new-privs, as pi's commands are");
  assert.equal(field(child.status, "Uid")?.split(/\s+/)[0], String(process.getuid()), "as the run's own user");
  assert.equal(await readlink(`/proc/${child.pid}/cwd`), realpathSync(join(data, "runs", run.body.run_id, "work")), "in the run's workspace, where its file tools write");
  gw.release();
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  assert.equal(gw.seen.length, 1, "one model request");
  assert.equal(gw.seen[0].path, "/v1/responses");
  assert.equal(gw.seen[0].authorization, `Bearer ${GATEWAY_KEY}`, "the gateway's key, from serve, at the proxy");
  assert.equal(gw.seen[0].body.store, false);
  const usage = rows.findLast((r) => r.kind === "usage")?.usage;
  assert.deepEqual(usage, { usd: 0.0012, requests: 1 }, "1000 in at $1 and 100 out at $2 per million, booked once");
  assert.equal(rows.findLast((r) => r.kind === "final_answer" || r.kind === "text_block")?.text, "OpenCode answered.");
});

test("an opencode run whose process is killed mid-turn is relaunched: OpenCode gets its session back from the run's store and the run completes", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  // The first request is held (the turn is mid-flight) and its answer never reaches anyone; the relaunched turn's are answered.
  const gw = await gateway(t, { text: (i) => (i === 0 ? "Before the cut." : "After the cut."), held: 1 });
  const { api, standIn, data } = await opencodeServe(t, gw);
  const run = await api("POST", "/agents/coder/runs", { input: { content: "Say what you did." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  for (let i = 0; gw.seen.length === 0; i++) {
    assert.ok(i < 300, "the turn's model request reaches the gateway");
    await sleep(100);
  }
  const record = async () => JSON.parse(await readFile(join(data, "runs", run.body.run_id, "run.json"), "utf8"));
  const killed = (await record()).holder.pid;
  const child = await processOf(standIn);
  assert.ok(child, "OpenCode's process runs");
  process.kill(killed, "SIGKILL");
  for (let i = 0; existsSync(`/proc/${child.pid}`) && !(await readFile(`/proc/${child.pid}/status`, "utf8").catch(() => "")).includes("State:\tZ"); i++) {
    assert.ok(i < 50, "the killed process's OpenCode dies with it");
    await sleep(100);
  }
  gw.release();
  const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 150_000 });
  const relaunched = (await record()).holder?.pid;
  assert.notEqual(relaunched, killed, "a new process ran the turn");
  assert.ok(gw.seen.length >= 2, "the relaunched turn asked the model again");
  const input = JSON.stringify(gw.seen.at(-1).body.input);
  assert.match(input, /Say what you did\./, "the session OpenCode got back holds the run's message");
  assert.match(input, /\[Recovery\]/, "the model is told its turn was cut");
  assert.equal(rows.findLast((r) => r.kind === "final_answer" || r.kind === "text_block")?.text, "After the cut.");
});
