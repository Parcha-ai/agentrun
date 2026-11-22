// A fal job's price shows on the run as any paid tool's does: a "Tool cost" row on its timeline, `cost.tools_usd` on its
// read and a `tools` line on /usage, inside the run's `usd`. The real server and runner, a faux model at a fixed price a
// request, and a fake MCP server saved with the toolkit `fal` that answers fal's get_pricing and run_model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_USD } from "./fixtures/faux-tools-cost.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, serve } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-tools-cost.mjs", import.meta.url).pathname;
const AT_ONCE = new URL("./fixtures/faux-at-once.mjs", import.meta.url).pathname;
const RUN_MODEL = "mcp:fal/run_model";
const micro = (usd) => (usd === null || usd === undefined ? usd : Math.round(usd * 1e6));

test("a run's fal job: a Tool cost row, tools_usd and a /usage tools line at fal's price for it, inside usd", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX });
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  // fal's price for ideogram/v3 (get_pricing, read 2026-11-20): $0.03 an image.
  fake.tools.get_pricing = { description: "fal's price for an endpoint.", input: { type: "object", properties: { endpoint_id: { type: "string" } }, required: ["endpoint_id"], additionalProperties: false }, run: ({ endpoint_id }) => ({ content: [{ type: "text", text: JSON.stringify({ prices: [{ endpoint_id, unit_price: 0.03, unit: "images", currency: "USD" }], next_cursor: null, has_more: false }) }] }) };
  // The keys the fake received: a server marked fal off fal's host (an eval's fake) receives the agent's own.
  const keys = [];
  fake.tools.run_model = { description: "Run a fal model.", input: { type: "object", properties: {} }, run: (args) => (keys.push(args.submission_key), { content: [{ type: "text", text: JSON.stringify({ status: "completed", submission_replayed: false, endpoint_id: args.endpoint_id, request_id: "r1", result: { images: [{ url: "https://v3.fal.media/1.png" }, { url: "https://v3.fal.media/2.png" }] }, has_result: true }) }] }) };
  const saved = await api("PUT", "/settings/mcp-servers/fal", { url: fake.url, auth: { type: "none" }, toolkit: "fal" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const made = await api("POST", "/agents", agent("card", { tools: [RUN_MODEL], tool_settings: { [RUN_MODEL]: { permission: "allow" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // The run has a cap, so the job is held under it before it is sent.
  const run = await api("POST", "/agents/card/runs", { input: { content: 'Call mcp__fal__run_model with {"endpoint_id":"fal-ai/ideogram/v3","input":{"prompt":"a share card","num_images":2},"submission_key":"card-20261120-1"}' }, max_cost_usd: 1 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "run_model").length, 1, "the job was sent once");
  assert.deepEqual(keys, ["card-20261120-1"], "a fal server off fal's host receives the agent's own submission_key");

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

/** A run whose one script sends a flux/schnell job asked at 1000x1000 (1 megapixel at $0.50, its hold) that states a
 *  1008x1008 image (2 megapixels, $1), then a call that costs nothing, under a cap of `cap`. `childRuns`: the run in a
 *  process of its own, its MCP the runner's (run-child-host.ts heldFor), as the CLI's start runs it. */
async function overHold(t, cap, { childRuns } = {}) {
  const { api } = await serve(t, { faux: FAUX, ...(childRuns ? { childRuns } : {}) });
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  fake.tools.get_pricing = { description: "fal's price for an endpoint.", input: { type: "object", properties: { endpoint_id: { type: "string" } }, required: ["endpoint_id"], additionalProperties: false }, run: ({ endpoint_id }) => ({ content: [{ type: "text", text: JSON.stringify({ prices: [{ endpoint_id, unit_price: 0.5, unit: "megapixels", currency: "USD" }], next_cursor: null, has_more: false }) }] }) };
  fake.tools.run_model = { description: "Run a fal model.", input: { type: "object", properties: {} }, run: (args) => ({ content: [{ type: "text", text: JSON.stringify({ status: "completed", submission_replayed: false, endpoint_id: args.endpoint_id, request_id: "r1", result: { images: [{ url: "https://v3.fal.media/1.png", width: 1008, height: 1008 }] }, has_result: true }) }] }) };
  fake.tools.get_model_schema = { description: "A fal model's schema.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: "{}" }] }) };
  assert.equal((await api("PUT", "/settings/mcp-servers/fal", { url: fake.url, auth: { type: "none" }, toolkit: "fal" })).status, 200);
  const SCHEMA = "mcp:fal/get_model_schema";
  const made = await api("POST", "/agents", agent("over", { tools: [RUN_MODEL, SCHEMA], tool_settings: { [RUN_MODEL]: { permission: "allow" }, [SCHEMA]: { permission: "allow" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // One script: the job, then a call that costs nothing. A run stopped at once runs nothing after the job.
  const script = "await tools.mcp__fal__run_model({ endpoint_id: 'fal-ai/flux/schnell', input: { prompt: 'a lighthouse', image_size: { width: 1000, height: 1000 }, num_images: 1 } }); await tools.mcp__fal__get_model_schema({ endpoint_id: 'fal-ai/flux/schnell' }); return 'both ran';";
  const run = await api("POST", "/agents/over/runs", { input: { content: `Call codemode with ${JSON.stringify({ script })}` }, max_cost_usd: cap });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  const called = (tool) => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === tool).length;
  return { rows, view, called };
}

test("a fal job whose output states more than its input asked is booked at what it states; past the run's cap, the run stops at once in the cap's words", { timeout: 120_000 }, async (t) => {
  const { rows, view, called } = await overHold(t, 1);
  assert.equal(called("run_model"), 1, "the job was sent once");
  assert.equal(called("get_model_schema"), 0, "nothing ran after the job that passed the cap");
  const costs = rows.filter((row) => row.kind === "phase" && /^Tool cost:/.test(row.summary ?? ""));
  assert.deepEqual(costs.map((row) => row.usage?.usd), [1], "booked at the 2 megapixels its output states, never the 1 it was held at");
  assert.equal(view.cost.tools_usd, 1);
  assert.deepEqual([view.status, view.error?.code, view.error?.message], ["failed", "spend_cap_reached", "The run cost $1, $0.01 over its cap of $1."], "ended in the cap's words");
});

test("in a run's own process, a fal job its runner sends and settles past the run's cap stops the run at once too", { timeout: 120_000 }, async (t) => {
  const { view, called } = await overHold(t, 1, { childRuns: {} });
  assert.equal(called("run_model"), 1, "the job was sent once");
  assert.equal(called("get_model_schema"), 0, "nothing ran after the job that passed the cap");
  assert.equal(view.cost.tools_usd, 1);
  assert.deepEqual([view.status, view.error?.code, view.error?.message], ["failed", "spend_cap_reached", "The run cost $1, $0.01 over its cap of $1."], "ended in the cap's words");
});

test("a fal job booked above its hold that leaves the run within its cap stops nothing", { timeout: 120_000 }, async (t) => {
  const { view, called } = await overHold(t, 5);
  assert.equal(called("get_model_schema"), 1, "the script's next call ran");
  assert.equal(view.cost.tools_usd, 1, "booked at the 2 megapixels its output states");
  assert.equal(view.status, "completed", JSON.stringify(view.error));
});

/** A run whose model sends two ideogram jobs at once (two calls in one message) under a $1 cap, each asking 4 images at
 *  $0.10 (each held at $0.40): the first states 7 images ($0.70) while the second is still running; the second states
 *  `secondImages`. Then, in its next turn, a call that costs nothing. The order is the fake's, never the machine's: the
 *  first answers only once the second has been sent (so both were admitted at their holds), and the second only once the
 *  first's charge is on the run's timeline. */
async function twoAtOnce(t, secondImages) {
  const { api } = await serve(t, { faux: AT_ONCE });
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  let secondArrived;
  const secondSent = new Promise((done) => { secondArrived = done; });
  let runId;
  const firstBooked = async () => {
    for (;;) {
      const page = runId ? (await api("GET", `/runs/${runId}/timeline`)).body : undefined;
      if (page?.rows?.some((row) => row.kind === "phase" && /^Tool cost:/.test(row.summary ?? ""))) return;
      await new Promise((done) => setTimeout(done, 100));
    }
  };
  const images = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://v3.fal.media/${i}.png`, width: 1024, height: 1024 }));
  const reply = (args, n) => ({ content: [{ type: "text", text: JSON.stringify({ status: "completed", submission_replayed: false, endpoint_id: args.endpoint_id, request_id: `r-${args.input?.prompt}`, result: { images: images(n) }, has_result: true }) }] });
  fake.tools.get_pricing = { description: "fal's price for an endpoint.", input: { type: "object", properties: { endpoint_id: { type: "string" } }, required: ["endpoint_id"], additionalProperties: false }, run: ({ endpoint_id }) => ({ content: [{ type: "text", text: JSON.stringify({ prices: [{ endpoint_id, unit_price: 0.1, unit: "images", currency: "USD" }], next_cursor: null, has_more: false }) }] }) };
  fake.tools.run_model = {
    description: "Run a fal model.",
    input: { type: "object", properties: {} },
    run: async (args) => {
      if (args.input?.prompt === "first") return (await secondSent, reply(args, 7));
      secondArrived();
      await firstBooked();
      return reply(args, secondImages);
    },
  };
  fake.tools.get_model_schema = { description: "A fal model's schema.", input: { type: "object", properties: {} }, run: () => ({ content: [{ type: "text", text: "{}" }] }) };
  assert.equal((await api("PUT", "/settings/mcp-servers/fal", { url: fake.url, auth: { type: "none" }, toolkit: "fal" })).status, 200);
  const SCHEMA = "mcp:fal/get_model_schema";
  const made = await api("POST", "/agents", agent("two", { tools: [RUN_MODEL, SCHEMA], tool_settings: { [RUN_MODEL]: { permission: "allow" }, [SCHEMA]: { permission: "allow" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const job = (prompt) => ["mcp__fal__run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt, num_images: 4 } }];
  const content = `At once: ${JSON.stringify([job("first"), job("second")])}\nAt once: ${JSON.stringify([["mcp__fal__get_model_schema", { endpoint_id: "fal-ai/ideogram/v3" }]])}`;
  const run = await api("POST", "/agents/two/runs", { input: { content }, max_cost_usd: 1 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  runId = run.body.run_id;
  const { rows } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  const called = (tool) => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === tool).length;
  const costs = rows.filter((row) => row.kind === "phase" && /^Tool cost:/.test(row.summary ?? "")).map((row) => micro(row.usage?.usd));
  return { view, called, costs };
}

test("a fal job that settles above its hold while another is still held stops nothing when what both charge stays within the cap", { timeout: 120_000 }, async (t) => {
  const { view, called, costs } = await twoAtOnce(t, 1);
  assert.equal(called("run_model"), 2, "both jobs were sent");
  assert.deepEqual(costs, [micro(0.7), micro(0.1)], "the first settled above its hold before the second settled below its");
  assert.equal(micro(view.cost.tools_usd), micro(0.8));
  assert.equal(called("get_model_schema"), 1, "the next turn's call ran");
  assert.equal(view.status, "completed", JSON.stringify(view.error));
});

test("a fal job that settles above its hold while another is still held: when the other's charge then takes the run past its cap, the run stops at once", { timeout: 120_000 }, async (t) => {
  const { view, called, costs } = await twoAtOnce(t, 4);
  assert.deepEqual(costs, [micro(0.7), micro(0.4)]);
  assert.equal(micro(view.cost.tools_usd), micro(1.1));
  assert.equal(called("get_model_schema"), 0, "nothing ran after the charge that passed the cap");
  assert.deepEqual([view.status, view.error?.code], ["failed", "spend_cap_reached"]);
  assert.match(view.error?.message ?? "", /over its cap of \$1\.$/);
});

/** Three calls at once under a $1 cap, in one message. ideogram's job, held at $0.40 (4 images at $0.10), states 12 images
 *  ($1.20) and stops the run for good. flux's job passed the tool gate beside it, and the fake answers its price only once
 *  ideogram's result is on the timeline (the gateway answers only after its settle, so after the stop): flux's job is
 *  admitted after the stop, and the cap refuses it for room. A script's first call, `wait`, passed the gate before the stop
 *  (ideogram answers only once it has arrived); the fake answers it only once flux's refusal is on the timeline. The
 *  script's next call, `last`, comes after both. The order is the fake's and the timeline's, never a timer's. */
async function admittedAfterStop(t) {
  const { api } = await serve(t, { faux: AT_ONCE });
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  let runId;
  // The timeline's own long poll (wait_ms) from its cursor, as `follow` reads it, bounded: each page's rows (new or changed
  // since the last) are checked until a row `matches`, or a failure names `what` that never came.
  const onTimeline = async (matches, what) => {
    const deadline = Date.now() + 30_000;
    let after = 0;
    while (Date.now() < deadline) {
      if (!runId) { await new Promise((done) => setImmediate(done)); continue; }
      const page = (await api("GET", `/runs/${runId}/timeline?after=${after}&wait_ms=2000`)).body;
      if (page?.rows?.some(matches)) return;
      after = page?.next_after ?? after;
    }
    throw new Error(`not within 30 s: ${what}`);
  };
  const schemaCalls = [];
  let waitArrived;
  const waitSent = new Promise((done) => { waitArrived = done; });
  const reply = (args, n) => ({ content: [{ type: "text", text: JSON.stringify({ status: "completed", submission_replayed: false, endpoint_id: args.endpoint_id, request_id: `r-${args.endpoint_id}`, result: { images: Array.from({ length: n }, (_, i) => ({ url: `https://v3.fal.media/${i}.png`, width: 1000, height: 1000 })) }, has_result: true }) }] });
  const price = (endpoint_id, unit_price, unit) => ({ content: [{ type: "text", text: JSON.stringify({ prices: [{ endpoint_id, unit_price, unit, currency: "USD" }], next_cursor: null, has_more: false }) }] });
  fake.tools.get_pricing = {
    description: "fal's price for an endpoint.",
    input: { type: "object", properties: { endpoint_id: { type: "string" } }, required: ["endpoint_id"], additionalProperties: false },
    run: async ({ endpoint_id }) => {
      if (endpoint_id === "fal-ai/ideogram/v3") return price(endpoint_id, 0.1, "images");
      await onTimeline((row) => row.kind === "tool_result" && /run_model: ok/.test(row.summary ?? ""), "ideogram's result on the run's timeline");
      return price(endpoint_id, 0.5, "megapixels");
    },
  };
  fake.tools.run_model = {
    description: "Run a fal model.",
    input: { type: "object", properties: {} },
    run: async (args) => {
      if (args.endpoint_id === "fal-ai/ideogram/v3") return (await waitSent, reply(args, 12));
      return reply(args, 1);
    },
  };
  fake.tools.get_model_schema = {
    description: "A fal model's schema.",
    input: { type: "object", properties: {} },
    run: async (args) => {
      schemaCalls.push(args.endpoint_id);
      if (args.endpoint_id === "wait") {
        waitArrived();
        await onTimeline((row) => row.kind === "tool_result" && /run_model failed/.test(row.summary ?? ""), "flux's refusal on the run's timeline");
      }
      return { content: [{ type: "text", text: "{}" }] };
    },
  };
  assert.equal((await api("PUT", "/settings/mcp-servers/fal", { url: fake.url, auth: { type: "none" }, toolkit: "fal" })).status, 200);
  const SCHEMA = "mcp:fal/get_model_schema";
  const made = await api("POST", "/agents", agent("sticky", { tools: [RUN_MODEL, SCHEMA], tool_settings: { [RUN_MODEL]: { permission: "allow" }, [SCHEMA]: { permission: "allow" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const script = "await tools.mcp__fal__get_model_schema({ endpoint_id: 'wait' }); await tools.mcp__fal__get_model_schema({ endpoint_id: 'last' }).catch(() => 'refused'); return 'end';";
  const calls = [
    ["mcp__fal__run_model", { endpoint_id: "fal-ai/ideogram/v3", input: { prompt: "a lighthouse", num_images: 4 } }],
    ["mcp__fal__run_model", { endpoint_id: "fal-ai/flux/schnell", input: { prompt: "a harbour", image_size: { width: 1000, height: 1000 }, num_images: 1 } }],
    ["codemode", { script }],
  ];
  const run = await api("POST", "/agents/sticky/runs", { input: { content: `At once: ${JSON.stringify(calls)}` }, max_cost_usd: 1 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  runId = run.body.run_id;
  await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  const sent = (tool) => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === tool).length;
  return { view, sent, schemaCalls };
}

test("a stop for good stays: a paid call admitted after it and refused for room never lets a later call of a script run", { timeout: 120_000 }, async (t) => {
  const { view, sent, schemaCalls } = await admittedAfterStop(t);
  assert.equal(sent("get_pricing"), 2, "flux's job read its price after the stop, so it passed the gate before it");
  assert.equal(sent("run_model"), 1, "only the job that passed the cap was sent; flux's was refused at its admission");
  assert.deepEqual(schemaCalls, ["wait"], "the script's call after the stop was never sent");
  assert.equal(micro(view.cost.tools_usd), micro(1.2));
  assert.deepEqual([view.status, view.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(view.error));
  assert.match(view.error?.message ?? "", /over its cap of \$1\.$/, "ended in the stop's words");
});
