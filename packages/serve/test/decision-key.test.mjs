// The descriptor a workflow run's process is handed the decision key on. macOS aborts the parent of a spawn that puts a
// pipe at descriptor 16 or above, so the key goes on the first one after the child's stdio. CI's macOS job runs this file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { client, FAUX, flowAgent, follow, scratch } from "./support.mjs";
import { CANARY } from "./fixtures/faux-jev.mjs";

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const SERVE = new URL("../dist/index.js", import.meta.url).href;
const DECISIONS = new URL("../dist/decisions.js", import.meta.url).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const coi = {
  v: 2, name: "coi-check",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Coi: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Coi", path: "coi" },
  root: { node: "chain", steps: [{ node: "judge", label: "coi", state: { doc: "{question}" }, out: "Coi", as: "coi" }] },
};

test("a server handed a decision key stays up while a workflow run is handed it, and the run's judge gets it", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const calls = join(dir, "jev-calls.jsonl");
  const script = `const { startServe } = await import(${JSON.stringify(SERVE)});
const server = await startServe({ data: ${JSON.stringify(join(dir, "agents"))}, port: 0, faux: ${JSON.stringify(FAUX)}, fauxJev: ${JSON.stringify(FAUX_JEV)}, drainTimeout: "5s" });
process.stdout.write(JSON.stringify({ base: server.baseUrl, token: server.token }) + "\\n");
process.once("SIGTERM", () => server.close().then(() => process.exit(0)));`;
  const env = { ...process.env, TYPESAFE_API_KEY: CANARY, AGENTRUN_TEST_FAUX_JEV_CALLS: calls };
  delete env.OPENROUTER_API_KEY;
  const server = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env });
  const seen = { out: "", err: "" };
  server.stdout.on("data", (chunk) => (seen.out += chunk));
  server.stderr.on("data", (chunk) => (seen.err += chunk));
  const exited = new Promise((resolve) => server.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    server.kill("SIGTERM");
    await Promise.race([exited, sleep(10_000).then(() => server.kill("SIGKILL"))]);
  });
  const up = () => assert.ok(server.exitCode === null && server.signalCode === null, `the server exited (${server.exitCode ?? server.signalCode}): ${seen.err}`);
  /** `step`, and when it fails with the server gone, that the server went. */
  const whileUp = async (step) => {
    try {
      return await step();
    } catch (error) {
      await Promise.race([exited, sleep(2_000)]);
      up();
      throw error;
    }
  };
  for (let i = 0; !seen.out.includes("\n"); i++) {
    up();
    assert.ok(i < 600, `the server did not start: ${seen.err}`);
    await sleep(50);
  }
  const { base, token } = JSON.parse(seen.out.split("\n")[0]);
  const api = client(base, token);
  assert.equal((await api("POST", "/agents", flowAgent("coi", coi))).status, 201);
  const started = await whileUp(() => api("POST", "/agents/coi/runs", { input: { question: "State of Delaware. Certificate of Incorporation of Example Widgets, Inc." } }));
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { last } = await whileUp(() => follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 }));
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(run.result.output, { is_coi: true });
  const sent = (await readFile(calls, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((call) => call.authorized), [true], "the judge sent the handed key");
  // Below 16 on every platform, so a launch whose stdio grows past it fails here too, not only on a Mac.
  assert.ok(Number(sent[0].key_fd) >= 3 && Number(sent[0].key_fd) < 16, `the key was handed on descriptor ${sent[0].key_fd}, which macOS refuses at 16 and above`);
  up();
  assert.equal((await api("GET", "/capabilities")).status, 200, "and it still answers");
});

test("the run's process reads the key once and closes its descriptor: the number no longer names the pipe", { skip: !existsSync("/proc/self/fdinfo") && "no /proc here" }, async () => {
  // As the server launches it: the key on the first descriptor after stdio. Read, then a file opened takes the lowest
  // free number, which is the key's if it was closed.
  const script = `const { readlinkSync, openSync } = await import("node:fs");
const { handedKey } = await import(${JSON.stringify(DECISIONS)});
const fd = Number(process.env.AGENTRUN_SERVE_DECISION_KEY_FD);
const before = readlinkSync("/proc/self/fd/" + fd);
const key = handedKey(process.env);
openSync(process.execPath, "r");
let after = null;
try { after = readlinkSync("/proc/self/fd/" + fd); } catch {}
process.stdout.write(JSON.stringify({ fd, before, key, after }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe", "pipe"], env: { ...process.env, AGENTRUN_SERVE_DECISION_KEY_FD: "3" } });
  child.stdio[3].end(CANARY);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, err);
  const seen = JSON.parse(out);
  assert.equal(seen.key, CANARY, "the key came through the descriptor");
  assert.match(seen.before, /^(socket|pipe):\[\d+\]$/, "before the read, the descriptor is the handed pipe");
  assert.notEqual(seen.after, seen.before, "after it, the number names something else or nothing");
});
