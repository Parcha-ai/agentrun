// The runner the CLI starts beside its server (cli.ts runnerBeside) runs on the server's test switches. `--faux` reaches
// the server as an option (server.ts fauxEnvOf), never through the CLI's own environment, so the runner beside it must be
// handed the same switches: without them it looks the faux model up in pi-ai's own catalog and every run of a --faux start
// fails on its first request. The other tests start their runner in process (support.mjs startInProcessRunner), which
// takes fauxEnvOf itself: only a spawned CLI reaches this wiring.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { agent, client, FAUX, follow, printed, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"f".repeat(40)}`;

test("a --faux start's own runner runs on the faux model: a run answers from it, and none fails on the model's name", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { env: { ...process.env, AGENTRUN_ACCOUNTS: "0", AGENTRUN_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  });
  const out = await printed(child, /^Open /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const run = await api("POST", "/agents/plain/runs", { input: { content: "Say hello." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last, rows } = await follow(api, run.body.run_id, ["completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  const read = await api("GET", `/runs/${run.body.run_id}`);
  assert.equal(last.status, "completed", `the run ended ${last.status}: ${JSON.stringify(read.body)}`);
  assert.ok(JSON.stringify(rows).includes("On Say hello.: done."), `the faux model's answer: ${JSON.stringify(rows)}`);
});
