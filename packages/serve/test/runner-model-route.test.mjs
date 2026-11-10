// The runner's model route (runner/model-route.ts routeOf): where a model's requests go, on which id, at what price,
// resolved as main resolves a run's model (model.ts chooseModel and runModels). Every route speaks Anthropic's Messages
// API, the shape the kernel's model proxy forwards (the pi adapter's and the grader's path):
// - an Anthropic model goes to Anthropic itself, its key read by name when a request goes;
// - any other model (another provider's, the gateway's, the faux module's under --faux) answers through the route's own
//   fetch, which runs the request on pi-ai's model of it and answers in Messages shape, never the network for the faux;
// - its price is pi-ai's calculateCost on the catalog's cost, tiers included (a request past gpt-6-sol's 272k tier is
//   priced at the tier), and its cost is that catalog entry, for the cap.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";
import { queue, stores, until } from "./runner-support.mjs";

const { routeOf } = await import("../dist/runner/model-route.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
after(closeOpenSessions);

const KEY = `not-a-secret-${"route-key"}`;
const FAUX = fileURLToPath(new URL("./fixtures/faux-route.mjs", import.meta.url));
const eight = (usd) => Math.round(usd * 1e8) / 1e8;
const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

/** The text, stop reason and usage of a Messages SSE answer. */
async function answerOf(response) {
  let text = "";
  let stop;
  let used;
  const tools = [];
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "content_block_start" && event.content_block.type === "tool_use") tools.push({ name: event.content_block.name, json: "" });
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") text += event.delta.text;
    if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") tools.at(-1).json += event.delta.partial_json;
    if (event.type === "message_delta") [stop, used] = [event.delta.stop_reason, event.usage];
  }
  return { text, stop, used, tools: tools.map((tool) => ({ name: tool.name, input: JSON.parse(tool.json || "{}") })) };
}

test("a catalog model's route: its provider's key by name, its catalog cost with tiers, and a request past gpt-6-sol's 272k tier priced at the tier", async () => {
  const route = await routeOf("openai/gpt-6-sol", { OPENAI_API_KEY: KEY });
  assert.equal(route.model, "gpt-6-sol");
  assert.equal(route.provider.api, "anthropic-messages", "every route speaks Messages to the proxy");
  assert.deepEqual(route.cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }] }, "the catalog's cost, tiers included");
  assert.equal(eight(route.price("gpt-6-sol", usage(100_000, 1_000))), eight((100_000 * 2 + 1_000 * 10) / 1e6), "below the tier: the base rates");
  assert.equal(eight(route.price("gpt-6-sol", usage(300_000, 1_000))), eight((300_000 * 4 + 1_000 * 15) / 1e6), "past 272k input tokens: the tier's rates");
  assert.equal(typeof route.fetch, "function", "a provider that does not speak Messages answers through the route's fetch");
});

test("an Anthropic model's route goes to Anthropic itself, its key read by name, with no fetch of its own", async () => {
  const env = { ANTHROPIC_API_KEY: KEY };
  const route = await routeOf("anthropic/claude-sonnet-4-5", env);
  assert.equal(route.model, "claude-sonnet-4-5");
  assert.equal(route.provider.origin, "https://api.anthropic.com");
  assert.equal(route.fetch, undefined, "the network, Anthropic's own API");
  assert.equal(await route.provider.credential(), KEY, "its key, read by name when a request goes");
  assert.ok(route.price("claude-sonnet-4-5", usage(1_000, 100)) > 0, "priced from the catalog");
});

test("under --faux the route answers a Messages request through its fetch from the faux model, and never the network", async () => {
  const route = await routeOf(undefined, { AGENTRUN_SERVE_FAUX: FAUX });
  assert.equal(route.model, "faux-1");
  assert.equal(typeof route.fetch, "function", "the faux model's answers, never a real provider's");
  const response = await route.fetch(`${route.provider.origin}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: route.model, max_tokens: 256, stream: true, messages: [{ role: "user", content: "weekly totals" }] }),
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const answer = await answerOf(response);
  assert.equal(answer.text, "said: weekly totals", "the faux model's reply, in Messages shape");
  assert.equal(answer.stop, "end_turn");
  assert.ok(answer.used.output_tokens > 0 && answer.used.input_tokens > 0, `its usage: ${JSON.stringify(answer.used)}`);
  assert.ok(route.price(route.model, usage(1_000_000, 0)) === 3, "the faux module's price");
  const called = await answerOf(await route.fetch(`${route.provider.origin}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: route.model, max_tokens: 256, stream: true, tools: [{ name: "read", description: "Reads.", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "read it" }] }),
  }));
  assert.deepEqual([called.stop, called.tools], ["tool_use", [{ name: "read", input: { what: "totals" } }]], "a tool call, in Messages shape");
});

test("a request the route's model fails answers an error event whose data is the model's own words, as pi-ai throws it", async () => {
  // pi-ai's Messages client throws an error event's data as the request's error: that data is what the run says, so it
  // is the model's own words ("500 {...}", as main's in-process pi reports them), never an envelope around them.
  const route = await routeOf(undefined, { AGENTRUN_SERVE_FAUX: FAUX });
  const response = await route.fetch(`${route.provider.origin}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: route.model, max_tokens: 256, stream: true, messages: [{ role: "user", content: "fail in your own words" }] }),
  });
  const events = (await response.text()).split("\n\n").filter((block) => block.startsWith("event: error"));
  assert.equal(events.length, 1, "one error event");
  const data = events[0].split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
  assert.equal(data, '500 {"message":"the upstream broke"}', "the error event's data is the model's own words");
});

test("a pi run through the adapter on the faux route goes through the kernel's model proxy and ends with the faux model's answers, its tool call run", async (t) => {
  const route = await routeOf(undefined, { AGENTRUN_SERVE_FAUX: FAUX });
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  let read = 0;
  const tools = [{ name: "read", description: "Reads.", inputSchema: { type: "object", properties: {} }, replay: "safe", call: async () => ((read += 1), { text: "42" }) }];
  const loop = createAdapterLoop(async (_claim, run) => ({
    adapter: piAdapter({ run, model: route.model, provider: route.provider, ...(route.fetch ? { fetch: route.fetch } : {}), ...(route.price ? { price: route.price } : {}) }),
    session: { key: "root", label: "root", system: ["Answer."], tools, context: "fresh" },
    input: "read it",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    hooks: { beforeIntent: async () => {}, beforeResult: async () => {} },
    gate: () => "allow",
  }), { restartLimit: MAX_RESTARTS });
  const runner = startRunner({ store: opened.runners[0], createLoop: loop, name: "runner-a", leaseMs: 30_000, renewEveryMs: 150, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 });
  t.after(() => runner.close());
  const row = await until(async () => {
    const now = await opened.server.runs.get("run-1");
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run's end", 20_000);
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(read, 1, "the faux model's tool call ran once");
  const { entries } = await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  const said = messagesOf({ entries, tasks: [] }).filter((m) => m.role === "model").map((m) => m.text);
  assert.deepEqual(said, ["read: 42"], "the faux model's answer to the tool's result");
});
