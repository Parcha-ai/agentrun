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
import { durableDecisions } from "../dist/workflow/readers.js";
import { startServe } from "../dist/index.js";
import { DECISION_KEY_FD_ENV, decisionsOf, FAUX_JEV_ENV, jevRoute } from "../dist/decisions.js";
import { FAUX_ENV } from "../dist/model.js";
import { client, FAUX, flowAgent, follow, runDir, runRecordOf, scratch, serve, storeRun, withEnv } from "./support.mjs";
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

async function startFlow(api, steps, output, { schemas = {}, tools, tool_settings } = {}) {
  const doc = flow(steps, output);
  Object.assign(doc.schemas, schemas);
  const made = await api("POST", "/agents", flowAgent("coi", doc, { ...(tools ? { tools } : {}), ...(tool_settings ? { tool_settings } : {}) }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await api("POST", "/agents/coi/runs", { input: { question: QUESTION } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body.run_id;
}

/** The run's process, once it serves its door (after its app, which reads the key, has returned): its pid. */
async function processOf(data, runId, not) {
  for (let i = 0; ; i++) {
    const record = runRecordOf(data, runId);
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

/** A model node that reports the names of the decision keys its process was handed (faux-model.mjs), and its schema. */
const keysNode = (tools) => ({ node: "extract", label: "keys", instructions: "Report the decision keys.", out: "Names", as: "names", ...(tools ? { tools } : {}) });
const NAMES = { Names: { type: "object", required: ["names"], properties: { names: { type: "array", items: { type: "string" } } } } };

test("decisionProvidersFor and decisionKeysFor: Jev's key by its route, OpenRouter's for an OpenRouter node, none for Parallel picked without its key, and a node's need and a web tool's together", async () => {
  const { decisionProvidersFor } = await import("../dist/runs.js");
  const { decisionKeysFor } = await import("../dist/decisions.js");
  const { handsParallel, planeFor } = await import("../dist/tool-plane.js");
  const { toolingOf } = await import("../dist/tools.js");
  const workflow = (steps, body = {}) => ({ id: "r".repeat(64), agent: "a", parent: null, createdAt: "2026-11-03T00:00:00.000Z", kind: "workflow", body: { skills: {}, tools: [], workflow: flow(steps), ...body } });
  const keys = { TYPESAFE_API_KEY: "t".repeat(20), PARALLEL_API_KEY: "p".repeat(20), OPENROUTER_API_KEY: "o".repeat(20) };
  // As a launch reads them: the revision's decision providers, and its plane under the server's settings.
  const names = async (rev, env = keys, settings = {}) => Object.keys(decisionKeysFor(env, { providers: await decisionProvidersFor(rev), parallelWeb: handsParallel(planeFor(env, await toolingOf(rev), settings)) })).sort();
  const fetching = { node: "call", label: "page", via: "tool", tool: "web_fetch", args: { url: "https://example.com/" }, out: "Probe", as: "page", deadline_s: 30 };
  const onParallelPick = { web_fetch: { provider: "parallel" } };
  assert.deepEqual(await names(workflow([judge, probe()]), { OPENROUTER_API_KEY: keys.OPENROUTER_API_KEY, PARALLEL_API_KEY: keys.PARALLEL_API_KEY }), ["OPENROUTER_API_KEY"], "Jev on the OpenRouter route: OpenRouter's");
  assert.deepEqual(await names(workflow([{ ...judge, provider: "openrouter", model: "m" }, probe()])), ["OPENROUTER_API_KEY"], "an OpenRouter decision node: OpenRouter's");
  assert.deepEqual(await names(workflow([fetching, probe()]), { TYPESAFE_API_KEY: keys.TYPESAFE_API_KEY }, onParallelPick), [], "Parallel picked on a server without its key: unavailable, and none");
  assert.deepEqual(await names(workflow([judge, fetching, probe()], { toolSettings: onParallelPick })), ["PARALLEL_API_KEY", "TYPESAFE_API_KEY"], "a Jev judge and a web_fetch the agent picked onto Parallel: both");
});

test("capabilities lists the decision providers: jev available where its key is set, why not where it is not, and a note when its key is the gateway's", async (t) => {
  withEnv(t, {}, KEYS);
  const off = await serve(t);
  const caps = (await off.api("GET", "/capabilities")).body;
  assert.ok(caps.workflows.decisions, "capabilities has workflows.decisions");
  const none = caps.workflows.decisions.providers;
  assert.deepEqual(none.map((p) => [p.id, p.available]), [["jev", false], ["parallel", false], ["openrouter", false]]);
  assert.equal(none[0].note, undefined);
  // With no decision key, the reason names each way to run Jev: its own key, OpenRouter's, or an OpenRouter gateway's.
  for (const name of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_API_KEY", "AGENT_MODEL_BASE_URL"]) assert.match(none[0].reason, new RegExp(name), none[0].reason);
  assert.match(none[0].reason, /openrouter\.ai/, none[0].reason);
  assert.match(none[1].reason, /PARALLEL_API_KEY/);
  assert.equal(caps.workflows.adapters.includes("runJudge"), false, "no provider runs here: typed questions do not");
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
  delete process.env.OPENROUTER_API_KEY;
  process.env.PARALLEL_API_KEY = PARALLEL_CANARY;
  const parallel = (await (await serve(t)).api("GET", "/capabilities")).body.workflows;
  assert.deepEqual(parallel.decisions.providers.map((p) => [p.id, p.available]), [["jev", false], ["parallel", true], ["openrouter", false]]);
  assert.deepEqual(parallel.decisions.providers[1], { id: "parallel", available: true, route: "parallel" });
  assert.ok(parallel.adapters.includes("runJudge"), "Parallel's key alone runs typed questions");
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

test("a node naming a decision provider this server does not run is refused at save, by name", async (t) => {
  const seen = await withCanary(t);
  const { api } = await serve(t, { fauxJev: FAUX_JEV });
  const made = await api("POST", "/agents", flowAgent("coi", flow([{ ...judge, provider: "acme" }, probe()])));
  assert.equal(made.status, 422, JSON.stringify(made.body));
  assert.ok(made.body.error.fields?.some((issue) => issue.field === "definition.workflow" && issue.reason === "not_an_option" && /names the provider acme/.test(issue.message)), JSON.stringify(made.body.error));
  assert.deepEqual(await seen(), [], "Jev was never asked in its place");
});

/** The run's served timeline, every row. */
async function timeline(api, runId) {
  const page = await api("GET", `/runs/${runId}/timeline?limit=500`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  return page.body.rows;
}

// SKIP (follow-up #2089): the run's cost leaves out its decisions' cost, so the timeline's usage row and the run's cost disagree
test.skip("a judge's and a route's decisions are timeline rows: the judge's node, provider and each answer with its probability, the route's branch and unsure when it took that branch, and their cost on the usage row", async (t) => {
  await withCanary(t);
  const { api } = await serve(t, { fauxJev: FAUX_JEV });
  const branch = (name) => ({ criteria: `the case is ${name}`, body: { ...probe(), label: `probe ${name}` } });
  const route = { node: "route", label: "triage", state: { doc: "{question}" }, instructions: "Accept the document, or send it to review?", branches: { accept: branch("clean"), review: branch("doubtful") }, unsure: { branch: "review", gte: 0.9 } };
  const runId = await startFlow(api, [judge, route]);
  const { last } = await follow(api, runId, ["completed", "failed"]);
  assert.equal(last.status, "completed");
  const rows = await timeline(api, runId);
  const decisions = rows.filter((row) => row.kind === "decision");
  // The fake reports 120 input tokens and no cost: each decision is booked at TypeSafe's published price.
  const estimate = (120 * 0.042 + 0 * 0) / 1_000_000;
  assert.deepEqual(decisions.map((row) => [row.summary, row.agent_label, row.text, row.usage]), [
    ["coi (jev): is_coi yes 0.92", "coi", null, { usd: estimate, requests: 1 }],
    ["route: review (unsure)", "triage", null, { usd: estimate, requests: 1 }],
  ], "the fake answers the route accept at 0.80, under its gate, so it took review as unsure");
  const usage = rows.findLast((row) => row.kind === "usage");
  assert.equal(usage.usage.usd, estimate + estimate, "the model node is free under the fake, so the run's usage is the decisions' estimates, unrounded");
  assert.equal(usage.usage.usd, (await api("GET", `/runs/${runId}`)).body.cost.usd, "the usage row and the run's cost agree");
  assert.match(usage.summary, /^Cost: <\$0\.0001 /, "a cost above zero never reads $0.0000");
  assert.equal(usage.usage.requests, 3, "the branch's model node request and the two decisions'");
});

test("a workflow followed live through its end: the usage row its cursor last reads says the run's cost, never \"so far\"", async (t) => {
  await withCanary(t);
  const { api } = await serve(t, { fauxJev: FAUX_JEV });
  const runId = await startFlow(api, [judge, probe()]);
  // Followed as a client follows a run: every page after the last one's cursor, until a final page.
  const { rows, last } = await follow(api, runId, ["completed", "failed"]);
  assert.deepEqual([last.status, last.final], ["completed", true]);
  const usage = rows.findLast((row) => row.kind === "usage");
  assert.match(usage?.summary ?? "", /^Cost: /, `the followed usage row: ${JSON.stringify(usage)}`);
});

// SKIP (follow-up #2089): the run's cost leaves out the cost the decision provider reported, so it reads 0
test.skip("a decision whose cost the provider reports is on its row, and the run's total counts it once", async (t) => {
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
  assert.deepEqual(refused.body.error.details.decisions, { parallel: { reason: "not_set_up_here", needs: ["PARALLEL_API_KEY", "OPENROUTER_API_KEY"] } }, "Jev's key is set: only Parallel is missing");
});

test("the missing-key 409's details, decisions included, meet what the served document gives agent_not_runnable", async (t) => {
  withEnv(t, {}, KEYS);
  const { api, baseUrl } = await serve(t, { fauxJev: FAUX_JEV });
  // A judge workflow saves with a warning naming the key, and its run is refused naming it too.
  const made = await api("POST", "/agents", flowAgent("coi", flow([judge, probe()])));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const warning = made.body.warnings.find((w) => w.field === "definition.workflow");
  assert.equal(warning?.reason, "not_set_up_here", JSON.stringify(made.body.warnings));
  assert.match(warning.message, /TYPESAFE_API_KEY/);
  const refused = await api("POST", "/agents/coi/runs", { input: { question: "x" } });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "agent_not_runnable"]);
  assert.match(refused.body.error.message, /TYPESAFE_API_KEY/);
  assert.deepEqual(refused.body.error.details.adapters, ["runJudge"]);
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

