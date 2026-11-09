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

const TIMING = { leaseMs: 1_000, renewEveryMs: 250, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
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
function wordsOrigin(words) {
  const counts = Object.fromEntries(words.map((word) => [word, 0]));
  const fetch = async (_url, init = {}) => {
    const text = String(init.body ?? "{}");
    const word = words.find((one) => text.includes(one)) ?? "unknown";
    counts[word] = (counts[word] ?? 0) + 1;
    return said(JSON.parse(text).model, "ok");
  };
  return { fetch, counts };
}

/** run-1, a workflow run of `workflow` (its revision granting `tools`, with `toolSettings`), on a runner whose models go
 *  to `fetch`; its row once it leaves running. */
async function runOn(t, { workflow, tools = ["llm"], toolSettings, fetch, capUsd = 100 }) {
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
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "t", place: { mode: "runner" }, max_cost_usd: capUsd } });
  const providerOf = () => ({
    modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"n"}`,
    policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_model, usage) => (usage.output ?? 0) * 100 / 1e6, capModel: PRICED, fetch,
  });
  runner = startRunner({ store, createLoop: createWorkflowLoop(workflowSpecOf({ store, providerOf })), name: "runner-a", ...TIMING });
  const from = Date.now();
  for (;;) {
    const row = await server.runs.get("run-1");
    // The row, with the store's files' text: the engine's effect records (a call node's outcome) are there, which the
    // timeline's reader passes over.
    const journalText = async () => ["store.sqlite", "store.sqlite-wal"].map((name) => join(dir, name)).filter(existsSync).map((file) => readFileSync(file).toString("utf8")).join("\n");
    if (["ended", "failed", "stopped", "parked"].includes(row.state) && row.runner === null) return Object.assign(row, { journalText });
    if (Date.now() - from > 30_000) assert.fail(`the run never left running: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    await sleep(20);
  }
}

test("an llm call node runs to its end on the runner, its request booked once on the run's ledger", async (t) => {
  const origin = wordsOrigin(["CALL-ONE"]);
  const row = await runOn(t, { workflow: llmCalls("CALL-ONE"), fetch: origin.fetch });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.deepEqual(origin.counts, { "CALL-ONE": 1 });
  assert.equal(eight(row.costUsd), eight(PER_ANSWER), `booked once: ${row.costUsd}`);
});

test("the control: three llm call nodes in a chain, never paused, each run once and booked once", async (t) => {
  const origin = wordsOrigin(["CALL-ONE", "CALL-TWO", "CALL-THREE"]);
  const row = await runOn(t, { workflow: llmCalls("CALL-ONE", "CALL-TWO", "CALL-THREE"), fetch: origin.fetch });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
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
