// The fields an external client reads of an agent's learning through the v2 API (fixtures/learn-reads-contract.json,
// taken from that client at its `source_revision`): each is in the answers, of its type. A field removed or renamed
// fails; one added beside them passes. The reads:
//   - GET /agents/{id}/learning/{cost,promotions,audits,loop}; 404 for an agent the server does not know;
//   - DELETE /agents/{id}/learning: 204 when reset, 409 learning_busy with error.retry_after_ms while a run of the agent
//     is going; 404 for an agent the server never had, whose GET /agents/{id} is 404 too;
//   - GET /runs/{id}: its `path` and cost.{usd, tools_usd, learning_usd, all_in_usd};
//   - GET /runs/{id}/timeline: a learned workflow's tool_result row and its learned_nodes;
//   - POST /runs: an inline launch whose definition carries the client's learning settings, or `learning: true`;
//   - PUT /runs/{id}/grade: an owner's grade of a served run.
// The fixed values the client switches on (a run's path, a promotion's decision, a workflow's serving state, ...) are
// each seen at least once, and none outside the file's list appears where it reads them; the statuses are the file's.
// The data comes from the writers that make it in a run: a check's decision (runner/promotion.ts decideCheck) writes
// every promotion record but a connected agent's check, whose reservation is reserveSdkCheck's; a run's end-of-run step
// (runner/reflect-hook.ts) its compile rounds; a promoted workflow serves runs on the runner, and an owner's grade writes
// an audit row. Every field must be read at least once across the answers, every field that may be null must be read
// once with a value, and every list of strings once with an item, so none passes for want of data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkedOf, landWorkflows } from "./learned-workflow-seed-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const { decideCheck, reserveSdkCheck } = await import("../dist/runner/promotion.js");
const { createReflectHook } = await import("../dist/runner/reflect-hook.js");
const { secretsShown } = await import("../dist/learning.js");

const CONTRACT = JSON.parse(readFileSync(new URL("./fixtures/learn-reads-contract.json", import.meta.url), "utf8"));
const READS = CONTRACT.reads;
const VALUES = CONTRACT.values;
const STATUSES = CONTRACT.statuses;
const LEAVES = new Set(["number", "string", "boolean", "list"]);

/** A spec's own parts: its type (`leaf`, `object` or `list`), whether it takes null, and what it holds. */
function partsOf(spec) {
  if (typeof spec === "string") {
    const [type, extra] = spec.split("|");
    assert.ok(LEAVES.has(type) && (extra === undefined || extra === "null"), `a type the contract file names: ${spec}`);
    return { kind: "leaf", type, nullable: extra === "null" };
  }
  if (spec.object) return { kind: "object", fields: spec.object, nullable: spec.nullable === true };
  if (spec.list) return { kind: "list", item: spec.list, nullable: spec.nullable === true };
  assert.fail(`a spec the contract file names: ${JSON.stringify(spec)}`);
}

/** A field's name in the contract file: one ending in `?` may be absent from an answer (it still must be read once). */
const keyOf = (key) => (key.endsWith("?") ? { field: key.slice(0, -1), optional: true } : { field: key, optional: false });

/** Every field of `spec` under `at`, which of them may be null, and which are lists of leaves, as `meets` names them. */
function fieldsOf(spec, at, out = { all: [], nullable: [], leafLists: [] }) {
  const parts = partsOf(spec);
  if (parts.kind === "list") {
    if (partsOf(parts.item).kind === "leaf") out.leafLists.push(at);
    return fieldsOf(parts.item, `${at}[]`, out);
  }
  if (parts.kind === "object") {
    for (const [key, inner] of Object.entries(parts.fields)) {
      const { field } = keyOf(key);
      out.all.push(`${at}.${field}`);
      if (partsOf(inner).nullable) out.nullable.push(`${at}.${field}`);
      fieldsOf(inner, `${at}.${field}`, out);
    }
  }
  return out;
}

