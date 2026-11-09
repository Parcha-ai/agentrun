// A workflow's call nodes on the runner (runner/workflow-spec.ts), as main's per-run process ran them (app.ts:370-431): a
// call node names one of the call tools (tools.ts CALL_TOOLS: web_fetch, web_search, pdf_pages, llm), its effect runs
// with the run's own context (its work folder, the run's environment, its models for `llm`), its charge books on the
// run's one ledger, and the tool's setting is read again at each call (app.ts:382-384): a tool set to deny, or to ask
// (a call node cannot wait for a person), is refused at the call, in main's words.
//
// Through the real loop (startRunner over createWorkflowLoop and workflowSpecOf) on a real store, with a scripted
// Messages origin for the `llm` calls that counts each request by its node.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");
const { deniedText } = await import("../dist/refusal-words.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { parallelSearchFee } = await import("../dist/paid-calls.js");
const { FAUX_PARALLEL_ENV } = await import("../dist/decisions.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { paidRequestsOf } = await import("./fixtures/paid-requests.mjs");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
/** The run's timeline rows that speak of a paid tool's charge: its Tool cost rows and its Not metered ones. */
const chargeRows = (rows) => rows.filter((row) => row.kind === "phase" && /^(Tool cost|Not metered):/.test(row.summary ?? "")).map((row) => row.summary);
const FAUX_PARALLEL = new URL("./fixtures/faux-parallel-search.mjs", import.meta.url).pathname;

/** A steady lease (this file tests call nodes, not leases): a lease the suite's load can outlast would cut a call node's
 *  admitted effect, which the next claim refuses to repeat (runner-call-claim-lapse.test.mjs pins that). */
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** The words the run's store holds about why a call node failed (the engine's effect records, the node's error), for a
 *  failure's message, so a red says why. */
const whyIn = (text) => [...new Set(text.match(/FROZEN_[A-Z_]+[^"\\]{0,160}|Reconcile[^"\\]{0,160}|"error":"[^"]{0,200}/g) ?? [])].slice(0, 6);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Output $100 a million, input free: an answer of 10 output tokens books $0.001. */
const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
const PER_ANSWER = (10 * 100) / 1e6;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;
const LLM = { type: "object", required: ["text"], properties: { text: { type: "string" } } };

/** A chain of `llm` call nodes, one per word, each asking its word. */
const llmCalls = (...words) => ({
  v: 2, name: "calls",
  schemas: { In: { type: "object", additionalProperties: true }, Llm: LLM },
  input: { schemaId: "In" },
  output: { schemaId: "Llm", path: `c${words.length - 1}` },
  root: words.length === 1
    ? { node: "call", label: "call-0", via: "tool", tool: "llm", args: { prompt: `${words[0]}: say ok.` }, out: "Llm", as: "c0", deadline_s: 120 }
    : { node: "chain", steps: words.map((word, index) => ({ node: "call", label: `call-${index}`, via: "tool", tool: "llm", args: { prompt: `${word}: say ok.` }, out: "Llm", as: `c${index}`, deadline_s: 120 })) },
});

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const said = (model, text, output = 10) => sse([
  { type: "message_start", message: { id: "msg_0", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: output } },
  { type: "message_stop" },
]);

/** The `llm` calls' origin: each request counted under the word its prompt names. */
function wordsOrigin(words, output = 10) {
  const counts = Object.fromEntries(words.map((word) => [word, 0]));
  const fetch = async (_url, init = {}) => {
    const text = String(init.body ?? "{}");
    const word = words.find((one) => text.includes(one)) ?? "unknown";
    counts[word] = (counts[word] ?? 0) + 1;
    return said(JSON.parse(text).model, "ok", output);
  };
  return { fetch, counts };
}

/** run-1, a workflow run of `workflow` (its revision granting `tools`, with `toolSettings`), on a runner whose models go
 *  to `fetch`; its row once it leaves running. */
async function runOn(t, { workflow, tools = ["llm"], toolSettings, fetch, capUsd = 100, plane, env, during }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-call-nodes-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Calls" }, { id: "rev-1", kind: "workflow", body: { workflow, tools, ...(toolSettings ? { toolSettings } : {}) } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "t", place: { mode: "runner" }, max_cost_usd: capUsd, ...(plane ? { plane } : {}) } });
  const providerOf = () => ({
    modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"n"}`,
    policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_model, usage) => (usage.output ?? 0) * 100 / 1e6, capModel: PRICED, fetch,
  });
  runner = startRunner({ store, createLoop: createWorkflowLoop(workflowSpecOf({ store, providerOf, ...(env ? { env } : {}) })), name: "runner-a", ...TIMING });
  const from = Date.now();
  let acted = false;
  for (;;) {
    const row = await server.runs.get("run-1");
    // `during(server, row)`: what a test does once the run first parks (a raise), then the wait goes on to its end.
    if (during && !acted && row.state === "parked" && row.runner === null) {
      acted = true;
      await during(server, row);
      continue;
    }
    // The row, with the store's files' text: the engine's effect records (a call node's outcome) are there, which the
    // timeline's reader passes over.
    const journalText = async () => ["store.sqlite", "store.sqlite-wal"].map((name) => join(dir, name)).filter(existsSync).map((file) => readFileSync(file).toString("utf8")).join("\n");
    const resting = during ? ["ended", "failed", "stopped"] : ["ended", "failed", "stopped", "parked"];
    if (resting.includes(row.state) && row.runner === null) return Object.assign(row, { journalText, paidRequests: () => paidRequestsOf(store), timeline: () => runTimeline(server, "run-1", BACKGROUND_CONTEXT, { settled: true }) });
    if (Date.now() - from > 30_000) assert.fail(`the run never left running: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    await sleep(20);
  }
}

test("an llm call node runs to its end on the runner, its request booked once on the run's ledger", async (t) => {
  const origin = wordsOrigin(["CALL-ONE"]);
  const row = await runOn(t, { workflow: llmCalls("CALL-ONE"), fetch: origin.fetch });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary, why: whyIn(await row.journalText()) }));
  assert.deepEqual(origin.counts, { "CALL-ONE": 1 });
  assert.equal(eight(row.costUsd), eight(PER_ANSWER), `booked once: ${row.costUsd}`);
});

