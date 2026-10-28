// Decision workflows on Jev: a workflow's judge, pick, sift, route and ask nodes run on TypeSafe's System One when this
// server's environment names its key. The key reaches the judge's runner only, never a run's tools, its model, a program
// it starts or a file. Here Jev is the tests' fake fetch (fixtures/faux-jev.mjs): no network, no real key.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { durableDecisions } from "@parcha/agentrun-pi/durable";
import { startServe } from "../dist/index.js";
import { DECISION_KEY_FD } from "../dist/decisions.js";
import { client, FAUX, flowAgent, follow, scratch, serve, storeRun, withEnv } from "./support.mjs";
import { CANARY } from "./fixtures/faux-jev.mjs";

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_TEST_FAUX_JEV_CALLS"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const judge = { node: "judge", label: "coi", state: { doc: "{question}" }, out: "Coi", as: "coi" };
/** A model node that reports where the decision key is, once `gate` exists when one is given. */
const probe = (gate) => ({ node: "extract", label: "probe", instructions: gate ? `Report the canary once ${gate} exists.` : "Report the canary.", out: "Probe", as: "probe" });
const flow = (steps) => ({
  v: 2, name: "coi-check",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Coi: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
    Probe: {
      type: "object", required: ["leaked", "key_set", "fd_open", "sub_leaked", "sub_fd_open", "node_leaked", "node_fd_open"],
      properties: {
        leaked: { type: "boolean" }, key_set: { type: "boolean" }, fd_open: { type: "boolean" }, sub_leaked: { type: "boolean" }, sub_fd_open: { type: "boolean" },
        node_leaked: { type: "boolean" }, node_fd_open: { type: "boolean" },
      },
    },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Probe", path: "probe" },
  root: { node: "chain", steps },
});
/** What a run that cannot reach the key reports. */
const CLEAN = { leaked: false, key_set: false, fd_open: false, sub_leaked: false, sub_fd_open: false, node_leaked: false, node_fd_open: false };
const QUESTION = "State of Delaware. Certificate of Incorporation of Example Widgets, Inc.";

