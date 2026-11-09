// A start on a data root whose CLI server is stopping (its runner draining a run's turn) waits for that stop, saying
// whom it waits for and for how long, then starts: never refused because the stopping server still holds the store. The
// stopping server marks its record (server-lock.ts server.state) as its stop begins; the start reads it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"w".repeat(40)}`;

async function until(check, what, ms = 60_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, `${what} (not in ${ms} ms)`);
}

test("a start while the CLI's server drains its run's turn waits for that stop, saying so, then starts on the data root", { timeout: 120_000 }, async (t) => {
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
  // One press: the server says it drains, its runner holding the run mid-turn for up to 3 s and a second.
  child.kill("SIGINT");
  await until(() => /^agentrun-serve: stopping: waiting up to \d+ s for 1 run to finish its turn$/m.test(out), `the drain line: ${out}`);
  const notices = [];
  const next = await startServe({ data, port: 0, faux: FAUX, notice: (line) => notices.push(line) });
  t.after(() => next.close());
  assert.deepEqual(await exited, { code: 0, signal: null }, out);
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.match(notices[0], new RegExp(`^the server on this data root \\(pid ${child.pid}\\) is stopping; waiting for it, up to \\d+ s$`));
  assert.equal((await client(next.baseUrl, next.token)("GET", "/agents")).status, 200, "the new server serves the data root");
});