/** Asserts `value` has every field `spec` lists (an optional one when there), of its type: each field read goes in
 *  `seen.read`, each with a value
 *  (not null) in `seen.filled`, each list of leaves with an item (its item type checked) in `seen.leafLists`. */
function meets(value, spec, at, seen) {
  const parts = partsOf(spec);
  if (value === null && parts.nullable) return;
  if (parts.kind === "leaf") {
    if (parts.type === "list") assert.ok(Array.isArray(value), `${at}: a list, not ${JSON.stringify(value)}`);
    else assert.equal(typeof value, parts.type, `${at}: a ${parts.type}, not ${JSON.stringify(value)}`);
    return;
  }
  if (parts.kind === "list") {
    assert.ok(Array.isArray(value), `${at}: a list, not ${JSON.stringify(value)}`);
    if (value.length && partsOf(parts.item).kind === "leaf") seen.leafLists.add(at);
    for (const item of value) meets(item, parts.item, `${at}[]`, seen);
    return;
  }
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${at}: an object, not ${JSON.stringify(value)}`);
  for (const [key, inner] of Object.entries(parts.fields)) {
    const { field, optional } = keyOf(key);
    if (optional && !Object.hasOwn(value, field)) continue;
    assert.ok(Object.hasOwn(value, field), `${at}.${field} is gone, and a client reads it: ${JSON.stringify(value).slice(0, 2000)}`);
    seen.read.add(`${at}.${field}`);
    if (value[field] !== null) seen.filled.add(`${at}.${field}`);
    meets(value[field], inner, `${at}.${field}`, seen);
  }
}

/** Every fixed value the contract file lists, named as `saw` names it: `group: value`, or `group: key=value` for an
 *  object of them. */
const LISTED = Object.entries(VALUES).flatMap(([group, listed]) => Array.isArray(listed) ? listed.map((one) => `${group}: ${one}`)
  : typeof listed === "object" ? Object.entries(listed).map(([key, one]) => `${group}: ${key}=${one}`) : [`${group}: ${listed}`]);

/** Asserts `value`, read where the client reads `group`, is one the contract file lists for it, and counts it seen. */
function saw(seen, group, value, key) {
  const name = key === undefined ? `${group}: ${value}` : `${group}: ${key}=${value}`;
  assert.ok(LISTED.includes(name), `${name}: not a value the client knows (it knows ${JSON.stringify(VALUES[group])})`);
  seen.values.add(name);
}

/** The status the contract file says the client expects in case `name`, counted as asserted. */
function statusOf(seen, name) {
  assert.equal(typeof STATUSES[name], "number", `a status the contract file names: ${name}`);
  seen.statuses.add(name);
  return STATUSES[name];
}

/** The faux model at $100 per million output tokens, 400 a request: every model request costs $0.04. */
const PRICED = new URL("./fixtures/faux-workflow-priced.mjs", import.meta.url).pathname;
/** A learned workflow on the agent's own input: one model node answers a number, then it hands the run back to the
 *  agent when the input is HAND_BACK. */
const HAND_BACK = "Hand this one back.";
const FLOW = {
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["content"], properties: { content: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" },
    { node: "escalate", label: "asked", when: { predicate: "field_equals", path: "content", value: HAND_BACK }, kind: "asked", stage: "answer", summary: "asked to hand it back" },
  ] },
};
const [{ digest: DIGEST }] = checkedOf([{ name: "answer", workflow: FLOW }]);
/** The bar a check decides on: compared on `answer`, so no model compares the answers. */
const BAR = { compile_after: 2, agree_min: 0.8, alone_min: 0.7, attempt: 1, agree_on: ["answer"] };
/** The runner's claims outlive the test: a served run's claim running out mid-workflow would hand it back. */
const LONG_LEASE = { leaseMs: 600_000, renewEveryMs: 10_000 };
/** The seeds' clock, fixed epoch milliseconds: each run the ledger keeps and each record either half decides is at a
 *  whole minute after T0 (the served half's runs themselves start on the runner's clock, after it). */
const T0 = Date.UTC(2026, 10, 20, 6, 0, 0);
const at = (minute) => T0 + minute * 60_000;

/** A check's ports as runner/promotion.ts takes them, with its clock at `now`. */
const checkDeps = (store, agentId, now) => ({ store: { settings: store.settings }, agentId, log: () => undefined, shown: async () => secretsShown([]), now: () => now });

/** A check of `workflow` at `digest` decided on two of the agent's inputs at `now`, as runner/promotion.ts decides one:
 *  promoted when its answers say the agent's (`answer`), held when they do not, and stopped for good when held at a
 *  recompile's check (`attempt` 2). */
async function decided(store, agentId, workflow, digest, { answer, now, attempt = 1, extra = {} }) {
  const rows = ["run-01", "run-02"].map((of) => ({ of, input: JSON.stringify({ content: "Go." }), agent: JSON.stringify({ answer: 42 }), outcome: "answered", answer: JSON.stringify({ answer }) }));
  const read = { rows, cost: 0.6, outcomes: { answered: 2, handed_back: 0, failed: 0, skipped_write: 0 }, unstarted: 0 };
  const out = await decideCheck(checkDeps(store, agentId, now), workflow, digest, { ...BAR, attempt }, read, () => true, extra);
  assert.equal(out.won, true);
  return out.record;
}

/** `api`'s answer to `method path`, with its status asserted. */
async function answer(api, method, path, status = 200) {
  const res = await api(method, path);
  assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Every learning read of agent `id`, each checked against the contract, and the fixed values in them. */
async function learningReads(api, id, seen) {
  const out = {};
  for (const part of ["cost", "promotions", "audits", "loop"]) {
    const route = `GET /agents/{id}/learning/${part}`;
    out[part] = await answer(api, "GET", `/agents/${id}/learning/${part}`);
    meets(out[part], READS[route], route, seen);
  }
  for (const run of out.cost.runs.filter((one) => one.n !== null && one.path !== null)) saw(seen, "run paths", run.path);
  for (const one of out.promotions.promotions) saw(seen, "promotion decisions", one.decided);
  for (const one of out.promotions.serving) saw(seen, "serving states", one.state);
  return out;
}

/** GET /runs/{id}, checked against the contract, with its path. */
async function runRead(api, id, seen) {
  const view = await answer(api, "GET", `/runs/${id}`);
  meets(view, READS["GET /runs/{id}"], "GET /runs/{id}", seen);
  if (view.path !== null) saw(seen, "run paths", view.path);
  return view;
}

/** A promoted workflow serving runs on the runner: one it answers alone, which its owner grades wrong (an audit row), and
 *  one it hands back. */
async function served(t, seen) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "AGENTRUN_TEST_FAUX_CALLS", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data, store } = await serve(t, { learning: "on", faux: PRICED, runnerTiming: LONG_LEASE });
  // Audited 1 run in 1000, the rarest a definition allows: the audit row read here is the owner's grade. A shadow audit
  // drawn anyway (about 1 test in 500) adds a row beside it, which no assert below reads.
  assert.equal((await api("POST", "/agents", agent("source", { learning: { audit_every: 1000 } }))).status, 201);
  const main = await landWorkflows(data, "source", [{ name: "answer", description: "Answers a question as a number; use when the person asks for the answer", workflow: FLOW }]);
  assert.equal((await decided(store, "source", "answer", DIGEST, { answer: 42, now: at(0), extra: { commit: main } })).decided, "promote");
  const run = async (content) => {
    const started = await api("POST", "/agents/source/runs", { input: { content }, learning: "use" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed", "escalated"], { deadlineMs: 60_000 });
    return started.body.run_id;
  };
  const alone = await run("What is 1 plus 41?");
  const back = await run(HAND_BACK);
  const graded = await api("PUT", `/runs/${alone}/grade`, { correct: false, source: "feedback", label: "it is 41" });
  assert.equal(graded.status, statusOf(seen, "PUT /runs/{id}/grade"), JSON.stringify(graded.body));

  for (const [id, path] of [[alone, "workflow"], [back, "handed_back"]]) {
    assert.equal((await runRead(api, id, seen)).path, path);
    const rows = (await answer(api, "GET", `/runs/${id}/timeline`)).rows;
    const { kind, tool_name } = VALUES["learned workflow row"];
    const learned = rows.filter((row) => row.kind === kind && row.tool_name === tool_name);
    assert.equal(learned.length, 1, `one learned workflow result row, found by its kind and tool name: ${JSON.stringify(rows.map((row) => [row.kind, row.tool_name]))}`);
    saw(seen, "learned workflow row", learned[0].kind, "kind");
    saw(seen, "learned workflow row", learned[0].tool_name, "tool_name");
    const route = "GET /runs/{id}/timeline learned_workflow row";
    meets(learned[0], READS[route], route, seen);
    assert.ok(learned[0].learned_nodes.length > 0 && learned[0].learned_nodes.every((node) => node.label.length > 0), "each node has a label");
  }

  const reads = await learningReads(api, "source", seen);
  const serving = reads.promotions.serving.find((one) => one.workflow === "answer");
  assert.equal(serving?.state, "serving", JSON.stringify(reads.promotions.serving));
  assert.ok(serving.champion?.nodes?.length > 0, `the champion's steps: ${JSON.stringify(serving)}`);
  assert.deepEqual(reads.promotions.promotions.map((one) => one.decided), ["promote"]);
  const grade = reads.audits.audits.find((one) => one.source === VALUES["grade audit source"] && one.agreed === false && one.workflow === "answer" && one.digest === DIGEST);
  assert.ok(grade, `the grade's audit row: ${JSON.stringify(reads.audits)}`);
  saw(seen, "grade audit source", grade.source);
  assert.deepEqual(reads.cost.runs.filter((one) => one.run_id === alone || one.run_id === back).map((one) => [one.run_id, one.path, one.workflow, one.digest]), [[alone, "workflow", "answer", DIGEST], [back, "handed_back", "answer", DIGEST]]);
}

