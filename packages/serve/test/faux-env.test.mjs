// serve's test hooks (AGENTRUN_SERVE_FAUX and the names after it) are set from startServe's options alone: a name of the
// server's own environment never enables the hook, loads its module, or decides what a run answers. On the cutover a run is
// claimed and run by a SEPARATE runner process over the store, never forked by the server, so the fence is read over the
// store: the server, with a faux name in its own environment and no faux option, shows no faux and loads no module; and the
// run runs on a separate runner whose dispatch strips the ambient faux (model.ts withoutFaux), reaching the real gateway,
// never the answer the ambient faux module would give. The runner process itself carries the operator's faux name (the
// realistic threat), so this is not circular.
//
// The old test read the holder's /proc environ, from a server-forked run process the cutover no longer has. The "a run's
// tool processes carry no such name" half — the hands' bash runs with the fixed shellEnv (hands.ts), never the runner's
// environment — needs a box to run bash in, so it is a separate box-env check (boxed-tools.test.mjs already proves "the
// box's environment is the fixed one, with no key or token" over the faux box; a real-gateway run cannot also use the faux
// box, which is coupled to the faux model, so a bash-in-this-run check needs real Docker).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const MARKER_MODULE = new URL("./fixtures/faux-marker.mjs", import.meta.url).pathname;
const RUNNER_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The runner's name as runner.ts mints it, `<hostname>:<pid>:<uuid>`: its pid, the process running the run. */
const pidOf = (runner) => Number(/:(\d+):[^:]+$/.exec(runner ?? "")?.[1]);

/** A Responses endpoint whose first answer waits until `release()`, so the run's process is alive to be read. */
async function heldEndpoint(t) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let asked = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      if (req.method !== "POST") return void res.writeHead(404).end();
      asked += 1;
      await held;
      const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "42", annotations: [] }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "42" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => (release(), new Promise((resolve) => server.close(resolve))));
  return { url: `http://127.0.0.1:${server.address().port}`, release, asked: () => asked };
}

test("a faux name in the server's own environment, with no faux option, enables nothing: capabilities show no faux, the run runs on a separate runner that reaches the real gateway and never the faux module, and no process loads it", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const marker = join(dir, "imported");
  const endpoint = await heldEndpoint(t);
  // The operator's environment holds a faux name (AGENTRUN_SERVE_FAUX, AGENTRUN_HARNESS_TABLE); the gateway is the run's model.
  const fauxEnv = { AGENTRUN_SERVE_FAUX: MARKER_MODULE, AGENTRUN_HARNESS_TABLE: MARKER_MODULE, AGENTRUN_TEST_FAUX_MARKER: marker };
  const gatewayEnv = { AGENT_MODEL_BASE_URL: endpoint.url, AGENT_MODEL: "gpt-4o", AGENT_MODEL_API_KEY: "none" };
  withEnv(t, { ...fauxEnv, ...gatewayEnv }, ["AGENTRUN_SERVE_FAUX", "AGENTRUN_HARNESS_TABLE", "AGENTRUN_TEST_FAUX_MARKER", "AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE"]);
  // The server alone (no in-process runner): a separate agentrun-serve runner process claims and runs the run.
  const { api, data } = await serve(t, { faux: undefined, runner: false });
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.models.source, "gateway", `the server's models are its gateway's, not the faux module's: ${JSON.stringify(caps.models)}`);
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const started = await api("POST", "/agents/plain/runs", { input: { content: "What is six times seven?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;

  // A separate runner process, started WITH the operator's environment (it inherits the faux name, like the server). Its
  // dispatch strips the ambient faux (withoutFaux), so the run reaches the real gateway; the CLI reads its secrets from the
  // environment when no launcher pipe is set.
  const runner = spawn(process.execPath, [RUNNER_CLI, "runner", "--data", data], { env: { ...process.env, ...fauxEnv, ...gatewayEnv }, stdio: "ignore" });
  const exited = new Promise((resolve) => runner.once("exit", resolve));
  t.after(() => void (runner.exitCode === null && runner.kill("SIGKILL")));
  try {
    // The run's request reaches the gateway, so the separate runner claimed and dispatched it (a faux module would have
    // answered without the network, ending the run; named either way).
    for (const deadline = Date.now() + 60_000; !endpoint.asked(); await sleep(50)) {
      const { status } = (await api("GET", `/runs/${runId}`)).body;
      assert.ok(!["completed", "failed"].includes(status), `the run ended ${status} without asking the gateway; the faux module ${existsSync(marker) ? "was" : "was not"} imported`);
      assert.ok(Date.now() < deadline, "the run's request reached the gateway in 60 s");
    }
    // It ran in the separate runner: the claim names that process's pid, never the server's or the test's.
    const claim = (await api("GET", `/runs/${runId}`)).body.claim;
    assert.equal(pidOf(claim?.runner), runner.pid, `the run ran on the spawned runner, not the server's process (claim ${JSON.stringify(claim)})`);
    assert.notEqual(runner.pid, process.pid, "the runner is a separate process from the test's");
    endpoint.release();
    await follow(api, runId, ["completed", "failed"]);
    const run = (await api("GET", `/runs/${runId}`)).body;
    // The gateway answered, not the faux module; and the faux module was imported by no process.
    assert.deepEqual([run.status, run.result?.final_answer], ["completed", "42"], `the gateway answered, not the faux module: ${JSON.stringify(run)}`);
    assert.equal(endpoint.asked(), 1);
    assert.equal(existsSync(marker), false, "no process imported the faux module");
  } finally {
    runner.kill("SIGTERM");
    await Promise.race([exited, sleep(5_000).then(() => runner.kill("SIGKILL"))]);
    await exited;
  }
});
