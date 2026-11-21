// A fal job's price shows on the run as any paid tool's does: a "Tool cost" row on its timeline, `cost.tools_usd` on its
// read and a `tools` line on /usage, inside the run's `usd`. The real server and runner, a faux model at a fixed price a
// request, and a fake MCP server saved with the toolkit `fal` that answers fal's get_pricing and run_model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_USD } from "./fixtures/faux-tools-cost.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, serve } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-tools-cost.mjs", import.meta.url).pathname;
const RUN_MODEL = "mcp:fal/run_model";
const micro = (usd) => (usd === null || usd === undefined ? usd : Math.round(usd * 1e6));

test("a run's fal job: a Tool cost row, tools_usd and a /usage tools line at fal's price for it, inside usd", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX });
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  // fal's price for ideogram/v3 (get_pricing, read 2026-11-20): $0.03 an image.
  fake.tools.get_pricing = { description: "fal's price for an endpoint.", input: { type: "object", properties: { endpoint_id: { type: "string" } }, required: ["endpoint_id"], additionalProperties: false }, run: ({ endpoint_id }) => ({ content: [{ type: "text", text: JSON.stringify({ prices: [{ endpoint_id, unit_price: 0.03, unit: "images", currency: "USD" }], next_cursor: null, has_more: false }) }] }) };
  fake.tools.run_model = { description: "Run a fal model.", input: { type: "object", properties: {} }, run: (args) => ({ content: [{ type: "text", text: JSON.stringify({ status: "completed", submission_replayed: false, endpoint_id: args.endpoint_id, request_id: "r1", result: { images: [{ url: "https://v3.fal.media/1.png" }, { url: "https://v3.fal.media/2.png" }] }, has_result: true }) }] }) };
  const saved = await api("PUT", "/settings/mcp-servers/fal", { url: fake.url, auth: { type: "none" }, toolkit: "fal" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const made = await api("POST", "/agents", agent("card", { tools: [RUN_MODEL], tool_settings: { [RUN_MODEL]: { permission: "allow" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // The run has a cap, so the job is held under it before it is sent.
  const run = await api("POST", "/agents/card/runs", { input: { content: 'Call mcp__fal__run_model with {"endpoint_id":"fal-ai/ideogram/v3","input":{"prompt":"a share card","num_images":2}}' }, max_cost_usd: 1 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "run_model").length, 1, "the job was sent once");

  const costs = rows.filter((row) => row.kind === "phase" && /^Tool cost:/.test(row.summary ?? ""));
  assert.deepEqual(costs.map((row) => [row.summary, row.tool_name, row.usage?.usd]), [["Tool cost: fal charged $0.0600 for mcp:fal/run_model", RUN_MODEL, 0.06]], "one row: 2 images at $0.03");
  assert.deepEqual(rows.filter((row) => /^Not metered:/.test(row.summary ?? "")).map((row) => row.summary), [], "a fal job is never shown as not metered");
  assert.equal(view.cost.tools_usd, 0.06, "tools_usd: the job");
  const requests = view.cost.tokens.requests;
  assert.equal(requests, 2, "the call, then the answer: the price's read is no request and no call of the agent's");
  assert.equal(micro(view.cost.usd), micro(requests * REQUEST_USD + 0.06), "usd: the model's requests and the job");
  const usage = (await api("GET", `/runs/${run.body.run_id}/usage`)).body;
  const tools = usage.lines.filter((line) => line.meter === "tools");
  assert.deepEqual(tools.map((line) => [line.charged_by, line.quantity, line.unit, line.usd, line.basis]), [["fal", 1, "call", 0.06, "estimate"]], "/usage: one tools line, an estimate from fal's list price");
  // get_pricing is the server's own read: no tool call on the run.
  assert.equal(rows.some((row) => /get_pricing/.test(JSON.stringify(row))), false, "nothing on the timeline names get_pricing");
});