/** A run's end-of-run step (runner/reflect-hook.ts) whose compile turn drafts `answer` at `now`: its first draft refused,
 *  then its second passed and committed (`kept`), or every one refused. Answers the rows it keeps beside the run's end. */
async function compileRound(runId, agentId, now, { kept }) {
  const block = `\`\`\`\`workflow answer\n---\ndescription: Answers a question; use when asked\n---\n${JSON.stringify(FLOW)}\n\`\`\`\``;
  const draft = { name: "answer", files: [{ path: "workflows/answer/workflow.json", text: JSON.stringify(FLOW) }, { path: "workflows/answer/README.md", text: "---\nname: answer\ndescription: d\n---\n" }] };
  const refused = { errors: ["root: no node"] };
  const checks = kept ? [refused, { errors: [], kept: draft, digest: DIGEST }] : [];
  let asked = 0;
  const hook = createReflectHook({
    facts: async () => ({ learns: true, costUsd: 1 }),
    feedback: async () => [],
    correctionRefused: async () => [],
    compileFacts: async () => ({ mode: "new", reference: "REF", traces: [], tools: [], judges: false }),
    compileFailed: async () => undefined,
    checkDraft: async () => (asked++, checks.shift() ?? refused),
    commit: async () => ({ ok: true, commit: "c1" }),
    now: () => now,
  });
  const rows = await hook({ runId, agentId, claim: { runId, runner: "runner-a", epoch: 1, until: 0, from: "running" }, outcome: "completed", signal: new AbortController().signal, ask: async () => ({ ended: true, answer: block }) });
  assert.ok(kept ? asked === 2 && checks.length === 0 : asked >= 1, `drafts checked: ${asked}`);
  return rows;
}

