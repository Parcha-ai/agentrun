// Decision workflows on Jev: a workflow's judge, pick, sift, route and ask nodes run on TypeSafe's System One when this
// server's environment names its key. The key reaches the judge's runner only, never a run's tools, its model, a program
// it starts or a file. Here Jev is the tests' fake fetch (fixtures/faux-jev.mjs): no network, no real key.
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

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AGENTRUN_TEST_FAUX_JEV_CALLS", "AGENTRUN_TEST_FAUX_JEV_COST"];
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
/** A model node that reports where the decision key is, once `gate` exists when one is given. */
const probe = (gate) => ({ node: "extract", label: "probe", instructions: gate ? `Report the canary once ${gate} exists.` : "Report the canary.", out: "Probe", as: "probe" });
const flow = (steps, output = { schemaId: "Probe", path: "probe" }) => ({
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
  output,
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

async function startFlow(api, steps, output) {
  const made = await api("POST", "/agents", flowAgent("coi", flow(steps, output)));
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
  process.env.OPENROUTER_API_KEY = "fake-test-key";
  const gateway = await serve(t);
  const [routed] = (await gateway.api("GET", "/capabilities")).body.workflows.decisions.providers;
  assert.deepEqual([routed.id, routed.available, routed.reason], ["jev", true, undefined]);
  assert.match(routed.note ?? "", /model gateway/, "on the OpenRouter route the Jev key is the gateway's, and capabilities says so");
  assert.match(routed.note ?? "", /TYPESAFE_API_KEY/);
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

/** jevJudgeOf in a process of its own, as a run's process calls it: its environment is `env` alone, and `handed` (a
 *  route and key) comes on the decision descriptor when given. Whether it made a judge, and what the fake Jev took. */
async function judgeIn(t, env, handed) {
  const calls = join(await scratch(t), "jev-calls.jsonl");
  const script = `const { jevJudgeOf } = await import(${JSON.stringify(new URL("../dist/decisions.js", import.meta.url).href)});
const judge = await jevJudgeOf(process.env);
const answer = judge && await judge({ label: "coi", kind: "judge", state: { doc: "x" }, questions: { is_coi: { type: "noul", instructions: "Is doc a certificate of incorporation?" } } });
process.stdout.write(JSON.stringify({ judge: Boolean(judge), noul: answer?.answers?.is_coi?.noul ?? null }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { HOME: process.env.HOME, [FAUX_ENV]: FAUX, [FAUX_JEV_ENV]: FAUX_JEV, AGENTRUN_TEST_FAUX_JEV_CALLS: calls, ...env, ...(handed ? { [DECISION_KEY_FD_ENV]: KEY_FD } : {}) },
    // As a run's process has them: the secrets pipe on 3 (none here), the key on the next.
    stdio: ["ignore", "pipe", "pipe", "ignore", ...(handed ? ["pipe"] : [])],
  });
  // What the server writes there: the route, a newline, the key.
  if (handed) child.stdio[Number(KEY_FD)].end(`${handed.route}\n${handed.key}`);
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
  const handedOnly = await judgeIn(t, {}, { route: "openrouter", key: CANARY });
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
  assert.equal(durableDecisions(join(data, "runs", runId, "store", "run.sqlite"))[0].cost_usd, null, "Jev reports no cost: the decision's is unknown");
  const usage = (await api("GET", `/runs/${runId}/timeline?limit=500`)).body.rows.findLast((row) => row.kind === "usage");
  assert.ok(usage?.usage?.usd > 0, `the model node's request is priced: ${JSON.stringify(usage?.usage)}`);
  assert.equal(before.cost.usd, null, "the decision's unknown cost is the run's");
  await closeFirst();
  const next = await startServe({ data, port: 0, faux: priced, fauxJev: FAUX_JEV, drainTimeout: "5s" });
  t.after(() => next.close());
  const after = (await client(next.baseUrl, next.token)("GET", `/runs/${runId}`)).body;
  assert.equal(after.status, "completed");
  assert.equal(after.cost.usd, null, "and still after a restart: never the model's cost alone");
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
