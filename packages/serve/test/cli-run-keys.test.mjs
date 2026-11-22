// A real API-only server (the CLI on the faux model, AGENTRUN_API_ONLY=1 and AGENTRUN_RUN_KEYS=1), through its HTTP API
// alone: an inline agent whose web search is Parallel's is refused with no key, refused for a key none of its tools
// reads, and runs when the run carries its key, though its model quotes the key. The key is in no file of the data
// directory, no answer about the run and no line the process printed.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { client, FAUX, follow, printed, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"k".repeat(40)}`;
const CLEARED = ["PARALLEL_API_KEY", "MONID_API_KEY", "TYPESAFE_API_KEY", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY"];

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

test("an API-only server takes a run's own tool key through its API: refused without it, refused for a key no tool reads, run with it, and the key is nowhere after", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const key = ["not-a-secret", "cli-run-key", randomBytes(8).toString("hex")].join("-");
  const file = join(dir, "key.txt");
  writeFileSync(file, key);
  const env = { ...process.env, AGENTRUN_API_ONLY: "1", AGENTRUN_RUN_KEYS: "1", AGENTRUN_TOKEN: TOKEN };
  for (const name of CLEARED) delete env[name];
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
  const out = await printed(child, /^API only /m);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);

  const inline = (version, extra) => ({
    external: { source: "host", kind: "agent", id: "quoter", version },
    definition: { name: "quoter", instructions: "Answer.", tools: ["read", "web_search"], tool_settings: { web_search: { provider: "parallel" } } },
    input: { content: `Quote the key in ${file}` },
    ...extra,
  });
  const bare = await api("POST", "/runs", inline(1));
  assert.deepEqual([bare.status, bare.body.error?.code], [409, "agent_not_runnable"], JSON.stringify(bare.body));
  const wrong = await api("POST", "/runs", inline(1, { keys: { MONID_API_KEY: key } }));
  assert.deepEqual([wrong.status, wrong.body.error?.fields?.map((one) => one.field)], [422, ["keys.MONID_API_KEY"]], JSON.stringify(wrong.body));
  assert.ok(!JSON.stringify(wrong.body).includes(key), "never echoed");

  const started = await api("POST", "/runs", inline(1, { keys: { PARALLEL_API_KEY: key } }));
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { last } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 120_000 });
  assert.equal(last.status, "completed", JSON.stringify((await api("GET", `/runs/${runId}`)).body));

  for (const path of [`/runs/${runId}`, `/runs/${runId}/timeline`]) assert.ok(!JSON.stringify((await api("GET", path)).body).includes(key), `${path} holds no key`);
  assert.deepEqual(filesHolding(data, key), [], "no file of the data directory holds the key");
  assert.ok(!output.join("").includes(key), "the process printed no key");
});