/** A store holding what a runner leaves of two agents' learning (no runner here), each run and record at a fixed minute.
 *  `ledger`: two runs by hand, the second's compile of `answer`, its check's two replays and its promotion, 20 runs it
 *  served, a hold of `second`, a run by hand after it whose compile refused every draft, a recompile's hold of `third`
 *  (stopped), and a connected agent's check of `fourth` reserved. `pricey`: two cheap runs by hand, then two dear runs a
 *  workflow served. Then the reset's statuses, and a launch with the client's learning settings. */
async function ledger(t, seen) {
  const { api, store } = await serve(t, { learning: "on", runner: false });
  const body = { input: { content: "Go." }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0 } };
  const ended = async (agentId, id, minute, costUsd, metrics, { launch = body, rows } = {}) => {
    const revisionId = (await store.agents.get(agentId)).currentRevision;
    await store.runs.create({ id, agentId, revisionId, startedAt: at(minute) }, { body: launch });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd, metrics }, rows);
  };
  const servedBy = { path: "workflow", workflow: "answer", workflow_digest: DIGEST };
  for (const id of ["ledger", "pricey"]) assert.equal((await api("POST", "/agents", agent(id, { learning: { compile_after: 2 } }))).status, 201);

  await ended("ledger", "run-01", 1, 1, { path: "agent" });
  await ended("ledger", "run-02", 2, 1.3, { path: "agent" }, { rows: await compileRound("run-02", "ledger", at(2), { kept: true }) });
  for (const [id, minute] of [["replay-1", 3], ["replay-2", 4]]) await ended("ledger", id, minute, 0.3, { path: "replay", workflow: "answer", workflow_digest: DIGEST, replay: { of: "run-01", outcome: "answered" } }, { launch: { ...body, replay: { of: "run-01", workflow: "answer", digest: DIGEST } } });
  assert.equal((await decided(store, "ledger", "answer", DIGEST, { answer: 42, now: at(5) })).decided, "promote");
  for (let i = 0; i < 20; i++) await ended("ledger", `served-${String(i + 1).padStart(2, "0")}`, 6 + i, 0.1, servedBy);
  assert.equal((await decided(store, "ledger", "second", "e".repeat(16), { answer: 41, now: at(30) })).decided, "hold");
  await ended("ledger", "run-03", 31, 1, { path: "agent" }, { rows: await compileRound("run-03", "ledger", at(31), { kept: false }) });
  const stopped = await decided(store, "ledger", "third", "f".repeat(16), { answer: 41, now: at(32), attempt: 2 });
  assert.equal(stopped.decided, "hold");
  assert.equal(stopped.check?.stopped, true, JSON.stringify(stopped.check));
  const fourth = { name: "fourth", description: "Answers a question; use when asked", workflow: JSON.stringify({ ...FLOW, name: "fourth" }) };
  const reserved = await reserveSdkCheck(checkDeps(store, "ledger", at(33)), { runId: "run-03", revision: "c".repeat(40), learning: { compile_after: 2 }, flows: [fourth], takes: () => true });
  assert.equal(reserved?.workflow.name, "fourth", "a connected agent's check of `fourth` reserved");

  await ended("pricey", "p-01", 1, 0.1, { path: "agent" });
  await ended("pricey", "p-02", 2, 0.1, { path: "agent" });
  await ended("pricey", "p-03", 3, 1, servedBy);
  await ended("pricey", "p-04", 4, 1, servedBy);

  assert.equal((await runRead(api, "run-01", seen)).path, "agent");
  await runRead(api, "served-01", seen);
  const reads = await learningReads(api, "ledger", seen);
  assert.ok(reads.cost.bill?.holds.length > 0, `the hold on the bill: ${JSON.stringify(reads.cost.bill)}`);
  assert.ok(reads.loop.compiles.some((one) => one.draft_errors.length > 0), `a compile that refused every draft: ${JSON.stringify(reads.loop)}`);
  assert.deepEqual(reads.promotions.promotions.map((one) => [one.workflow, one.decided]), [["answer", "promote"], ["second", "hold"], ["third", "hold"], ["fourth", "replaying"]]);
  assert.deepEqual(Object.fromEntries(reads.promotions.serving.map((one) => [one.workflow, one.state])), { answer: "serving", second: "held", third: "stopped", fourth: "checking" });
  const pricey = await learningReads(api, "pricey", seen);
  assert.equal(pricey.cost.bill.break_even, null, "served dearer than by hand: no break-even, a gap");
  const unknown = statusOf(seen, "GET /agents/{id}/learning/{cost,promotions,audits,loop} unknown agent");
  for (const part of ["cost", "promotions", "audits", "loop"]) await answer(api, "GET", `/agents/nobody/learning/${part}`, unknown);

  // An inline launch whose definition carries the client's learning settings, every key, or `true` for the server's
  // defaults: each taken whole.
  const definition = { name: "Helper", instructions: "Answer.", skills: [], tools: [] };
  for (const [id, learning] of [["helper-1", CONTRACT.launch.learning], ["helper-2", true]]) {
    const launched = await api("POST", "/runs", { external: { source: "client", kind: "expert", id, version: "1.abc" }, definition: { ...definition, learning }, input: { content: "What is six times seven?" }, max_cost_usd: 5 });
    assert.equal(launched.status, statusOf(seen, "POST /runs inline launch"), `learning settings ${JSON.stringify(learning)}: ${JSON.stringify(launched.body)}`);
    assert.deepEqual((await answer(api, "GET", `/agents/${launched.body.agent_id}`)).definition.learning, learning);
  }

  // The reset: learning_busy with its wait while a run of the agent is going, reset once it ended, and again; an agent
  // the server never had is not found on the reset and on its read.
  const going = await api("POST", "/agents/ledger/runs", { input: { content: "Go." } });
  assert.equal(going.status, 202, JSON.stringify(going.body));
  const busy = await api("DELETE", "/agents/ledger/learning");
  assert.equal(busy.status, statusOf(seen, "DELETE /agents/{id}/learning while a run of the agent is going"), JSON.stringify(busy.body));
  const route = "DELETE /agents/{id}/learning 409";
  meets(busy.body, READS[route], route, seen);
  saw(seen, "reset busy code", busy.body.error.code);
  const claim = await store.claim(going.body.run_id, "runner-a", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "ended" });
  const reset = statusOf(seen, "DELETE /agents/{id}/learning reset");
  assert.equal((await api("DELETE", "/agents/ledger/learning")).status, reset);
  assert.equal((await api("DELETE", "/agents/ledger/learning")).status, reset, "and again");
  assert.equal((await api("DELETE", "/agents/nobody/learning")).status, statusOf(seen, "DELETE /agents/{id}/learning unknown agent"));
  assert.equal((await api("GET", "/agents/nobody")).status, statusOf(seen, "GET /agents/{id} unknown agent"));
}

test("learning v2 read contract", { timeout: 240_000 }, async (t) => {
  assert.match(CONTRACT.source_revision, /^[0-9a-f]{40}$/, "the client revision the list was taken from");
  const seen = { read: new Set(), filled: new Set(), leafLists: new Set(), values: new Set(), statuses: new Set() };
  await served(t, seen);
  await ledger(t, seen);
  const fields = { all: [], nullable: [], leafLists: [] };
  for (const [route, spec] of Object.entries(READS)) fieldsOf(spec, route, fields);
  assert.deepEqual(fields.all.filter((field) => !seen.read.has(field)), [], "every field was read: a field no answer carried would pass removed");
  assert.deepEqual(fields.nullable.filter((field) => !seen.filled.has(field)), [], "every field that may be null was read with a value, its type checked");
  assert.deepEqual(fields.leafLists.filter((field) => !seen.leafLists.has(field)), [], "every list of leaves was read with an item, its type checked");
  assert.deepEqual(LISTED.filter((value) => !seen.values.has(value)), [], "every value the client switches on was seen: one no answer carried would pass renamed");
  assert.deepEqual(Object.keys(STATUSES).filter((name) => !seen.statuses.has(name)), [], "every status the client expects was asserted");
});
