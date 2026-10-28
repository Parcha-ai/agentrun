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
import { fileURLToPath } from "node:url";
import { agent, follow, scratch, serve } from "./support.mjs";

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

test("a run on codex goes through the adapter's proxy to serve's gateway, priced from serve's catalog, with Codex's own process under the run's confinement", { timeout: 90_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const dir = await scratch(t);
  // A copy of the stand-in under a name of this test's own, so its process is found by its command line.
  const standIn = join(dir, "codex-stand-in.mjs");
  await copyFile(STAND_IN, standIn);
  const gw = await gateway(t);
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
    AGENT_MODEL_API_KEY: "gateway-key",
    AGENT_MODEL_PRICE: "1,2,0.5",
  });
  const { api } = await serve(t, { faux: undefined });
  assert.deepEqual((await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "codex"), { id: "codex", available: true });
  assert.equal((await api("POST", "/agents", agent("coder", { harness: "codex" }))).status, 201);
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
  assert.equal(gw.seen[0].authorization, "Bearer gateway-key", "the gateway's key, from serve, at the proxy");
  const usage = rows.findLast((r) => r.kind === "usage")?.usage;
  assert.deepEqual(usage, { usd: 0.0012, requests: 1 }, "1000 in at $1 and 100 out at $2 per million");
});
