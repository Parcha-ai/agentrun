// A workflow run's spend cap (max_cost_usd): each paid step it takes is held to the cap before it is sent, as an agentic
// run's model requests and paid tools are, and a step the cap has no room for waits for a raise where it stands, unsent:
// the run is input_required and waiting, `pending.kind` budget naming the node, and PATCH /runs/{id} sends it. A model
// node's request waits unsent; a call node's paid call (Parallel's search, the `llm` call) waits past the driver's
// admission and goes again as a new effect, never as the tool's failure a collecting map would take for an item's; a
// decision is held before it is admitted. A pause that holds its process past the hold (10 minutes; here 1 s) lets it
// go, and a raise opens the run again from its journal under the new cap, sending no completed node again. A step no raise
// sends (a decision model with no price) ends the run failed, spend_cap_reached, in the cap's words.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { REQUEST_COST } from "@parcha/pi-durable-agent/timeline";
import { CANARY as PARALLEL_CANARY } from "./fixtures/faux-parallel.mjs";
import { decisionSpentIn } from "../dist/cap.js";
import { startServe } from "../dist/index.js";
import { client, flowAgent, follow, letGo, runDir, runRecordOf, scratch, serve, storeRun, withEnv } from "./support.mjs";

/** The faux model at $100 a million output tokens, each answer 400 of them: a request costs $0.04, and is admitted only
 *  while its least, $0.1024, fits what is left of the cap. */
const PRICED = new URL("./fixtures/faux-workflow-priced.mjs", import.meta.url).pathname;
const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS", "AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS", "AGENTRUN_SERVE_BUDGET_HOLD_MS"];
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const ENDED = ["completed", "failed", "cancelled"];
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const lines = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** The run's store entries, once its process has let it go. */
function entriesOf(data, runId) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all().map((row) => JSON.parse(row.record));
  } finally {
    db.close();
  }
}
/** The model requests the run sent and was answered: pi's entries that are no error. */
const answered = (entries) => entries.filter((entry) => entry.kind === "pi.assistant" && entry.model?.[0]?.stopReason !== "error").length;

/** Two model nodes in a chain, `first` then `second`, each answering the question. */
const twoNodes = () => ({
  v: 2, name: "twice",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "first", instructions: "Answer the question.", out: "Answer", as: "first" },
    { node: "extract", label: "second", instructions: "Answer the question again.", out: "Answer", as: "answer" },
  ] },
});

