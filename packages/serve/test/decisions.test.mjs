// Decision workflows on Jev and Parallel: a workflow's judge, pick, sift, route and ask nodes run on TypeSafe's System
// One, or on Parallel Decisions for a node that names it, when this server's environment names the provider's key. A key
// reaches its provider only (Parallel's also web_fetch, which reads pages through Parallel), never a run's environment,
// its model, a program it starts or a file. Here each provider is the tests' fake fetch (fixtures/faux-jev.mjs,
// fixtures/faux-parallel.mjs): no network, no real key.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { durableDecisions } from "@parcha/agentrun-pi/durable";
import { startServe } from "../dist/index.js";
import { DECISION_KEY_FD_ENV, decisionsOf, FAUX_JEV_ENV, jevRoute } from "../dist/decisions.js";
import { FAUX_ENV } from "../dist/model.js";
import { client, FAUX, flowAgent, follow, scratch, serve, storeRun, withEnv } from "./support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { CANARY } from "./fixtures/faux-jev.mjs";
import { CANARY as PARALLEL_CANARY } from "./fixtures/faux-parallel.mjs";

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;
const KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AGENTRUN_TEST_FAUX_JEV_CALLS", "AGENTRUN_TEST_FAUX_JEV_STATUS", "AGENTRUN_TEST_FAUX_JEV_HANG", "AGENTRUN_TEST_FAUX_JEV_COST", "PARALLEL_API_KEY", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS", "AGENTRUN_TEST_FAUX_JEV_NO_USAGE"];
const OPENROUTER_GATEWAY = "https://openrouter.ai/api/v1";
/** Keys that are not the canary, so a request sent with one is not authorized: held in names, as no key literal sits beside a key variable. */
const OTHER_ROUTER_KEY = "openrouter-key-not-jevs";
const OTHER_GATEWAY_KEY = "gateway-key-not-jevs";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The descriptor a run's process is handed the key on: the first one after its stdio and its secrets pipe. */
const KEY_FD = "4";
/** The descriptor `environ` names for the key, without printing the rest of it. */
const keyFdIn = (environ) => /(?:^|\0)AGENTRUN_SERVE_DECISION_KEY_FD=([^\0]*)/.exec(environ)?.[1];
/** Whether `pid`'s descriptor `fd` is a Unix socket, as the handed one is (one end of a socket pair). A run's process
 *  opens no other, and a closed low number is soon open again for something else, so "not open" would prove nothing. */
async function handedSocket(pid, fd) {
  const inode = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ""))?.[1];
  return inode !== undefined && (await readFile(`/proc/${pid}/net/unix`, "utf8")).split("\n").some((line) => line.trim().split(/\s+/)[6] === inode);
}

const judge = { node: "judge", label: "coi", state: { doc: "{question}" }, out: "Coi", as: "coi" };
/** The same question, put to Parallel. */
const onParallel = { ...judge, label: "coi-parallel", as: "coi_parallel", provider: "parallel" };
/** A model node that reports where the decision key is, once `gate` exists when one is given. */
const probe = (gate) => ({ node: "extract", label: "probe", instructions: gate ? `Report the canary once ${gate} exists.` : "Report the canary.", out: "Probe", as: "probe" });
const flow = (steps, output = { schemaId: "Probe", path: "probe" }) => ({
  v: 2, name: "coi-check",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Coi: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
    Probe: {
      type: "object", required: ["leaked", "key_set", "fd_open", "sub_leaked", "sub_fd_open", "node_leaked", "node_fd_open", "host_env_leaked"],
      properties: {
        leaked: { type: "boolean" }, key_set: { type: "boolean" }, fd_open: { type: "boolean" }, sub_leaked: { type: "boolean" }, sub_fd_open: { type: "boolean" },
        node_leaked: { type: "boolean" }, node_fd_open: { type: "boolean" }, host_env_leaked: { type: "boolean" },
      },
    },
  },
  input: { schemaId: "In" },
  output,
  root: { node: "chain", steps },
});
/** What a run that cannot reach the key reports. */
const CLEAN = { leaked: false, key_set: false, fd_open: false, sub_leaked: false, sub_fd_open: false, node_leaked: false, node_fd_open: false, host_env_leaked: false };
const QUESTION = "State of Delaware. Certificate of Incorporation of Example Widgets, Inc.";