/** The canary as the decision key and a file for the fake Jev's calls, in this process's environment for test `t`. */
async function withCanary(t) {
  const calls = join(await scratch(t), "jev-calls.jsonl");
  withEnv(t, { TYPESAFE_API_KEY: CANARY, AGENTRUN_TEST_FAUX_JEV_CALLS: calls }, KEYS);
  return async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function startFlow(api, steps) {
  const made = await api("POST", "/agents", flowAgent("coi", flow(steps)));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await api("POST", "/agents/coi/runs", { input: { question: QUESTION } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body.run_id;
}

/** The run's process, once it serves its door (after its app, which reads the key, has returned): its pid. */
async function processOf(data, runId, not) {
  for (let i = 0; ; i++) {
    const record = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8").catch(() => "{}"));
    const pid = record.holder?.pid;
    if (record.status === "running" && record.holder?.serve && pid && pid !== not && existsSync(`/proc/${pid}`)) return pid;
    assert.ok(i < 400, "the run's process serves");
    await sleep(50);
  }
}

/** Every file under `dir` (small ones only) whose bytes hold `needle`. */
async function filesHolding(dir, needle) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    if ((await stat(path)).size > 32 * 2 ** 20) continue;
    if ((await readFile(path)).includes(needle)) found.push(path);
  }
  return found;
}

test("the decision key never reaches a run's tools, model or programs: not in its environment, its descriptors, a child process or a file", async (t) => {
  const seen = await withCanary(t);
  const gate = join(await scratch(t), "go");
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [judge, probe(gate)]);
  // While the run's process waits at the probe, after it read the key: as the kernel shows that process.
  const pid = await processOf(data, runId);
  const environ = await readFile(`/proc/${pid}/environ`, "utf8");
  assert.equal(environ.includes(CANARY), false, "the run's process environment holds no copy of the key");
  assert.match(environ, new RegExp(`(^|\\0)AGENTRUN_SERVE_DECISION_KEY_FD=${DECISION_KEY_FD}(\\0|$)`), "it was handed the key on the documented descriptor");
  assert.equal(existsSync(`/proc/${pid}/fd/${DECISION_KEY_FD}`), false, "and closed it once read");
  await writeFile(gate, "");
  const { last } = await follow(api, runId, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(run.result.output, CLEAN, "the model node's process, and an sh and a node -e it starts, see neither the key nor its descriptor");
  assert.deepEqual((await seen()).map((c) => c.authorized), [true], "and the judge did get the key");
  assert.deepEqual(await filesHolding(data, CANARY), [], "no file of the data directory holds the key");
  assert.equal(process.env.TYPESAFE_API_KEY, CANARY, "the server's own environment is as it was");
});

test("a run resumed by the next server is handed the key again: its judge gets it, and its tools still do not", async (t) => {
  const seen = await withCanary(t);
  const dir = await scratch(t);
  const data = join(dir, "agents");
  const gate = join(dir, "go");
  const first = await startServe({ data, port: 0, faux: FAUX, fauxJev: FAUX_JEV, drainTimeout: "5s" });
  let closing;
  const closeFirst = () => {
    closing ??= first.close();
    return closing;
  };
  t.after(closeFirst);
  const runId = await startFlow(client(first.baseUrl, first.token), [probe(gate), judge]);
  const before = await processOf(data, runId);
  await closeFirst();
  assert.equal(storeRun(data, runId).state, "running", "the run had not ended");
  const next = await startServe({ data, port: 0, faux: FAUX, fauxJev: FAUX_JEV, drainTimeout: "5s" });
  t.after(() => next.close());
  const api = client(next.baseUrl, next.token);
  const after = await processOf(data, runId, before);
  assert.equal((await readFile(`/proc/${after}/environ`, "utf8")).includes(CANARY), false);
  assert.equal(existsSync(`/proc/${after}/fd/${DECISION_KEY_FD}`), false);
  await writeFile(gate, "");
  const { last } = await follow(api, runId, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  assert.deepEqual((await seen()).map((c) => [c.pid, c.authorized]), [[after, true]], "the resumed process's judge sent the key");
  assert.deepEqual(run.result.output, CLEAN);
  assert.deepEqual(await filesHolding(data, CANARY), []);
});

test("with no decision key, a run's process gets no key descriptor at all", async (t) => {
  withEnv(t, {}, KEYS);
  const gate = join(await scratch(t), "go");
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [probe(gate)]);
  const pid = await processOf(data, runId);
  assert.equal((await readFile(`/proc/${pid}/environ`, "utf8")).includes("AGENTRUN_SERVE_DECISION_KEY_FD"), false, "no descriptor is named");
  assert.equal(existsSync(`/proc/${pid}/fd/${DECISION_KEY_FD}`), false, "and none is open");
  await writeFile(gate, "");
  const { last } = await follow(api, runId, ["completed", "failed"]);
  assert.equal(last.status, "completed");
});

test("with TYPESAFE_API_KEY set, a judge workflow runs on Jev and its decision is recorded in the run", async (t) => {
  const seen = await withCanary(t);
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [judge, probe()]);
  const { last } = await follow(api, runId, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  const calls = await seen();
  assert.equal(calls.length, 1, "one System One request");
  assert.deepEqual([calls[0].path, calls[0].authorized, calls[0].questions], ["/v1/systemone", true, ["is_coi"]], "sent with the key the server's environment names");
  const rows = durableDecisions(join(data, "runs", runId, "store", "run.sqlite"));
  assert.equal(rows.length, 1, "the decision's receipt is a row of the run's store");
  assert.equal(rows[0].kind, "judge");
  assert.equal(rows[0].answers.is_coi.noul, 0.92);
});

test("a decision whose cost is unknown leaves the run's cost unknown, never $0", async (t) => {
  await withCanary(t);
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [judge, probe()]);
  const { last } = await follow(api, runId, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  const rows = durableDecisions(join(data, "runs", runId, "store", "run.sqlite"));
  assert.equal(rows[0].cost_usd, null, "Jev reports no cost, and no price is set: the receipt says unknown");
  assert.equal(run.cost.usd, null, "the run's cost reads unknown");
  assert.equal(storeRun(data, runId).costUsd ?? null, null, "and the store keeps no cost for it");
});

test("with no decision key, a judge workflow saves with a warning, and its run is 409 not_set_up_here naming TYPESAFE_API_KEY", async (t) => {
  withEnv(t, {}, KEYS);
  const { api } = await serve(t, { fauxJev: FAUX_JEV });
  const made = await api("POST", "/agents", flowAgent("coi", flow([judge, probe()])));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const warning = made.body.warnings.find((w) => w.field === "definition.workflow");
  assert.equal(warning?.reason, "not_set_up_here", JSON.stringify(made.body.warnings));
  assert.match(warning.message, /TYPESAFE_API_KEY/);
  const refused = await api("POST", "/agents/coi/runs", { input: { question: "x" } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.match(refused.body.error.message, /TYPESAFE_API_KEY/);
  assert.deepEqual(refused.body.error.details.adapters, ["runJudge"]);
  assert.deepEqual(refused.body.error.details.decisions, { jev: { reason: "not_set_up_here", needs: ["TYPESAFE_API_KEY"] } });
});

test("capabilities lists the decision providers: jev available where its key is set, why not where it is not, and a note when its key is the gateway's", async (t) => {
  withEnv(t, {}, KEYS);
  const off = await serve(t);
  const caps = (await off.api("GET", "/capabilities")).body;
  assert.ok(caps.workflows.decisions, "capabilities has workflows.decisions");
  const none = caps.workflows.decisions.providers;
  assert.equal(none.length, 1);
  assert.deepEqual([none[0].id, none[0].available], ["jev", false]);
  assert.match(none[0].reason, /TYPESAFE_API_KEY/);
  process.env.TYPESAFE_API_KEY = CANARY;
  const on = await serve(t);
  assert.deepEqual((await on.api("GET", "/capabilities")).body.workflows.decisions?.providers, [{ id: "jev", available: true }]);
  assert.ok((await on.api("GET", "/capabilities")).body.workflows.adapters.includes("runJudge"));
  delete process.env.TYPESAFE_API_KEY;
  process.env.OPENROUTER_API_KEY = "sk-or-test-not-a-key";
  const gateway = await serve(t);
  const [routed] = (await gateway.api("GET", "/capabilities")).body.workflows.decisions.providers;
  assert.deepEqual([routed.id, routed.available, routed.reason], ["jev", true, undefined]);
  assert.match(routed.note ?? "", /model gateway/, "on the OpenRouter route the Jev key is the gateway's, and capabilities says so");
  assert.match(routed.note ?? "", /TYPESAFE_API_KEY/);
});
