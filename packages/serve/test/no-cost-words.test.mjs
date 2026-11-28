// The no-cost-words setting (AGENTRUN_NO_COST_WORDS=1, ServeOptions.noCostWords): a server behind a host that prices its
// runs itself writes no cost in a billing row's words (the usage row, a paid tool's charge row), so the host hands its
// rows on as they are. The structured `usage` on each row is the same either way; off, every row is as it always was.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionRows, withDecisions } from "../dist/decision-rows.js";
import { switchFrom, NO_COST_WORDS_ENV } from "../dist/env-switch.js";
import { withOverCap } from "../dist/run-view.js";
import { CAP_WRAPUP, REQUEST_STARTED, timelineOf, TOOL_COST } from "../dist/timeline/index.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, serve } from "./support.mjs";
import { assistant, custom, user } from "./timeline-lib-support.mjs";

const FAUX = new URL("./fixtures/faux-tools-cost.mjs", import.meta.url).pathname;
const RUN_MODEL = "mcp:fal/run_model";
const COST_WORDS = /\$|usd|cost/i;

/** A run's billing rows (its usage row and each paid tool's charge row), read through GET /runs/{id}/timeline from a server
 *  started with `options`: one fal job at $0.03 an image, two images. */
async function billingRows(t, options) {
  const { api } = await serve(t, { faux: FAUX, ...options });
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  fake.tools.get_pricing = { description: "fal's price for an endpoint.", input: { type: "object", properties: { endpoint_id: { type: "string" } }, required: ["endpoint_id"], additionalProperties: false }, run: ({ endpoint_id }) => ({ content: [{ type: "text", text: JSON.stringify({ prices: [{ endpoint_id, unit_price: 0.03, unit: "images", currency: "USD" }], next_cursor: null, has_more: false }) }] }) };
  fake.tools.run_model = { description: "Run a fal model.", input: { type: "object", properties: {} }, run: (args) => ({ content: [{ type: "text", text: JSON.stringify({ status: "completed", submission_replayed: false, endpoint_id: args.endpoint_id, request_id: "r1", result: { images: [{ url: "https://v3.fal.media/1.png" }, { url: "https://v3.fal.media/2.png" }] }, has_result: true }) }] }) };
  assert.equal((await api("PUT", "/settings/mcp-servers/fal", { url: fake.url, auth: { type: "none" }, toolkit: "fal" })).status, 200);
  assert.equal((await api("POST", "/agents", agent("card", { tools: [RUN_MODEL], tool_settings: { [RUN_MODEL]: { permission: "allow" } } }))).status, 201);
  const run = await api("POST", "/agents/card/runs", { input: { content: 'Call mcp__fal__run_model with {"endpoint_id":"fal-ai/ideogram/v3","input":{"rendering_speed":"TURBO","prompt":"a card","num_images":2},"submission_key":"card-1"}' }, max_cost_usd: 1 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const billing = rows.filter((row) => row.kind === "usage" || (row.kind === "phase" && row.usage));
  assert.equal(billing.length, 2, JSON.stringify(rows.map((row) => [row.kind, row.summary])));
  return billing;
}

test("with no-cost-words on, a run's usage row and its paid tool's charge row say no cost in any word over HTTP, and their usage is the same as with it off", { timeout: 180_000 }, async (t) => {
  const priced = await billingRows(t, {});
  const unpriced = await billingRows(t, { noCostWords: true });
  // Off: the words every server writes.
  assert.deepEqual(priced.map((row) => row.summary), ["Tool cost: fal charged $0.0600 for mcp:fal/run_model", "Cost: $0.0624 over 2 model requests and 1 paid tool call"]);
  // On: what was counted and who charged for what, no figure.
  assert.deepEqual(unpriced.map((row) => row.summary), ["mcp:fal/run_model via fal", "2 model requests and 1 paid tool call"]);
  for (const row of unpriced) {
    for (const [field, value] of Object.entries(row)) {
      if (typeof value === "string") assert.doesNotMatch(value, COST_WORDS, `${row.kind} row's ${field}`);
    }
  }
  assert.deepEqual(unpriced.map((row) => row.usage), priced.map((row) => row.usage), "the structured usage is the same");
});

test("the renderer with costWords false: the usage row says what it counted, a paid tool's charge row who charged for which tool; usage unchanged", () => {
  const entries = [user("go"), custom(REQUEST_STARTED, {}), assistant([{ type: "text", text: "one" }], 0, { usage: { input: 10, output: 5, cost: { total: 0.01 } } }), custom(TOOL_COST, { tool: "monid:apollo/people/match", charged_by: "monid", usd: 0.026, call: "c1" })];
  const words = (options) => timelineOf(entries, { settled: true, ended: true, ...options }).filter((row) => row.usage).map((row) => [row.kind, row.summary, row.usage]);
  const off = words({});
  assert.deepEqual(off.map(([, summary]) => summary), ["Tool cost: monid charged $0.0260 for monid:apollo/people/match", "Cost: $0.0360 over 1 model request and 1 paid tool call"]);
  const on = words({ costWords: false });
  assert.deepEqual(on.map(([, summary]) => summary), ["monid:apollo/people/match via monid", "1 model request and 1 paid tool call"]);
  assert.deepEqual(on.map(([kind, , usage]) => [kind, usage]), off.map(([kind, , usage]) => [kind, usage]));
});

test("a reply the cap's clamp cut short says so with costWords false, with no amount; off, as before", () => {
  const entries = [user("go"), custom(REQUEST_STARTED, { heldUsd: 0.15, clamp: { tokens: 1_500, leftUsd: 0.15, capUsd: 0.5 } }), assistant([{ type: "text", text: "The first half" }], 0, { stopReason: "length", usage: { input: 10, output: 1_500, cost: { total: 0.15 } } })];
  const clampRow = (options) => timelineOf(entries, { settled: true, ...options }).find((row) => row.id.endsWith(":clamp"))?.summary;
  assert.equal(clampRow({}), "The reply stopped at 1,500 tokens: all that the $0.15 left of the run's $0.50 cap could buy.");
  assert.equal(clampRow({ costWords: false }), "The reply stopped at 1,500 tokens: all that was left of the run's cap could buy.");
});

test("a workflow's usage row with costWords false counts its model requests and decisions, or says its decisions could not be read; no figure", () => {
  const usageRow = { id: "1:usage", timestamp: "2026-10-29T23:00:05.000Z", created_at: "2026-10-29T23:00:05.000Z", kind: "usage", summary: "x", agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, text: null, usage: { usd: 0.01, requests: 1 } };
  const receipt = { id: "d1", at: "2026-10-29T23:00:00.000Z", node: "checks", kind: "judge", request: { index: 0, count: 1 }, status: "answered", answers: { ok: { type: "noul", noul: 0.9 } }, cost_usd: 0.004 };
  const off = withDecisions([usageRow], [receipt], undefined, { ended: true }).at(-1);
  const on = withDecisions([usageRow], [receipt], undefined, { ended: true, costWords: false }).at(-1);
  assert.equal(off.summary, "Cost: $0.0140 over 1 model request and 1 decision");
  assert.equal(on.summary, "1 model request and 1 decision");
  assert.deepEqual(on.usage, off.usage);
  assert.equal(withDecisions([usageRow], null, undefined, { costWords: false }).at(-1).summary, "1 model request; its decisions could not be read");
  assert.doesNotMatch(decisionRows([receipt])[0].summary, COST_WORDS, "a decision row's own words name no cost");
});

test("a dollar cap's wrap-up note with costWords false says the run neared its cap, no amount; off, its words as told; a free-limit note unchanged either way", () => {
  const told = "About $0.10 left of this run's budget: finish now with your answer.";
  const dollar = custom(CAP_WRAPUP, { words: told, leftUsd: 0.1, capUsd: 1 });
  const free = "3 requests left of this run's 60 on free models: finish now with your answer.";
  const freeNote = custom(CAP_WRAPUP, { words: free, freeLimit: 60 });
  const noteRows = (entry, options) => timelineOf([user("go"), entry], { settled: true, ...options }).filter((row) => row.origin === "server").map((row) => [row.summary, row.text]);
  assert.deepEqual(noteRows(dollar, {}), [[`AgentRun: ${told}`, told]]);
  const [[summary, text]] = noteRows(dollar, { costWords: false });
  assert.doesNotMatch(summary, /\$/);
  assert.doesNotMatch(text, /\$/);
  assert.equal(summary, `AgentRun: ${text}`);
  assert.deepEqual(noteRows(freeNote, { costWords: false }), [[`AgentRun: ${free}`, free]]);
  assert.deepEqual(noteRows(freeNote, {}), [[`AgentRun: ${free}`, free]]);
});

test("the over-cap row with costWords false says the run went over, or may have, with no figure; off, as before", () => {
  const usage = (fields) => ({ id: "1:usage", kind: "usage", summary: "x", seq: 9, text: null, usage: { requests: 2, ...fields } });
  const final = { id: "1:3", kind: "final_answer", summary: "Done.", seq: 8, text: "Done." };
  const spent = [final, usage({ usd: 1.25 })];
  const atMost = [final, usage({ usd: 0.26, upper_bound: true })];
  assert.equal(withOverCap(spent, 1)[2].summary, "Spent $1.25, $0.25 over the run's cap of $1");
  assert.equal(withOverCap(atMost, 0.2)[2].summary, "At most $0.26 spent, at most $0.06 over the run's cap of $0.20");
  assert.equal(withOverCap(spent, 1, { costWords: false })[2].summary, "Over the run's cap");
  assert.equal(withOverCap(atMost, 0.2, { costWords: false })[2].summary, "Possibly over the run's cap");
  assert.equal(withOverCap(spent, 1, { costWords: false }).length, 3);
});

test("AGENTRUN_NO_COST_WORDS is an on/off setting: 1 or true on, unset or 0 off, anything else refused in its words", () => {
  assert.equal(NO_COST_WORDS_ENV, "AGENTRUN_NO_COST_WORDS");
  assert.equal(switchFrom(NO_COST_WORDS_ENV, { AGENTRUN_NO_COST_WORDS: "1" }), true);
  assert.equal(switchFrom(NO_COST_WORDS_ENV, {}), false);
  assert.throws(() => switchFrom(NO_COST_WORDS_ENV, { AGENTRUN_NO_COST_WORDS: "yes" }), /AGENTRUN_NO_COST_WORDS is 1 \(/);
});