/** The canary as the decision key and a file for the fake Jev's calls, in this process's environment for test `t`. */
async function withCanary(t) {
  const calls = join(await scratch(t), "jev-calls.jsonl");
  withEnv(t, { TYPESAFE_API_KEY: CANARY, AGENTRUN_TEST_FAUX_JEV_CALLS: calls }, KEYS);
  return async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** The decision keys `which` names as canaries, and a file for each fake's calls, for test `t`: what each fake was sent. */
async function withKeys(t, which) {
  const dir = await scratch(t);
  const files = { jev: join(dir, "jev-calls.jsonl"), parallel: join(dir, "parallel-calls.jsonl") };
  withEnv(t, {
    ...(which.jev ? { TYPESAFE_API_KEY: CANARY } : {}), ...(which.parallel ? { PARALLEL_API_KEY: PARALLEL_CANARY } : {}),
    AGENTRUN_TEST_FAUX_JEV_CALLS: files.jev, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: files.parallel,
  }, KEYS);
  const read = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return async () => ({ jev: await read(files.jev), parallel: await read(files.parallel) });
}

async function startFlow(api, steps, output, { schemas = {}, tools } = {}) {
  const doc = flow(steps, output);
  Object.assign(doc.schemas, schemas);
  const made = await api("POST", "/agents", flowAgent("coi", doc, tools ? { tools } : {}));
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

/** The escalation kinds the run's ended tasks hold, from its released store. */
function escalations(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return db.prepare("SELECT record FROM tasks").all().map((row) => JSON.parse(row.record).state?.outcome?.result?.escalation?.kind).filter(Boolean);
  } finally {
    db.close();
  }
}

/** The failure messages the run's ended tasks hold, from its released store. */
function failures(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return db.prepare("SELECT record FROM tasks").all().map((row) => JSON.parse(row.record).state?.outcome?.error?.message).filter(Boolean);
  } finally {
    db.close();
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
  assert.equal(keyFdIn(environ), KEY_FD, "it was handed the key on the first descriptor after its stdio and secrets");
  assert.equal(await handedSocket(pid, KEY_FD), false, "and closed it once read");
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
  assert.equal(keyFdIn(await readFile(`/proc/${after}/environ`, "utf8")), KEY_FD);
  assert.equal(await handedSocket(after, KEY_FD), false);
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
  assert.equal(await handedSocket(pid, KEY_FD), false, "and none is open");
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

test("a System One request that fails after it was sent (a 503) is sent once, and the run escalates as an interrupted decision", async (t) => {
  const seen = await withCanary(t);
  process.env.AGENTRUN_TEST_FAUX_JEV_STATUS = "503";
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [judge, probe()]);
  await follow(api, runId, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal((await seen()).length, 1, "a request that may have been answered and billed is never sent again");
  // An escalated run ends completed and waits for review, never failed.
  assert.deepEqual([run.status, run.error, run.review?.kind], ["completed", null, "decision_interrupted"], JSON.stringify([run.error, run.review]));
  assert.deepEqual(escalations(join(data, "runs", runId, "store", "run.sqlite")), ["decision_interrupted"], "the run waits for review as an interrupted decision");
});

test("each decision Jev answers is booked at TypeSafe's published price as an estimate, and the run's cost is their sum, once", async (t) => {
  await withCanary(t);
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  // Two decisions and no model node: the run's cost is the decisions' alone.
  const twice = { ...flow([judge, { ...judge, label: "coi_again", as: "coi_again" }]), output: { schemaId: "Coi", path: "coi" } };
  const made = await api("POST", "/agents", flowAgent("coi", twice));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await api("POST", "/agents/coi/runs", { input: { question: QUESTION } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { last } = await follow(api, runId, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  // The fake answers each call with 120 input tokens and none out; TypeSafe prices input at $0.042 per million.
  const each = (120 * 0.042 + 0 * 0) / 1_000_000;
  const rows = durableDecisions(join(data, "runs", runId, "store", "run.sqlite"));
  assert.deepEqual(rows.map((row) => row.cost_usd), [each, each], "each receipt holds its own estimate");
  assert.equal(run.cost.usd, each + each, "the run's cost is the two decisions' sum, counted once");
  assert.equal(run.cost.basis, "estimate");
  assert.equal(storeRun(data, runId).costUsd, each + each, "and the store keeps the same");
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
  assert.deepEqual(none.map((p) => [p.id, p.available]), [["jev", false], ["parallel", false], ["openrouter", false]]);
  assert.match(none[0].reason, /TYPESAFE_API_KEY/);
  process.env.TYPESAFE_API_KEY = CANARY;
  const on = await serve(t);
  assert.deepEqual((await on.api("GET", "/capabilities")).body.workflows.decisions?.providers[0], { id: "jev", available: true });
  assert.ok((await on.api("GET", "/capabilities")).body.workflows.adapters.includes("runJudge"));
  delete process.env.TYPESAFE_API_KEY;
  process.env.OPENROUTER_API_KEY = "fake-test-key";
  const gateway = await serve(t);
  const [routed] = (await gateway.api("GET", "/capabilities")).body.workflows.decisions.providers;
  assert.deepEqual([routed.id, routed.available, routed.reason], ["jev", true, undefined]);
  assert.match(routed.note ?? "", /model gateway/, "on the OpenRouter route the Jev key is the gateway's, and capabilities says so");
  assert.match(routed.note ?? "", /TYPESAFE_API_KEY/);
  const openrouter = (await gateway.api("GET", "/capabilities")).body.workflows.decisions.providers[2];
  assert.deepEqual([openrouter.id, openrouter.available], ["openrouter", true], "the gateway's key runs OpenRouter's decision models too");
});

/** A server on the decision variables `vars`, what its capabilities offer of jev, and a judge workflow's run on it: the
 *  run's end and the System One requests the fake Jev took, each as [path, sent with the canary]. */
async function jevOn(t, vars) {
  const calls = join(await scratch(t), "jev-calls.jsonl");
  withEnv(t, { ...vars, AGENTRUN_TEST_FAUX_JEV_CALLS: calls }, KEYS);
  const { api } = await serve(t, { fauxJev: FAUX_JEV });
  const { adapters, decisions } = (await api("GET", "/capabilities")).body.workflows;
  const judged = async () => {
    const runId = await startFlow(api, [judge], { schemaId: "Coi", path: "coi" });
    const { last } = await follow(api, runId, ["completed", "failed"]);
    const run = (await api("GET", `/runs/${runId}`)).body;
    const sent = (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { status: last.status, error: run.error, sent: sent.map((c) => [c.path, c.authorized]) };
  };
  return { api, adapters, offer: decisions.providers.find((p) => p.id === "jev"), judged };
}

test("TYPESAFE_API_KEY wins over OPENROUTER_API_KEY and an OpenRouter gateway's key: the judge sends it to TypeSafe, and capabilities has no note", async (t) => {
  const jev = await jevOn(t, { TYPESAFE_API_KEY: CANARY, OPENROUTER_API_KEY: OTHER_ROUTER_KEY, AGENT_MODEL_BASE_URL: OPENROUTER_GATEWAY, AGENT_MODEL_API_KEY: OTHER_GATEWAY_KEY });
  assert.deepEqual(jev.offer, { id: "jev", available: true }, "no note: the decision key stays out of a run's processes");
  const run = await jev.judged();
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(run.sent, [["/v1/systemone", true]], "one request, to TypeSafe, with the TypeSafe key");
});

test("OPENROUTER_API_KEY wins over an OpenRouter gateway's key: the judge sends it to OpenRouter, and the note names it", async (t) => {
  const jev = await jevOn(t, { OPENROUTER_API_KEY: CANARY, AGENT_MODEL_BASE_URL: OPENROUTER_GATEWAY, AGENT_MODEL_API_KEY: OTHER_GATEWAY_KEY });
  assert.deepEqual([jev.offer.available, jev.offer.reason], [true, undefined]);
  assert.match(jev.offer.note ?? "", /^Jev runs on OPENROUTER_API_KEY, /, JSON.stringify(jev.offer));
  assert.doesNotMatch(jev.offer.note, /AGENT_MODEL_API_KEY/);
  const run = await jev.judged();
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(run.sent, [["/api/v1/systemone", true]], "one request, to OpenRouter, with OPENROUTER_API_KEY");
});

test("on an OpenRouter gateway alone, Jev runs on AGENT_MODEL_API_KEY: capabilities names it, and the judge sends it to OpenRouter", async (t) => {
  const jev = await jevOn(t, { AGENT_MODEL_BASE_URL: OPENROUTER_GATEWAY, AGENT_MODEL_API_KEY: CANARY });
  assert.deepEqual([jev.offer?.available, jev.offer?.reason], [true, undefined], JSON.stringify(jev.offer));
  assert.match(jev.offer.note ?? "", /^Jev runs on AGENT_MODEL_API_KEY, the model gateway key/, JSON.stringify(jev.offer));
  assert.match(jev.offer.note, /hold in their environment/, "the note says a run's processes hold the key");
  assert.match(jev.offer.note, /Set TYPESAFE_API_KEY to keep the decision key out of them/);
  assert.ok(jev.adapters.includes("runJudge"));
  const run = await jev.judged();
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(run.sent, [["/api/v1/systemone", true]], "one request, to OpenRouter, with the gateway's key");
});

test("on the four gateway variables alone, the run's process is handed AGENT_MODEL_API_KEY on the decision descriptor, closes it, and its judge sends that key to OpenRouter", async (t) => {
  const calls = join(await scratch(t), "jev-calls.jsonl");
  withEnv(t, { AGENT_MODEL_BASE_URL: OPENROUTER_GATEWAY, AGENT_MODEL_API_KEY: CANARY, ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_API_KEY: CANARY, AGENTRUN_TEST_FAUX_JEV_CALLS: calls }, KEYS);
  const gate = join(await scratch(t), "go");
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [judge, probe(gate)]);
  const pid = await processOf(data, runId);
  const environ = await readFile(`/proc/${pid}/environ`, "utf8");
  assert.equal(keyFdIn(environ), KEY_FD, "the gateway's key was handed on the decision descriptor");
  assert.equal(await handedSocket(pid, KEY_FD), false, "and the descriptor closed once read");
  await writeFile(gate, "");
  const { last } = await follow(api, runId, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  const sent = (await readFile(calls, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((c) => [c.pid, c.path, c.authorized]), [[pid, "/api/v1/systemone", true]], "the run's judge sent the gateway's key to OpenRouter");
});

/** decisionProvidersOf in a process of its own, as a run's process calls it: its environment is `env` alone, and
 *  `handed` (keys by name) comes on the decision descriptor when given. Whether it made a judge, and what the fake
 *  Jev took. */
async function judgeIn(t, env, handed) {
  const calls = join(await scratch(t), "jev-calls.jsonl");
  const script = `const { decisionProvidersOf } = await import(${JSON.stringify(new URL("../dist/decisions.js", import.meta.url).href)});
const { judgeFromProviders } = await import("@parcha/agentrun-dsl");
const providers = await decisionProvidersOf(process.env);
const judge = providers && judgeFromProviders(providers);
const answer = judge && await judge({ label: "coi", kind: "judge", state: { doc: "x" }, questions: { is_coi: { type: "noul", instructions: "Is doc a certificate of incorporation?" } } });
process.stdout.write(JSON.stringify({ judge: Boolean(judge), noul: answer?.answers?.is_coi?.noul ?? null }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { HOME: process.env.HOME, [FAUX_ENV]: FAUX, [FAUX_JEV_ENV]: FAUX_JEV, AGENTRUN_TEST_FAUX_JEV_CALLS: calls, ...env, ...(handed ? { [DECISION_KEY_FD_ENV]: KEY_FD } : {}) },
    // As a run's process has them: the secrets pipe on 3 (none here), the key on the next.
    stdio: ["ignore", "pipe", "pipe", "ignore", ...(handed ? ["pipe"] : [])],
  });
  // What the server writes there: the keys by name, as one JSON object.
  if (handed) child.stdio[Number(KEY_FD)].end(JSON.stringify(handed));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0, err);
  const sent = (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => [JSON.parse(line).path, JSON.parse(line).authorized]);
  return { ...JSON.parse(out), sent };
}

test("a run's judge runs on the key handed on the decision descriptor alone: with no key in its environment it answers, and with keys only in its environment there is no judge", async (t) => {
  const handedOnly = await judgeIn(t, {}, { OPENROUTER_API_KEY: CANARY });
  assert.deepEqual(handedOnly, { judge: true, noul: 0.92, sent: [["/api/v1/systemone", true]] }, "the gateway's key, deleted from its environment, still reaches OpenRouter from the descriptor");
  const envOnly = await judgeIn(t, { OPENROUTER_API_KEY: CANARY, AGENT_MODEL_BASE_URL: OPENROUTER_GATEWAY, AGENT_MODEL_API_KEY: CANARY, TYPESAFE_API_KEY: CANARY });
  assert.deepEqual(envOnly, { judge: false, noul: null, sent: [] }, "a key in the environment is never the judge's");
});

test("a gateway whose host is not exactly openrouter.ai, or no gateway key, leaves Jev unavailable: capabilities says why and a judge run is 409", async (t) => {
  const others = [
    "https://openrouter.ai.example.com/v1", "https://example.com/openrouter.ai/v1", "https://user@openrouter.ai@example.com/v1", "https://notopenrouter.ai/api/v1",
    "https://api.openai.com/v1", "http://127.0.0.1:9/openrouter.ai", "openrouter.ai/api/v1", "not a url",
  ];
  for (const base of others) {
    const env = { AGENT_MODEL_BASE_URL: base, AGENT_MODEL_API_KEY: OTHER_GATEWAY_KEY };
    assert.equal(jevRoute(env), undefined, base);
    assert.equal(decisionsOf(env)[0].available, false, base);
  }
  for (const key of [undefined, " "]) assert.equal(jevRoute({ AGENT_MODEL_BASE_URL: OPENROUTER_GATEWAY, AGENT_MODEL_API_KEY: key }), undefined, "OpenRouter's gateway with no key of its own");
  const jev = await jevOn(t, { AGENT_MODEL_BASE_URL: "https://openrouter.ai.example.com/v1", AGENT_MODEL_API_KEY: CANARY });
  assert.deepEqual([jev.offer.available, jev.offer.note], [false, undefined]);
  assert.match(jev.offer.reason, /AGENT_MODEL_API_KEY/, "the reason names the gateway route too");
  assert.equal(jev.adapters.includes("runJudge"), false);
  assert.equal((await jev.api("POST", "/agents", flowAgent("coi", flow([judge], { schemaId: "Coi", path: "coi" })))).status, 201);
  const refused = await jev.api("POST", "/agents/coi/runs", { input: { question: QUESTION } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.details.decisions, { jev: { reason: "not_set_up_here", needs: ["TYPESAFE_API_KEY"] } });
});

test("with no decision key, Jev is unavailable and the reason names each way to run it: TYPESAFE_API_KEY, OPENROUTER_API_KEY, or an OpenRouter gateway's AGENT_MODEL_API_KEY", async (t) => {
  withEnv(t, {}, KEYS);
  const { api } = await serve(t);
  const [offer] = (await api("GET", "/capabilities")).body.workflows.decisions.providers;
  assert.deepEqual([offer.id, offer.available, offer.note], ["jev", false, undefined]);
  for (const name of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_API_KEY", "AGENT_MODEL_BASE_URL"]) assert.match(offer.reason, new RegExp(name), offer.reason);
  assert.match(offer.reason, /openrouter\.ai/, offer.reason);
});

test("a node naming a decision provider this server does not run is refused at save, by name", async (t) => {
  const seen = await withCanary(t);
  const { api } = await serve(t, { fauxJev: FAUX_JEV });
  const made = await api("POST", "/agents", flowAgent("coi", flow([{ ...judge, provider: "acme" }, probe()])));
  assert.equal(made.status, 422, JSON.stringify(made.body));
  assert.ok(made.body.error.fields?.some((issue) => issue.field === "definition.workflow" && issue.reason === "not_an_option" && /names the provider acme/.test(issue.message)), JSON.stringify(made.body.error));
  assert.deepEqual(await seen(), [], "Jev was never asked in its place");
});

test("a node asking what its provider cannot give is refused before the run, by name, and never sent: evidence required of Jev", async (t) => {
  const seen = await withCanary(t);
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [{ ...judge, provider: "jev", evidence: "required" }, probe()]);
  const { last } = await follow(api, runId, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(last.status, "failed", JSON.stringify(run));
  assert.match(failures(join(data, "runs", runId, "store", "run.sqlite")).join("\n"), /judge node "coi" requires evidence, and the decision provider jev gives none/);
  assert.deepEqual(await seen(), [], "the request was never sent");
});

test("a node's timeoutMs bounds its decision: with Jev never answering, the request is cut at the node's bound and the run escalates it as interrupted", async (t) => {
  await withCanary(t);
  process.env.AGENTRUN_TEST_FAUX_JEV_HANG = "1";
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [{ ...judge, provider: "jev", timeoutMs: 200 }, probe()]);
  // Jev's own deadline is 30 s: a run that ends well inside it ended on the node's bound.
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 20_000 });
  assert.deepEqual(escalations(join(data, "runs", runId, "store", "run.sqlite")), ["decision_interrupted"]);
});

test("a decision's receipt names the provider that answered it", async (t) => {
  await withCanary(t);
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [judge, probe()]);
  const { last } = await follow(api, runId, ["completed", "failed"]);
  assert.equal(last.status, "completed", JSON.stringify((await api("GET", `/runs/${runId}`)).body.error));
  assert.deepEqual(durableDecisions(join(data, "runs", runId, "store", "run.sqlite")).map((row) => row.provider), ["jev"]);
});

test("a workflow that escalates ends completed and waits for review: no error, no output, and review names its kind, node and reason", async (t) => {
  await withCanary(t);
  const { api, baseUrl } = await serve(t, { fauxJev: FAUX_JEV });
  const gate = { node: "escalate", label: "review_is_coi", when: { predicate: "gte", path: "coi$answers.answers.is_coi.noul", n: 0.9 }, kind: "coi_review", stage: "coi", summary: "Review: is_coi is at least 0.9, so a person looks." };
  const runId = await startFlow(api, [judge, gate, probe()]);
  await follow(api, runId, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.state, run.error, run.result?.output ?? null], ["completed", "idle", null, null], JSON.stringify(run.error));
  const { at, ...review } = run.review ?? {};
  assert.deepEqual(review, { kind: "coi_review", node: "review_is_coi", reason: "Review: is_coi is at least 0.9, so a person looks." });
  assert.ok(Number.isFinite(Date.parse(at)), "review.at is a time");
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.Run.properties.review, run.review), [], "the review meets the served document");
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.Run.properties.review, null), [], "and so does no review");
  const listed = (await api("GET", "/runs")).body.runs.find((row) => row.run_id === runId);
  assert.deepEqual([listed.status, listed.error, listed.review], ["completed", null, run.review], "the list says the same");
  // A workflow run takes no messages here, escalated or not: the refusal it always had.
  const message = await api("POST", `/runs/${runId}/messages`, { content: "approved" });
  assert.deepEqual([message.status, message.body.error?.code], [501, "unsupported_here"]);
  // A run that did not escalate has no review.
  assert.equal((await api("POST", "/agents", flowAgent("plain", flow([judge, probe()])))).status, 201);
  const plain = (await api("POST", "/agents/plain/runs", { input: { question: QUESTION } })).body.run_id;
  await follow(api, plain, ["completed", "failed"]);
  assert.equal((await api("GET", `/runs/${plain}`)).body.review, null);
});


test("a workflow whose decision cost is unknown and whose model request is priced reads its cost unknown, before and after the server restarts", async (t) => {
  await withCanary(t);
  process.env.AGENTRUN_TEST_FAUX_JEV_NO_USAGE = "1";
  const data = join(await scratch(t), "agents");
  const priced = new URL("./fixtures/faux-priced.mjs", import.meta.url).pathname;
  const first = await startServe({ data, port: 0, faux: priced, fauxJev: FAUX_JEV, drainTimeout: "5s" });
  let closing;
  const closeFirst = () => (closing ??= first.close());
  t.after(closeFirst);
  const api = client(first.baseUrl, first.token);
  const runId = await startFlow(api, [judge, probe()]);
  const { last } = await follow(api, runId, ["completed", "failed"]);
  const before = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(before.error));
  assert.equal(durableDecisions(join(data, "runs", runId, "store", "run.sqlite"))[0].cost_usd, null, "Jev counts no tokens: the decision's cost is unknown");
  const rows = (await api("GET", `/runs/${runId}/timeline?limit=500`)).body.rows;
  assert.deepEqual(rows.filter((row) => row.kind === "decision").map((row) => row.usage), [{ usd: null, requests: 1 }], "the decision's own cost is unknown");
  const usage = rows.findLast((row) => row.kind === "usage");
  assert.deepEqual([usage?.usage?.usd, usage?.usage?.requests], [null, 2], "the usage row folds the decision in: its unknown cost makes the total unknown, never the priced model's alone");
  assert.equal(before.cost.usd, null, "the decision's unknown cost is the run's");
  await closeFirst();
  const next = await startServe({ data, port: 0, faux: priced, fauxJev: FAUX_JEV, drainTimeout: "5s" });
  t.after(() => next.close());
  const after = (await client(next.baseUrl, next.token)("GET", `/runs/${runId}`)).body;
  assert.equal(after.status, "completed");
  assert.equal(after.cost.usd, null, "and still after a restart: never the model's cost alone");
});

test("an ended workflow run whose decisions cannot be read after the server restarts reads its cost unknown, while its readable twin reads the known sum", async (t) => {
  await withCanary(t);
  process.env.AGENTRUN_TEST_FAUX_JEV_COST = "0.00003";
  const data = join(await scratch(t), "agents");
  const priced = new URL("./fixtures/faux-priced.mjs", import.meta.url).pathname;
  const first = await startServe({ data, port: 0, faux: priced, fauxJev: FAUX_JEV, drainTimeout: "5s" });
  let closing;
  const closeFirst = () => (closing ??= first.close());
  t.after(closeFirst);
  const api = client(first.baseUrl, first.token);
  // Two runs of one workflow, its decision and its model node both priced: one keeps its store, its twin loses its decisions.
  const kept = await startFlow(api, [judge, probe()]);
  const started = await api("POST", "/agents/coi/runs", { input: { question: QUESTION } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const twin = started.body.run_id;
  for (const runId of [kept, twin]) assert.equal((await follow(api, runId, ["completed", "failed"])).last.status, "completed");
  const known = (await api("GET", `/runs/${kept}`)).body.cost.usd;
  assert.ok(typeof known === "number" && known > 0.00003, `the run's cost is the decision's and the model's: ${known}`);
  assert.equal((await api("GET", `/runs/${twin}`)).body.cost.usd, known, "and so is its twin's");
  await closeFirst();
  // The twin's decisions unreadable and the rest of its store as it was: each decision document's newest revision is a
  // delta no reader can apply.
  const twinStore = join(data, "runs", twin, "store", "run.sqlite");
  const db = new DatabaseSync(twinStore);
  try {
    const { changes } = db.prepare(`INSERT INTO document_revisions (document_id, seq, kind, version, content) SELECT document_id, MAX(seq) + 1, 'delta', MAX(version), '[["unknown"]]' FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE kind LIKE '"agentrun.decisions%') GROUP BY document_id`).run();
    assert.ok(changes > 0, "the run's store holds its decisions");
  } finally {
    db.close();
  }
  assert.throws(() => durableDecisions(twinStore), "the store's reader cannot read the twin's decisions");
  const next = await startServe({ data, port: 0, faux: priced, fauxJev: FAUX_JEV, drainTimeout: "5s" });
  t.after(() => next.close());
  const again = client(next.baseUrl, next.token);
  assert.equal((await again("GET", `/runs/${kept}`)).body.cost.usd, known, "the run whose decisions it reads keeps its known cost");
  const after = (await again("GET", `/runs/${twin}`)).body;
  assert.equal(after.status, "completed", JSON.stringify(after));
  assert.equal(after.cost.usd, null, "decisions it cannot read leave the run's cost unknown");
  // Its timeline agrees: its usage row's total is unknown, never its priced model node's alone, and its other rows stay.
  const keptRows = await timeline(again, kept);
  const twinRows = await timeline(again, twin);
  const usage = twinRows.findLast((row) => row.kind === "usage");
  assert.equal(typeof keptRows.findLast((row) => row.kind === "usage")?.usage?.usd, "number", "the readable run's usage row has its known total");
  assert.deepEqual([usage?.usage?.usd, /^Cost so far: unknown /.test(usage?.summary ?? "")], [null, true], `the twin's usage row: ${JSON.stringify(usage)}`);
  assert.deepEqual(twinRows.filter((row) => row.kind !== "usage").map((row) => row.kind), keptRows.filter((row) => row.kind !== "usage" && row.kind !== "decision").map((row) => row.kind), "every row but the decisions' is served");
});

test("an ended workflow run with no store file keeps its known cost after the server restarts: a missing store is one never made", async (t) => {
  await withCanary(t);
  process.env.AGENTRUN_TEST_FAUX_JEV_COST = "0.00003";
  const data = join(await scratch(t), "agents");
  const priced = new URL("./fixtures/faux-priced.mjs", import.meta.url).pathname;
  const first = await startServe({ data, port: 0, faux: priced, fauxJev: FAUX_JEV, drainTimeout: "5s" });
  let closing;
  const closeFirst = () => (closing ??= first.close());
  t.after(closeFirst);
  const api = client(first.baseUrl, first.token);
  const runId = await startFlow(api, [judge, probe()]);
  assert.equal((await follow(api, runId, ["completed", "failed"])).last.status, "completed");
  const known = (await api("GET", `/runs/${runId}`)).body.cost.usd;
  assert.ok(typeof known === "number" && known > 0, `the run's cost is known: ${known}`);
  await closeFirst();
  const store = join(data, "runs", runId, "store");
  for (const name of await readdir(store)) await rm(join(store, name), { force: true });
  const next = await startServe({ data, port: 0, faux: priced, fauxJev: FAUX_JEV, drainTimeout: "5s" });
  t.after(() => next.close());
  const after = await client(next.baseUrl, next.token)("GET", `/runs/${runId}`);
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.cost.usd, known, "the store's own total, as the agent store kept it");
});

/** The run's served timeline, every row. */
async function timeline(api, runId) {
  const page = await api("GET", `/runs/${runId}/timeline?limit=500`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  return page.body.rows;
}

test("a judge's decision is a timeline row: its node, provider and each answer with its probability, and its cost on the usage row", async (t) => {
  await withCanary(t);
  const { api } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [judge, probe()]);
  const { last } = await follow(api, runId, ["completed", "failed"]);
  assert.equal(last.status, "completed");
  const rows = await timeline(api, runId);
  const decisions = rows.filter((row) => row.kind === "decision");
  // The fake reports 120 input tokens and no cost: the decision is booked at TypeSafe's published price.
  const estimate = (120 * 0.042 + 0 * 0) / 1_000_000;
  assert.deepEqual(decisions.map((row) => [row.summary, row.agent_label, row.text, row.usage]), [["coi (jev): is_coi yes 0.92", "coi", null, { usd: estimate, requests: 1 }]]);
  const usage = rows.findLast((row) => row.kind === "usage");
  assert.equal(usage.usage.usd, estimate, "the model node is free under the fake, so the run's usage is the decision's estimate, unrounded");
  assert.equal(usage.usage.usd, (await api("GET", `/runs/${runId}`)).body.cost.usd, "the usage row and the run's cost agree");
  assert.match(usage.summary, /^Cost so far: <\$0\.0001 /, "a cost above zero never reads $0.0000");
  assert.equal(usage.usage.requests, 2, "the model node's request and the decision's");
});

test("a route's decision is a timeline row naming the branch it took, and unsure when it took that branch", async (t) => {
  await withCanary(t);
  const { api } = await serve(t, { fauxJev: FAUX_JEV });
  const branch = (name) => ({ criteria: `the case is ${name}`, body: { ...probe(), label: `probe ${name}` } });
  const route = { node: "route", label: "triage", state: { doc: "{question}" }, instructions: "Accept the document, or send it to review?", branches: { accept: branch("clean"), review: branch("doubtful") }, unsure: { branch: "review", gte: 0.9 } };
  const runId = await startFlow(api, [route]);
  const { last } = await follow(api, runId, ["completed", "failed"]);
  assert.equal(last.status, "completed");
  assert.deepEqual((await timeline(api, runId)).filter((row) => row.kind === "decision").map((row) => row.summary), ["route: review (unsure)"], "the fake answers accept at 0.80, under the gate");
});

test("a decision whose cost the provider reports is on its row, and the run's total counts it once", async (t) => {
  await withCanary(t);
  process.env.AGENTRUN_TEST_FAUX_JEV_COST = "0.00003";
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [judge, probe()]);
  const { last } = await follow(api, runId, ["completed", "failed"]);
  assert.equal(last.status, "completed");
  const rows = await timeline(api, runId);
  const decisions = rows.filter((row) => row.kind === "decision");
  assert.deepEqual(decisions.map((row) => row.usage), [{ usd: 0.00003, requests: 1 }]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  const usage = rows.findLast((row) => row.kind === "usage");
  assert.equal(usage.usage.usd, run.cost.usd, "the timeline's usage row and the run's cost agree");
  assert.equal(run.cost.usd, 0.00003, "the model node is free under the fake, so the run's cost is the decision's, counted once");
  assert.equal(storeRun(data, runId).costUsd, 0.00003, "and the store keeps the same total");
});

test("only a run that asks Parallel or names a web tool holds the Parallel key, in memory: never in its environment, a child process or a file; an agentic run naming no web tool gets no key at all", async (t) => {
  const seen = await withKeys(t, { parallel: true });
  const gate = join(await scratch(t), "go");
  const { api, data } = await serve(t, { fauxParallel: FAUX_PARALLEL, fauxWeb: FAUX_WEB });
  // A workflow asking Parallel on one read of the key: a decision node, then web_fetch in a call node.
  const read = { node: "call", label: "read", via: "tool", tool: "web_fetch", args: { url: "http://public.example/" }, out: "Page", as: "page", deadline_s: 60 };
  const runId = await startFlow(api, [onParallel, read, probe(gate)], undefined, { tools: ["web_fetch"], schemas: { Page: { type: "object", required: ["via"], properties: { via: { const: "parallel" } } } } });
  // While the run's process waits at the probe, after it read the key: as the kernel shows that process.
  const pid = await processOf(data, runId);
  const environ = await readFile(`/proc/${pid}/environ`, "utf8");
  assert.equal(environ.includes(PARALLEL_CANARY), false, "the run's process environment holds no copy of the key");
  assert.equal(keyFdIn(environ), KEY_FD, "it was handed the key on the first descriptor after its stdio and secrets");
  assert.equal(await handedSocket(pid, KEY_FD), false, "and closed it once read");
  await writeFile(gate, "");
  const { last } = await follow(api, runId, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(run.result.output, CLEAN, "the model node's process, and an sh and a node -e it starts, see neither the key nor its descriptor");
  assert.deepEqual((await seen()).parallel.map((c) => [c.path, c.authorized]), [["/v1/decisions", true], ["/v1/extract", true]], "Parallel got the key from the decision node and from web_fetch, on the one read");
  // Agentic runs, each held in its first turn: one naming web_fetch holds the key as the workflow does, one naming no web
  // tool was never handed it.
  for (const tool of ["web_fetch", "read"]) {
    const hold = join(await scratch(t), "go");
    const id = `holds-${tool.replace("_", "-")}`;
    assert.equal((await api("POST", "/agents", { definition: { id, name: id, instructions: "Hold.", tools: [tool] } })).status, 201);
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: `Answer once ${hold} exists.` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const pid = await processOf(data, started.body.run_id);
    const environ = await readFile(`/proc/${pid}/environ`, "utf8");
    assert.equal(environ.includes(PARALLEL_CANARY), false, `${tool}: the run's process environment holds no copy of the key`);
    assert.equal(keyFdIn(environ), tool === "web_fetch" ? KEY_FD : undefined, `${tool}: handed the key only when it names web_fetch`);
    assert.equal(await handedSocket(pid, KEY_FD), false, `${tool}: no key descriptor open`);
    await writeFile(hold, "");
    await follow(api, started.body.run_id, ["completed"]);
  }
  assert.deepEqual(await filesHolding(data, PARALLEL_CANARY), [], "no file of the data directory holds the key");
  assert.equal(process.env.PARALLEL_API_KEY, PARALLEL_CANARY, "the server's own environment is as it was");
});

test("a node naming the provider parallel is answered by Parallel, sent the key as x-api-key; a node naming none by Jev; each receipt keeps its own answer and cost", async (t) => {
  const seen = await withKeys(t, { jev: true, parallel: true });
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV, fauxParallel: FAUX_PARALLEL });
  const runId = await startFlow(api, [judge, onParallel, probe()]);
  const { last } = await follow(api, runId, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  const calls = await seen();
  assert.deepEqual(calls.parallel.map((c) => [c.path, c.authorized, c.questions]), [["/v1/decisions", true, ["is_coi"]]], "one Parallel request, with the canary key");
  assert.deepEqual(calls.jev.map((c) => [c.path, c.authorized, c.questions]), [["/v1/systemone", true, ["is_coi"]]], "and one Jev request, for the node that names no provider");
  const rows = Object.fromEntries(durableDecisions(join(data, "runs", runId, "store", "run.sqlite")).map((row) => [row.node, row]));
  assert.deepEqual(Object.keys(rows).sort(), ["coi", "coi-parallel"]);
  assert.deepEqual([rows["coi-parallel"].answers.is_coi.noul, rows["coi-parallel"].model], [0.31, "parallel-fast"], "Parallel's answer");
  assert.equal(rows["coi-parallel"].cost_usd, 0.001, "booked at Parallel's list price");
  assert.equal(rows.coi.answers.is_coi.noul, 0.92, "Jev's answer");
  assert.deepEqual([rows["coi-parallel"].provider, rows.coi.provider], ["parallel", "jev"], "each receipt names the provider that answered: never the default in another's place");
  const estimate = (120 * 0.042 + 0 * 0) / 1_000_000;
  assert.equal(rows.coi.cost_usd, estimate, "Jev's booked at TypeSafe's published price");
  assert.equal(run.cost.usd, 0.001 + estimate, "the run's cost is the two decisions', each counted once");
});

test("with no Parallel key, a node naming parallel saves with a warning, and its run is 409 not_set_up_here naming PARALLEL_API_KEY", async (t) => {
  await withKeys(t, { jev: true });
  const { api } = await serve(t, { fauxJev: FAUX_JEV, fauxParallel: FAUX_PARALLEL });
  const made = await api("POST", "/agents", flowAgent("coi", flow([judge, onParallel, probe()])));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const warnings = made.body.warnings.filter((w) => w.field === "definition.workflow");
  assert.deepEqual(warnings.map((w) => w.reason), ["not_set_up_here"], JSON.stringify(made.body.warnings));
  assert.match(warnings[0].message, /PARALLEL_API_KEY/);
  const refused = await api("POST", "/agents/coi/runs", { input: { question: "x" } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.match(refused.body.error.message, /PARALLEL_API_KEY/);
  assert.deepEqual(refused.body.error.details.adapters, ["runJudge"]);
  assert.deepEqual(refused.body.error.details.decisions, { parallel: { reason: "not_set_up_here", needs: ["PARALLEL_API_KEY"] } }, "Jev's key is set: only Parallel is missing");
});

test("capabilities lists parallel: available where PARALLEL_API_KEY is set, why not where it is not; runJudge runs on Parallel alone", async (t) => {
  await withKeys(t, {});
  const off = (await (await serve(t)).api("GET", "/capabilities")).body.workflows;
  const parallelOff = off.decisions.providers.find((p) => p.id === "parallel");
  assert.equal(parallelOff?.available, false);
  assert.match(parallelOff.reason, /PARALLEL_API_KEY/);
  assert.equal(off.adapters.includes("runJudge"), false, "no provider runs here: typed questions do not");
  process.env.PARALLEL_API_KEY = PARALLEL_CANARY;
  const on = (await (await serve(t)).api("GET", "/capabilities")).body.workflows;
  assert.deepEqual(on.decisions.providers.map((p) => [p.id, p.available]), [["jev", false], ["parallel", true], ["openrouter", false]]);
  assert.deepEqual(on.decisions.providers[1], { id: "parallel", available: true });
  assert.ok(on.adapters.includes("runJudge"), "Parallel's key alone runs typed questions");
});

test("the missing-key 409's details, decisions included, meet what the served document gives agent_not_runnable", async (t) => {
  withEnv(t, {}, KEYS);
  const { api, baseUrl } = await serve(t, { fauxJev: FAUX_JEV });
  assert.equal((await api("POST", "/agents", flowAgent("coi", flow([judge, probe()])))).status, 201);
  const refused = await api("POST", "/agents/coi/runs", { input: { question: "x" } });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "agent_not_runnable"]);
  assert.deepEqual(refused.body.error.details.decisions, { jev: { reason: "not_set_up_here", needs: ["TYPESAFE_API_KEY"] } });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/ErrorBody" }, refused.body.error), [], "the error meets the contract's ErrorBody");
  // The contract's details take any field; what agent_not_runnable's hold here is the server's own shape.
  const shape = doc.components.schemas.ErrorBody.properties.details["x-agentrun-serve-details"].agent_not_runnable;
  const blocked = shape.oneOf.find((part) => part.required.includes("unbound"));
  assert.deepEqual(schemaProblems(doc, blocked, refused.body.error.details), [], "field by field, against the blocked revision's details");
  const stray = { ...refused.body.error.details, decisions: { jev: { reason: "not_set_up_here", needs: ["TYPESAFE_API_KEY"], extra: 1 } } };
  assert.deepEqual(schemaProblems(doc, blocked, stray), ["$.decisions.jev.extra: is not a field here"], "a provider's entry takes no other field");
  assert.deepEqual(schemaProblems(doc, shape, refused.body.error.details), [], JSON.stringify(refused.body.error.details));
});