test("an llm call node's hold, given back as its own model request is held, shows no charge row on the run's timeline", async (t) => {
  const origin = wordsOrigin(["CALL-ONE"]);
  const row = await runOn(t, { workflow: llmCalls("CALL-ONE"), fetch: origin.fetch });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  // Its cost is its model request's (main's: an llm call is the run's usage, never a paid tool's charge), so no Tool cost
  // row, and no Not metered one for the hold it gave back unused.
  assert.deepEqual(chargeRows(await row.timeline()), [], "no charge row for the llm call");
});

test("the control: three llm call nodes in a chain, never paused, each run once and booked once", async (t) => {
  const origin = wordsOrigin(["CALL-ONE", "CALL-TWO", "CALL-THREE"]);
  const row = await runOn(t, { workflow: llmCalls("CALL-ONE", "CALL-TWO", "CALL-THREE"), fetch: origin.fetch });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary, why: whyIn(await row.journalText()) }));
  assert.deepEqual(origin.counts, { "CALL-ONE": 1, "CALL-TWO": 1, "CALL-THREE": 1 });
  assert.equal(eight(row.costUsd), eight(3 * PER_ANSWER), `booked once each: ${row.costUsd}`);
});

/** One `llm` call node whose output takes anything (`Any`): only the call's own failure fails it, never its schema. */
const anyOutCall = (word) => ({
  v: 2, name: "any-out",
  schemas: { In: { type: "object", additionalProperties: true }, Any: {} },
  input: { schemaId: "In" },
  output: { schemaId: "Any", path: "c0" },
  root: { node: "call", label: "call-0", via: "tool", tool: "llm", args: { prompt: `${word}: say ok.` }, out: "Any", as: "c0", deadline_s: 120 },
});

test("a call node whose tool the agent's settings deny is refused at the call in main's words (app.ts:382-384), nothing sent, and the node fails though its output takes anything", async (t) => {
  const origin = wordsOrigin(["CALL-ONE"]);
  const row = await runOn(t, { workflow: anyOutCall("CALL-ONE"), toolSettings: { llm: { permission: "deny" } }, fetch: origin.fetch });
  assert.equal(row.state, "failed", JSON.stringify({ state: row.state, summary: row.summary }));
  // The run fails at its call node (its summary, "failed at call-0", as main's), the node's failure in the gate's words.
  const words = deniedText("llm", undefined, "agent");
  assert.ok((await row.journalText()).includes(words), `the node's failure is in main's words: ${words}`);
  assert.deepEqual(origin.counts, { "CALL-ONE": 0 }, "nothing sent");
});

