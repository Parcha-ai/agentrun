// A launch that takes its server down: the next start fails the run once, rather than launch it again and go down with
// it at every start. A launch that came up and served is opened again as before.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-adapters/host";
import { LAUNCH_COUNT_ENV, LAUNCH_JAM_ENV, LAUNCH_KILL_ENV } from "./fixtures/faux-launch-kills-server.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, client, scratch, storeRun } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FAUX_LAUNCH = new URL("./fixtures/faux-launch-kills-server.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A server in a process of its own on `data`, its runs' processes on the launch fixture with `env`. */
async function serverProcess(t, data, env) {
  // A home beside the data, not this machine's: a first start counts the sessions in its home for setup's offer.
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX_LAUNCH, "--drain-timeout", "2s"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: dirname(data), ...env } });
  t.after(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (let i = 0; !/AGENTRUN_API_KEY=/.test(out); i++) {
    assert.ok(i < 2400, `the server did not start: ${out}${err}`);
    await sleep(50);
  }
  const value = (name) => new RegExp(`${name}=(\\S+)`).exec(out)[1];
  return { child, stdout: () => out, stderr: () => err, api: client(value("AGENTRUN_BASE_URL"), (await readFile(join(data, ".token"), "utf8")).trim()) };
}

const exited = (child) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve)));
const launchCount = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).length;

/** Polls `check` until it answers; a request that cannot reach the server (a spawn holding its event loop) is asked again. */
async function until(what, check, deadlineMs = 60_000) {
  for (const deadline = Date.now() + deadlineMs; ; await sleep(100)) {
    const value = await Promise.resolve().then(check).catch((error) => {
      if (!(error instanceof TypeError && error.message === "fetch failed")) throw error;
    });
    if (value) return value;
    assert.ok(Date.now() < deadline, `${what} in time`);
  }
}

test("a run whose launch took its server down is failed by the next start, once, with the reason named, and never launched again", async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const env = { [LAUNCH_COUNT_ENV]: join(dir, "launches"), [LAUNCH_KILL_ENV]: join(dir, "kill") };
  await writeFile(env[LAUNCH_KILL_ENV], "");
  const first = await serverProcess(t, data, env);
  assert.equal((await first.api("POST", "/agents", agent("calc"))).status, 201);
  // The answer may or may not leave before the run's process takes the server down.
  await first.api("POST", "/agents/calc/runs", { input: { content: "Answer soon." } }).catch(() => undefined);
  await exited(first.child);
  assert.equal(first.child.signalCode, "SIGKILL", "the run's launch took its server down");
  const [runId, ...others] = await readdir(join(data, "runs"));
  assert.deepEqual(others, []);
  assert.equal(await launchCount(env[LAUNCH_COUNT_ENV]), 1, "the run's process came up once");

  await rm(env[LAUNCH_KILL_ENV]);
  const second = await serverProcess(t, data, env);
  const run = await until("the run is failed", async () => {
    const { body } = await second.api("GET", `/runs/${runId}`);
    assert.notEqual(body.status, "completed", "the run was launched again");
    return body.status === "failed" && body.poll_after_ms === 0 ? body : undefined;
  });
  assert.equal(run.error.code, "run_failed");
  assert.equal(run.error.retryable, false);
  assert.deepEqual(run.error.details, { reason: "server_lost_at_launch" });
  const doc = (await second.api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/RunError" }, run.error), [], "the error is as the served document says");
  assert.equal(storeRun(data, runId).state, "failed");
  await sleep(1_500);
  assert.equal(second.child.exitCode, null, "the server stays up");
  assert.equal(second.child.signalCode, null, "the server stays up");
  assert.equal((await second.api("GET", "/health")).status, 200);
  assert.equal(await launchCount(env[LAUNCH_COUNT_ENV]), 1, "the run was not launched again");
  assert.doesNotMatch(second.stderr(), /opening it again/);
  const listed = (await second.api("GET", "/runs")).body.runs.find((r) => r.run_id === runId);
  assert.deepEqual(listed.error, run.error, "the list says the same");
});

test("a run whose process served and then died with its server is opened again by the next start, and completes", async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const env = { [LAUNCH_COUNT_ENV]: join(dir, "launches"), [LAUNCH_KILL_ENV]: join(dir, "kill") };
  const first = await serverProcess(t, data, env);
  assert.equal((await first.api("POST", "/agents", agent("calc"))).status, 201);
  const { body: started } = await first.api("POST", "/agents/calc/runs", { input: { content: "Answer soon." } });
  await until("the run works", async () => {
    const { body } = await first.api("GET", `/runs/${started.run_id}`);
    return body.status === "working" && body.state === "working";
  });
  first.child.kill("SIGKILL");
  await exited(first.child);
  const { holder } = JSON.parse(await readFile(join(data, "runs", started.run_id, "run.json"), "utf8"));
  if (processAlive(holder.pid)) process.kill(holder.pid, "SIGKILL");
  await until("the run's process is gone", () => !processAlive(holder.pid), 10_000);
  assert.equal(await launchCount(env[LAUNCH_COUNT_ENV]), 1);

  const second = await serverProcess(t, data, env);
  const run = await until("the run completes", async () => {
    const { body } = await second.api("GET", `/runs/${started.run_id}`);
    assert.notEqual(body.status, "failed", JSON.stringify(body.error));
    return body.status === "completed" && body.poll_after_ms === 0 ? body : undefined;
  });
  assert.equal(run.result.final_answer, "Soon.");
  assert.equal(await launchCount(env[LAUNCH_COUNT_ENV]), 2, "opened again once");
  assert.equal(storeRun(data, started.run_id).state, "completed");
});

test("a launch mark the server cannot remove is logged by name, and the server stays up and the run completes", async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const server = await serverProcess(t, data, { [LAUNCH_JAM_ENV]: "1" });
  assert.equal((await server.api("POST", "/agents", agent("calc"))).status, 201);
  const { body: started } = await server.api("POST", "/agents/calc/runs", { input: { content: "Answer soon." } });
  const run = await until("the run completes", async () => {
    assert.equal(server.child.exitCode, null, `the server exited: ${server.stderr()}`);
    const { body } = await server.api("GET", `/runs/${started.run_id}`);
    return body.status === "completed" && body.poll_after_ms === 0 ? body : undefined;
  });
  assert.equal(run.result.final_answer, "Soon.");
  await sleep(500);
  assert.equal(server.child.exitCode, null, `the server exited: ${server.stderr()}`);
  assert.equal(server.child.signalCode, null);
  assert.equal((await server.api("GET", "/health")).status, 200);
  assert.match(server.stdout(), new RegExp(`launch_mark_kept.*${started.run_id}`), "the failed removal is logged with its run");
});
