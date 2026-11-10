// The descriptor a workflow run's process is handed the decision key on. macOS aborts the parent of a spawn that puts a
// pipe at descriptor 16 or above, so the key goes on the first one after the child's stdio and its secrets pipe. CI's
// macOS job runs this file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { client, FAUX, flowAgent, follow, printed, scratch } from "./support.mjs";
import { CANARY } from "./fixtures/faux-jev.mjs";

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const SERVE = new URL("../dist/index.js", import.meta.url).href;
const DECISIONS = new URL("../dist/decisions.js", import.meta.url).href;
const SECRETS = new URL("../dist/secrets.js", import.meta.url).href;
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

test("the run's process reads the keys once and closes their descriptor: the number no longer names the pipe", { skip: !existsSync("/proc/self/fdinfo") && "no /proc here" }, async () => {
  // As the server launches it: the keys on the first descriptor after stdio and the secrets pipe. Read, then a file
  // opened takes the lowest free number, which is the keys' if it was closed.
  const script = `const { readlinkSync, openSync } = await import("node:fs");
const { handedKeys } = await import(${JSON.stringify(DECISIONS)});
const fd = Number(process.env.AGENTRUN_SERVE_DECISION_KEY_FD);
const before = readlinkSync("/proc/self/fd/" + fd);
const keys = handedKeys(process.env);
openSync(process.execPath, "r");
let after = null;
try { after = readlinkSync("/proc/self/fd/" + fd); } catch {}
process.stdout.write(JSON.stringify({ fd, before, keys, after }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe", "ignore", "pipe"], env: { ...process.env, AGENTRUN_SERVE_DECISION_KEY_FD: "4" } });
  child.stdio[4].end(JSON.stringify({ TYPESAFE_API_KEY: CANARY }));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, err);
  const seen = JSON.parse(out);
  assert.deepEqual(seen.keys, { TYPESAFE_API_KEY: CANARY }, "the keys came through the descriptor");
  assert.match(seen.before, /^(socket|pipe):\[\d+\]$/, "before the read, the descriptor is the handed pipe");
  assert.notEqual(seen.after, seen.before, "after it, the number names something else or nothing");
});

test("the run's process keeps only the decision keys from its descriptor: another name the object carries reaches no provider and no environment", { skip: !existsSync("/proc/self/fdinfo") && "no /proc here" }, async () => {
  // The object also carries a name no decision provider takes, with a value of its own, beside the three it may carry.
  const other = `not-a-decision-key-${process.pid}-${Date.now()}`;
  const script = `const { spawnSync } = await import("node:child_process");
const { handedKeys } = await import(${JSON.stringify(DECISIONS)});
const { secret, withSecrets } = await import(${JSON.stringify(SECRETS)});
const keys = handedKeys(process.env);
const holds = (text) => typeof text === "string" && text.includes(${JSON.stringify(other)});
const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { encoding: "utf8" });
const tools = withSecrets(process.env);
process.stdout.write(JSON.stringify({
  names: Object.keys(keys).sort(),
  kept: Object.values(keys).some(holds),
  env: Object.values(process.env).some(holds),
  child: holds(child.stdout),
  tools: holds(tools.AGENT_MODEL_API_KEY) || holds(secret("AGENT_MODEL_API_KEY")),
}));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe", "ignore", "pipe"], env: { ...process.env, AGENTRUN_SERVE_DECISION_KEY_FD: "4" } });
  child.stdio[4].end(JSON.stringify({ TYPESAFE_API_KEY: CANARY, OPENROUTER_API_KEY: CANARY, PARALLEL_API_KEY: CANARY, AGENT_MODEL_API_KEY: other }));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, err);
  const seen = JSON.parse(out);
  assert.deepEqual(seen.names, ["OPENROUTER_API_KEY", "PARALLEL_API_KEY", "TYPESAFE_API_KEY"], "the decision keys, and only they");
  assert.deepEqual([seen.kept, seen.env, seen.child, seen.tools], [false, false, false, false], "the other name's value is in no provider's keys, no environment, no child's and no tools'");
});
