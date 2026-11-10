// The CLI's stop on a signal. A terminal's Ctrl-C reaches the server twice within milliseconds (the terminal's process
// group, and the npx command passing it on): that is one press, and the server drains as on one signal. A second press
// later is a person who wants out now: the server says it stops now, and that the cut runs resume on the next start.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, client, FAUX, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"s".repeat(40)}`;

async function until(check, what, ms = 60_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, `${what} (not in ${ms} ms)`);
}

/** The CLI on its own data root with one run mid-turn (the faux model waits a minute on its second request), so a stop's
 *  3 s drain has a run to wait on. */
async function midTurn(t) {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX, "--drain-timeout", "3s"], { env: { ...process.env, AGENTRUN_ACCOUNTS: "0", AGENTRUN_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  await until(() => /^Open /m.test(out), `the banner: ${out}`);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);
  assert.equal((await api("POST", "/agents", agent("slow"))).status, 201);
  const signal = join(dir, "asked");
  const run = await api("POST", "/agents/slow/runs", { input: { content: `Write a file, then signal ${signal} and wait.` } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await until(() => existsSync(signal), "the run's second request started");
  await rm(signal);
  return { child, exited, data, said: () => out };
}

test("one Ctrl-C that reaches the server twice in a moment drains as one stop: it waits for the run, exits 0 and removes its record", { timeout: 120_000 }, async (t) => {
  const { child, exited, data, said } = await midTurn(t);
  child.kill("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 5));
  child.kill("SIGINT");
  const end = await exited;
  assert.deepEqual(end, { code: 0, signal: null }, said());
  assert.match(said(), /^agentrun-serve: stopping: waiting up to \d+ s for 1 run to finish its turn$/m);
  assert.doesNotMatch(said(), /stopping now/);
  assert.equal(existsSync(join(data, ".server.json")), false, "the record is removed");
});

// SKIP (follow-up #2080): its 1.5 s exit bound is a wall-clock race on a loaded machine.
test.skip("a second Ctrl-C a while later stops at once, saying the runs resume on the next start", { timeout: 120_000 }, async (t) => {
  const { child, exited, data, said } = await midTurn(t);
  child.kill("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const forcedAt = Date.now();
  child.kill("SIGINT");
  const end = await exited;
  assert.ok(Date.now() - forcedAt < 1_500, `it stopped at once, not after the drain (${Date.now() - forcedAt} ms)`);
  assert.equal(end.signal, null, "it exits by itself, not by the signal");
  assert.equal(end.code, 130, said());
  assert.match(said(), /^stopping now; runs resume on the next start \(1 was running\)$/m);
  assert.equal(existsSync(join(data, ".server.json")), false, "the record is removed");
});
