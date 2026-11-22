// A real server (the CLI on the faux model) started with the launch hook set, through its HTTP API alone: a trigger's
// run now is handed to the host's hook on 127.0.0.1, which checks the signature, starts the run through the same API
// under the firing's id and names it; the firing records that run, and the server started none of its own. The secret is
// in no answer, no file of the data directory and no line the process printed. Half the setting stops the start in words.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { agent, client, FAUX, follow, printed, scratch } from "./support.mjs";

const { mintSecret, verify } = await import("../dist/standard-webhooks.js");

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"h".repeat(40)}`;

/** Every file under `root` whose bytes hold `value`. */
function filesHolding(root, value) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat?.isDirectory()) walk(path);
      else if (stat?.isFile() && readFileSync(path).includes(value)) out.push(path);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** The CLI started on `data` with `extra` in its environment, its output kept; stopped with the test. On loopback with no
 *  public address its setup is open, so the test client makes the owner's session it writes the trigger from. */
function started(t, data, extra) {
  const { AGENTRUN_PUBLIC_URL: _, RENDER_EXTERNAL_URL: __, ...inherited } = process.env;
  const env = { ...inherited, AGENTRUN_TOKEN: TOKEN, ...extra };
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { env, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  });
  return { child, output, exited };
}

test("a server with the launch hook hands a trigger's firing to the host, which starts the run through the API; the secret is nowhere after", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const secret = mintSecret();
  let api;
  const received = [];
  const hook = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const refused = verify(secret, req.headers, body, Date.now());
    received.push({ refused, id: req.headers["webhook-id"] });
    if (refused) return void res.writeHead(401).end();
    const firing = JSON.parse(body.toString("utf8"));
    const run = await api("POST", `/agents/${firing.agent_id}/runs`, { input: firing.input, max_cost_usd: 0.5 }, { "idempotency-key": firing.firing_id });
    res.writeHead(run.status, { "content-type": "application/json" }).end(JSON.stringify({ run_id: run.body.run_id }));
  });
  await new Promise((resolve) => hook.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    hook.closeAllConnections();
    hook.close(() => resolve());
  }));
  const url = `http://127.0.0.1:${hook.address().port}/firings`;

  const { child, output } = started(t, data, { AGENTRUN_LAUNCH_HOOK_URL: url, AGENTRUN_LAUNCH_HOOK_SECRET: secret });
  const out = await printed(child, /^Launch hook /m);
  assert.match(out, /^Launch hook \(AGENTRUN_LAUNCH_HOOK_URL\): trigger firings go to http:\/\/127\.0\.0\.1:\d+/m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  api = client(`http://127.0.0.1:${port}/v2`, TOKEN);

  assert.equal((await api("POST", "/agents", agent("digest", { max_cost_usd: 0.5 }))).status, 201);
  const trigger = await api("POST", "/triggers", { name: "daily", source: { kind: "schedule", every_s: 86_400 }, target: { kind: "start_run", agent_id: "digest", input: { content: "Say hello." }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  const fired = await api("POST", `/triggers/${trigger.body.id}/fire`, undefined, { "idempotency-key": "demo-1" });
  assert.equal(fired.status, 202, JSON.stringify(fired.body));
  assert.deepEqual(received, [{ refused: undefined, id: fired.body.key }], "one signed POST, its webhook-id the firing's");
  const runs = (await api("GET", "/runs?agent=digest")).body.runs;
  assert.equal(runs.length, 1, "the host's run alone");
  assert.deepEqual([fired.body.status, fired.body.run_id], ["sent", runs[0].run_id], JSON.stringify(fired.body));
  const { last } = await follow(api, runs[0].run_id, ["completed", "failed", "cancelled"], { deadlineMs: 120_000 });
  assert.equal(last.status, "completed");

  for (const path of [`/triggers/${trigger.body.id}`, `/triggers/${trigger.body.id}/firings`, `/runs/${runs[0].run_id}`]) assert.ok(!JSON.stringify((await api("GET", path)).body).includes(secret), `${path} holds no secret`);
  assert.deepEqual(filesHolding(data, secret), [], "no file of the data directory holds the secret");
  assert.ok(!output.join("").includes(secret), "the process printed no secret");
});

test("half the launch hook setting stops the start in words, never saying the secret", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const secret = mintSecret();
  const { output, exited } = started(t, join(dir, "agents"), { AGENTRUN_LAUNCH_HOOK_SECRET: secret });
  assert.equal(await exited, 2);
  assert.match(output.join(""), /AGENTRUN_LAUNCH_HOOK_URL/);
  assert.ok(!output.join("").includes(secret));
});