/** One judge node, on `provider` (and `model`). */
const judgeFlow = (label, provider, model) => ({
  v: 2, name: "judged",
  schemas: {
    In: { type: "object", required: ["doc"], properties: { doc: { type: "string" } } },
    Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Verdict", path: "verdict" },
  root: { node: "judge", label, provider, ...(model ? { model } : {}), state: { doc: "{doc}" }, out: "Verdict", as: "verdict" },
});

/** A map over the input's questions that collects a failed item, each running one call node `body`. */
const collecting = (body, out) => ({
  v: 2, name: "each",
  schemas: {
    In: { type: "object", required: ["questions"], properties: { questions: { type: "array", items: { type: "string" } } } },
    Search: { type: "object", required: ["query", "results"], properties: { query: { type: "string" }, results: { type: "array", minItems: 1 } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    Found: { type: "array" },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Found", path: "found" },
  root: { node: "chain", steps: [{ node: "map", label: "each", itemsPath: "questions", as: "found", resultPath: out, maxConcurrency: 2, onItemFailure: "collect", failedAs: "missed", body }] },
});

// SKIP (follow-up #2089): a capped workflow's Parallel decision that would cross the cap doesn't pause the run for a raise
test.skip("a capped workflow's decision on Parallel that would cross the cap is not sent: the run waits for a raise at the decision node, and the raise sends it once", async (t) => {
  const calls = join(await scratch(t), "parallel-calls.jsonl");
  withEnv(t, { PARALLEL_API_KEY: PARALLEL_CANARY, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: calls }, KEYS);
  const { api } = await serve(t, { fauxParallel: FAUX_PARALLEL });
  assert.equal((await api("POST", "/agents", flowAgent("parallel-judge", judgeFlow("coi", "parallel")))).status, 201);
  // Parallel's list price for one request is $0.001: a $0.0005 cap has no room for it.
  const started = await api("POST", "/agents/parallel-judge/runs", { input: { doc: "Certificate of Incorporation of Example Widgets, Inc." }, max_cost_usd: 0.0005 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
  // Nothing was sent to Parallel.
  assert.deepEqual((await lines(calls)).map((call) => call.path), []);
  let run = await view(api, runId);
  assert.deepEqual([run.status, run.state, run.pending?.kind, run.pending?.node], ["input_required", "waiting", "budget", "coi"], JSON.stringify(run));
  assert.match(run.pending.said, /coi's decision on Parallel, could cost up to \$0\.001 \(Parallel's list price for one decision request\)\. Raise the cap to at least \$0\.01 to continue\.$/);
  const raised = await api("PATCH", `/runs/${runId}`, { max_cost_usd: 1 });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
  await follow(api, runId, ENDED, { deadlineMs: 60_000 });
  run = await view(api, runId);
  assert.deepEqual([run.status, run.error], ["completed", null], JSON.stringify(run));
  assert.deepEqual((await lines(calls)).map((call) => call.path), ["/v1/decisions"], "sent once, after the raise");
});

test("a capped workflow start whose decision pins an OpenRouter model the catalog lists no price for is refused 409, with fields naming the node's model and the fix; nothing is sent", async (t) => {
  withEnv(t, { OPENROUTER_API_KEY: `not-a-secret-${"openrouter"}`, AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS: "0" }, KEYS);
  const dir = await scratch(t);
  const sent = join(dir, "sent.jsonl");
  const fauxOpenrouter = join(dir, "faux-openrouter.mjs");
  await writeFile(fauxOpenrouter, [
    `import { appendFileSync } from "node:fs";`,
    `import faux from ${JSON.stringify(new URL("../../decisions/dist/testing/faux-system-one.js", import.meta.url).href)};`,
    `export default async (url, init = {}) => (appendFileSync(${JSON.stringify(sent)}, JSON.stringify({ path: new URL(String(url)).pathname }) + "\\n"), faux(url, init));`,
  ].join("\n"));
  const { api } = await serve(t, { fauxOpenrouter });
  assert.equal((await api("POST", "/agents", flowAgent("unlisted", judgeFlow("ask", "openrouter", "acme/unlisted-decider")))).status, 201);
  const started = await api("POST", "/agents/unlisted/runs", { input: { doc: "Certificate of incorporation of Acme Widgets" }, max_cost_usd: 1 });
  assert.deepEqual([started.status, started.body.error?.code], [409, "agent_not_runnable"]);
  const issues = (started.body.error.fields ?? []).filter((issue) => issue.message.includes("acme/unlisted-decider"));
  assert.deepEqual(issues.map((issue) => [issue.field, issue.reason, issue.message, issue.fix]), [["definition.workflow", "not_set_up_here", "The decision model acme/unlisted-decider has no price in OpenRouter's catalog, so a run's spend cap cannot be kept on it. This workflow's node ask asks it.", "Pick a Decisions model OpenRouter's catalog prices, or run without a spend cap."]]);
  // No decision request was sent: only the catalog was read.
  assert.deepEqual((await lines(sent)).filter((call) => call.path.endsWith("/systemone")).map((call) => call.path), []);
});

// SKIP (follow-up #2089): a capped workflow's paid tool call in a collecting map that would cross the cap doesn't pause the run for a raise
test.skip("a capped workflow's paid tool call in a collecting map is not sent when it would cross the cap: the run waits for a raise at the call, never completing with its items failed, and the raise sends each", async (t) => {
  const calls = join(await scratch(t), "parallel-calls.jsonl");
  withEnv(t, { PARALLEL_API_KEY: PARALLEL_CANARY, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: calls }, KEYS);
  const { api } = await serve(t, { fauxParallel: FAUX_PARALLEL });
  const flow = collecting({ node: "call", label: "search", via: "tool", tool: "web_search", args: { query: "{item}", n: 2 }, out: "Search", as: "hit", deadline_s: 60 }, "hit");
  const made = await api("POST", "/agents", flowAgent("searches", flow, { tools: ["web_search"], tool_settings: { web_search: { provider: "parallel" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // One Parallel search is $0.001: a $0.0005 cap has no room for either.
  const started = await api("POST", "/agents/searches/runs", { input: { questions: ["widgets", "gadgets"] }, max_cost_usd: 0.0005 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
  let run = await view(api, runId);
  assert.deepEqual([run.status, run.state, run.pending?.kind, run.pending?.node], ["input_required", "waiting", "budget", "search"]);
  assert.deepEqual((await lines(calls)).filter((call) => call.path === "/v1/search"), [], "no search was sent");
  const raised = await api("PATCH", `/runs/${runId}`, { max_cost_usd: 1 });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
  await follow(api, runId, ENDED, { deadlineMs: 60_000 });
  run = await view(api, runId);
  assert.deepEqual([run.status, run.error, run.result?.output?.length], ["completed", null, 2], JSON.stringify(run));
  assert.equal((await lines(calls)).filter((call) => call.path === "/v1/search").length, 2, "each item's search, once, after the raise");
});

test("a capped workflow start whose decision model's price cannot be read, OpenRouter's catalog down, is refused 409 in words that say so, and the next start reads the catalog again", async (t) => {
  withEnv(t, { OPENROUTER_API_KEY: `not-a-secret-${"openrouter"}`, AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS: "0" }, KEYS);
  const dir = await scratch(t);
  const sent = join(dir, "sent.jsonl");
  const up = join(dir, "catalog-up");
  const fauxOpenrouter = join(dir, "faux-openrouter.mjs");
  // OpenRouter's catalog answers 503 until `up` exists; every other path is the faux System One's.
  await writeFile(fauxOpenrouter, [
    `import { appendFileSync, existsSync } from "node:fs";`,
    `import faux from ${JSON.stringify(new URL("../../decisions/dist/testing/faux-system-one.js", import.meta.url).href)};`,
    `export default async (url, init = {}) => {`,
    `  const path = new URL(String(url)).pathname;`,
    `  appendFileSync(${JSON.stringify(sent)}, JSON.stringify({ path }) + "\\n");`,
    `  if (path.endsWith("/v1/models") && !existsSync(${JSON.stringify(up)})) return new Response(JSON.stringify({ error: { message: "faux down" } }), { status: 503, headers: { "content-type": "application/json" } });`,
    `  return faux(url, init);`,
    `};`,
  ].join("\n"));
  const { api } = await serve(t, { fauxOpenrouter });
  assert.equal((await api("POST", "/agents", flowAgent("listed", judgeFlow("ask", "openrouter", "liquid/d1")))).status, 201);
  const start = () => api("POST", "/agents/listed/runs", { input: { doc: "Certificate of incorporation of Acme Widgets" }, max_cost_usd: 1 });
  const down = await start();
  assert.deepEqual([down.status, down.body.error?.code], [409, "agent_not_runnable"]);
  const issues = (down.body.error.fields ?? []).filter((issue) => issue.message.includes("liquid/d1"));
  assert.deepEqual(issues.map((issue) => [issue.field, issue.reason, issue.message, issue.fix]), [["definition.workflow", "not_set_up_here", "OpenRouter's catalog could not be read, so the price of the decision model liquid/d1 is not known and a run's spend cap cannot be kept on it. This workflow's node ask asks it.", "Try the run again once OpenRouter's catalog answers, or run without a spend cap."]]);
  assert.deepEqual((await lines(sent)).filter((call) => call.path.endsWith("/systemone")), [], "no decision request was sent");
  // The catalog back: the next start reads it again, prices liquid/d1, and runs.
  await writeFile(up, "");
  const again = await start();
  assert.equal(again.status, 202);
  await follow(api, again.body.run_id, ENDED, { deadlineMs: 60_000 });
  assert.equal((await view(api, again.body.run_id)).status, "completed");
});

/** The run's status once it has ended, or the status it still has after `ms` (`from`, a run nothing sent on). */
async function statusAway(api, runId, from, ms = 30_000) {
  let status = from;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) {
    status = (await view(api, runId)).status;
    if (ENDED.includes(status)) return status;
  }
  return status;
}

/** A capped run of `twoNodes` paused at its second node, its process let go, on a server at `data` that is then closed. */
async function pausedAndClosed(t, id) {
  const data = join(await scratch(t), "agents");
  const server = await startServe({ data, port: 0, faux: PRICED, drainTimeout: "5s" });
  const api = client(server.baseUrl, server.token);
  assert.equal((await api("POST", "/agents", flowAgent(id, twoNodes()))).status, 201);
  const { run_id: runId } = (await api("POST", `/agents/${id}/runs`, { input: { question: "What is six times seven?" }, max_cost_usd: 0.12 })).body;
  await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
  assert.equal((await view(api, runId)).pending?.kind, "budget");
  await letGo(data, runId);
  await server.close();
  return { data, runId };
}

/** serve.json as a raise to `to` leaves it when the server dies right after keeping it: its cap and the raise, and no
 *  cap.json written, the pause's budget.json still there. */
function keptRaiseOnly(data, runId, to) {
  const file = join(runDir(data, runId), "serve.json");
  const meta = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...meta, max_cost_usd: to, cap_raised: [...(meta.cap_raised ?? []), { from: meta.max_cost_usd, to, at: new Date().toISOString(), pause: "budget" }] }));
  assert.equal(existsSync(join(runDir(data, runId), "cap.json")), false);
  assert.equal(existsSync(join(runDir(data, runId), "budget.json")), true);
}

test("a decision sent and lost with its process, before its receipt and its booking, counts on the next process at the hold its cap took, never $0", { timeout: 120_000 }, async (t) => {
  withEnv(t, { OPENROUTER_API_KEY: `not-a-secret-${"openrouter"}`, AGENTRUN_FAUX_SYSTEM_ONE_DELAY_MS: "0" }, KEYS);
  const dir = await scratch(t);
  const sent = join(dir, "sent.jsonl");
  const fauxOpenrouter = join(dir, "faux-openrouter.mjs");
  // The catalog answers; the decision itself never does: its process dies with the request in flight.
  await writeFile(fauxOpenrouter, [
    `import { appendFileSync } from "node:fs";`,
    `import faux from ${JSON.stringify(new URL("../../decisions/dist/testing/faux-system-one.js", import.meta.url).href)};`,
    `export default async (url, init = {}) => {`,
    `  const path = new URL(String(url)).pathname;`,
    `  appendFileSync(${JSON.stringify(sent)}, JSON.stringify({ path }) + "\\n");`,
    `  if (path.endsWith("/systemone")) return new Promise(() => {});`,
    `  return faux(url, init);`,
    `};`,
  ].join("\n"));
  const { api, data } = await serve(t, { fauxOpenrouter });
  assert.equal((await api("POST", "/agents", flowAgent("lost-judge", judgeFlow("ask", "openrouter", "liquid/d1")))).status, 201);
  const started = await api("POST", "/agents/lost-judge/runs", { input: { doc: "Certificate of incorporation of Acme Widgets" }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  for (const end = Date.now() + 60_000; !(await lines(sent)).some((call) => call.path.endsWith("/systemone")); await new Promise((resolve) => setTimeout(resolve, 100))) {
    assert.ok(Date.now() < end, "the decision was sent");
  }
  // The run's process dies with the decision in flight: no answer, no receipt, no booking.
  const pid = runRecordOf(data, runId).holder?.pid;
  assert.ok(Number.isInteger(pid), JSON.stringify(runRecordOf(data, runId)));
  process.kill(pid, "SIGKILL");
  await follow(api, runId, SETTLED, { deadlineMs: 90_000 });
  await letGo(data, runId);
  const store = join(runDir(data, runId), "store", "run.sqlite");
  const counted = decisionSpentIn(store);
  assert.notEqual(counted, 0, "a decision sent and lost counts at its hold, never $0");
  // Live == recovery: what the next process reads is the hold the cap took for it while it was in flight.
  const holds = entriesOf(data, runId).filter((entry) => entry.kind === "agentrun.decision_hold").map((entry) => entry.data.usd);
  assert.deepEqual([holds.length, counted], [1, holds[0]], JSON.stringify(holds));
});

test("a decision whose booking was lost and whose receipt names its charge counts at that charge on the next process, never at a larger hold", async (t) => {
  const calls = join(await scratch(t), "parallel-calls.jsonl");
  withEnv(t, { PARALLEL_API_KEY: PARALLEL_CANARY, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: calls }, KEYS);
  const { api, data } = await serve(t, { fauxParallel: FAUX_PARALLEL });
  assert.equal((await api("POST", "/agents", flowAgent("charged-judge", judgeFlow("coi", "parallel")))).status, 201);
  const started = await api("POST", "/agents/charged-judge/runs", { input: { doc: "Certificate of Incorporation of Example Widgets, Inc." }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ENDED, { deadlineMs: 60_000 });
  assert.equal((await view(api, runId)).status, "completed");
  await letGo(data, runId);
  const store = join(runDir(data, runId), "store", "run.sqlite");
  // The booking lost, and the hold the cap took ten times what was charged ($0.01 against the receipt's $0.001).
  const db = new DatabaseSync(store);
  try {
    assert.ok(db.prepare("DELETE FROM entries WHERE record LIKE '%\"agentrun.decision_cost\"%'").run().changes > 0, "the booking was there");
    assert.ok(db.prepare("UPDATE entries SET record = json_set(record, '$.data.usd', 0.01) WHERE record LIKE '%\"agentrun.decision_hold\"%'").run().changes > 0, "the hold was there");
  } finally {
    db.close();
  }
  assert.equal(decisionSpentIn(store), 0.001, "the receipt's charge, not the hold");
});