/** One `llm` call node asking for at most `maxTokens` output: its hold is that output at $100 a million (input free). */
const boundedCall = (word, maxTokens) => ({
  v: 2, name: "bounded",
  schemas: { In: { type: "object", additionalProperties: true }, Llm: LLM },
  input: { schemaId: "In" },
  output: { schemaId: "Llm", path: "c0" },
  root: { node: "call", label: "call-0", via: "tool", tool: "llm", args: { prompt: `${word}: say ok.`, maxTokens }, out: "Llm", as: "c0", deadline_s: 120 },
});

test("a paid web_search call node on Parallel: its search sent once, and booked once on the run's ledger at Parallel's fee", async (t) => {
  globalThis.fauxParallelSearches = 0;
  const workflow = {
    v: 2, name: "search",
    schemas: { In: { type: "object", additionalProperties: true }, Any: {} },
    input: { schemaId: "In" },
    output: { schemaId: "Any", path: "found" },
    root: { node: "call", label: "search-0", via: "tool", tool: "web_search", args: { query: "agentrun", n: 3 }, out: "Any", as: "found", deadline_s: 120 },
  };
  const row = await runOn(t, {
    workflow, tools: ["web_search"], fetch: wordsOrigin([]).fetch, plane: { web_search: "parallel" },
    env: { [FAUX_ENV]: "1", [FAUX_PARALLEL_ENV]: FAUX_PARALLEL, PARALLEL_API_KEY: `not-a-secret-${"p"}` },
  });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary, why: whyIn(await row.journalText()) }));
  assert.equal(globalThis.fauxParallelSearches, 1, "one search sent");
  assert.equal(eight(row.costUsd), eight(parallelSearchFee(3).usd), `booked once at Parallel's fee: ${row.costUsd}`);
  // Its request's record names who charges for it, as an agentic run's does (main's charge row: charged_by parallel).
  const paid = await row.paidRequests();
  assert.ok(paid.length > 0, "the search's paid request is in the run's records");
  for (const request of paid) assert.equal(request.charged_by, "parallel", `charged by Parallel: ${JSON.stringify(request)}`);
  // Its one charge row, as main's: who charged and what.
  assert.deepEqual(chargeRows(await row.timeline()), [`Tool cost: parallel charged $${parallelSearchFee(3).usd.toFixed(4)} for ${paid[0].model.slice("paid:".length)}`], "one charge row, Parallel's");
});

test("past the cap, an llm call node's hold is refused before its effect is admitted: the run parks with nothing sent, and a raise sends it once", async (t) => {
  // Its hold: 32,000 output tokens (none named) at $100 a million, $3.20, over a $1 cap.
  const origin = wordsOrigin(["CALL-ONE"]);
  let atPark;
  const row = await runOn(t, {
    workflow: llmCalls("CALL-ONE"), fetch: origin.fetch, capUsd: 1,
    during: async (server, parked) => {
      atPark = { counts: { ...origin.counts }, summary: parked.summary };
      await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 10 } });
    },
  });
  assert.deepEqual(atPark?.counts, { "CALL-ONE": 0 }, `parked before anything was sent: ${JSON.stringify(atPark)}`);
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary, why: whyIn(await row.journalText()) }));
  assert.deepEqual(origin.counts, { "CALL-ONE": 1 }, "the raise sent it once");
  assert.equal(eight(row.costUsd), eight(PER_ANSWER), `booked once: ${row.costUsd}`);
});

test("a call charged exactly its hold is never failed by the net: an llm answer of its whole asked output ends the run", async (t) => {
  // maxTokens 10: its hold is 10 output tokens at $100 a million; the answer reports exactly 10.
  const origin = wordsOrigin(["CALL-ONE"], 10);
  const row = await runOn(t, { workflow: boundedCall("CALL-ONE", 10), fetch: origin.fetch });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary, why: whyIn(await row.journalText()) }));
  assert.equal(eight(row.costUsd), eight(PER_ANSWER));
});

test("the net: an llm call whose answer costs more than its hold fails in the cap's words", async (t) => {
  // maxTokens 10 held; the provider bills 20 output tokens, above its own bound.
  const origin = wordsOrigin(["CALL-ONE"], 20);
  const row = await runOn(t, { workflow: boundedCall("CALL-ONE", 10), fetch: origin.fetch });
  assert.equal(row.state, "failed", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.match(await row.journalText(), /its answer cost \$[\d.]+, above the \$[\d.]+ it held before it ran/, "the call's failure in the cap's words");
});
