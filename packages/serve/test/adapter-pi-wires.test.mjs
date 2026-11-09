// pi on the runner takes every model source main's pi takes (model.ts MODEL_KEYS, and serve's gateway at
// AGENT_MODEL_BASE_URL), each on the wire main's pi speaks for it (provider.ts: Anthropic's Messages, OpenAI's Responses;
// a source pi-ai speaks neither to, OpenRouter's Chat Completions, through the route's own translation). Each opens a
// session through the real loop and the session's model proxy, offers the model the session's tools, and books its
// requests on the run's one ledger. The acceptance case is an openai-responses run through the gateway, end to end, with
// a request past the cap refused before it is sent.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { closeOpenSessions, hostTools } from "./conformance-pi-adapter.mjs";
import { beforeRequestOf, capRun, quiet } from "./adapter-pi-cap-support.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { capModelOf, PI_WIRES } = await import("../dist/runner/adapter-run-spec.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { MODEL_KEYS } = await import("../dist/model.js");
const { WIRES } = await import("../dist/wires.js");
after(closeOpenSessions);

const KEY = `not-a-secret-${"z"}`;

/** Every source main's pi takes a model from, with the wire its route speaks on the runner and where at the gateway its
 *  requests land. `calls`: the gateway answers a tool call on that path (not on Chat Completions). */
const SOURCES = {
  gateway: { model: undefined, env: (url) => ({ AGENT_MODEL_BASE_URL: `${url}/v1`, AGENT_MODEL_API_KEY: KEY, AGENT_MODEL: "team-model", AGENT_MODEL_PRICE: "1,1" }), wire: "openai-responses", path: "/v1/responses", calls: true },
  anthropic: { model: "anthropic/claude-sonnet-4-5", env: (url) => ({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: url }), wire: "anthropic-messages", path: "/v1/messages", calls: true },
  openai: { model: "openai/gpt-5", env: () => ({ OPENAI_API_KEY: KEY }), wire: "openai-responses", path: "/v1/responses", calls: true },
  openrouter: { model: "openrouter/openai/gpt-5", env: () => ({ OPENROUTER_API_KEY: KEY }), wire: "anthropic-messages", path: "/v1/chat/completions", calls: false, translated: true },
};

/** A fetch that sends each request to the gateway at `url`, on its own path: a provider's origin (OpenAI's, OpenRouter's)
 *  stood in for by the loopback gateway. */
const toGateway = (url) => (target, init) => fetch(`${url}${new URL(String(target)).pathname}`, init);
/** The tool names a request body offers, on its path's API. */
const toolsOf = (request) => (request.body?.tools ?? []).map((tool) => tool.name ?? tool.function?.name).sort();
/** What the run booked: each runner.turn record of its sessions, read under a reader's claim. */
async function bookedUsd(store) {
  const row = await store.runs.get("run-1");
  const harness = await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(harness, ctx, store);
    let usd = 0;
    for (const key of await sessions.keys()) for (const record of await sessions.read(key)) if (record.kind === "runner.turn" && typeof record.data?.usd === "number") usd += record.data.usd;
    return usd;
  } finally {
    await harness.close(ctx);
  }
}

/** pi on `route` (its fetch, or `upstream` when the route sends to the network), with the host tool `note`. */
const specOn = (route, upstream, calls = [], tools = { note: { name: "note", replaySafe: true, run: async () => (calls.push("note"), "noted") } }) => (_claim, run) => ({
  adapter: piAdapter({ run, model: route.model, provider: route.provider, ...(route.like ? { like: route.like } : {}), price: route.price, fetch: route.fetch ?? upstream }),
  session: { key: "root", label: "root", system: ["Follow the script."], tools: hostTools(tools), context: "fresh" },
  input: "Follow the script.",
  hooks: quiet,
  gate: () => "allow",
});
/** The gateway's answer: a call of `note` until the request carries its result, then text. */
const callOnce = (request) => (JSON.stringify(request.body ?? {}).includes("noted") ? undefined : { name: "note", input: {} });

test("the table names every source main's pi takes a model from and every wire: a new one cannot be left out", () => {
  assert.deepEqual(Object.keys(SOURCES).sort(), [...MODEL_KEYS.map((row) => row.id), "gateway"].sort());
  assert.deepEqual([...new Set(Object.values(SOURCES).map((source) => source.wire))].sort(), Object.keys(WIRES).sort());
});

test("acceptance: an openai-responses pi run through serve's gateway, end to end on the real loop, completes, books each request on the run's ledger, and a request past the cap is refused before it is sent", async (t) => {
  const gateway = await startFauxGateway({ call: callOnce, usage: { input: 10, output: 2 } });
  t.after(() => gateway.close());
  const route = await routeOf(undefined, SOURCES.gateway.env(gateway.url), "default", PI_WIRES);
  assert.deepEqual([route.provider.api, route.provider.origin, route.model, route.fetch], ["openai-responses", gateway.url, "team-model", undefined], "the gateway's own Responses route");
  const calls = [];
  const { row, asked, store } = await capRun(t, { specOf: () => specOn(route, undefined, calls), beforeRequest: () => undefined });
  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.deepEqual(calls, ["note"], "the model's call ran the host's tool");
  assert.deepEqual(gateway.requests.map((request) => [request.path, request.headers.authorization]), [["/v1/responses", `Bearer ${KEY}`], ["/v1/responses", `Bearer ${KEY}`]], "both requests on the gateway's Responses route, under its key");
  assert.deepEqual(toolsOf(gateway.requests[0]), ["note"], "the session's tool is offered");
  assert.ok(gateway.requests[1].body.input.some((item) => item.type === "function_call_output"), "the tool's answer went back as its call's output");
  // The run's one ledger: 12 tokens at $1 a million each request (AGENT_MODEL_PRICE), the second asked with the first's.
  assert.equal(asked.length, 2);
  assert.ok(Math.abs(asked[1].request.spentUsd - 12e-6) < 1e-12, `the second request is asked with the first's cost: ${asked[1].request.spentUsd}`);
  assert.ok(Math.abs((await bookedUsd(store)) - 24e-6) < 1e-12, "both booked on the run's sessions");

  const before = gateway.requests.length;
  const refused = await capRun(t, { specOf: () => specOn(route), beforeRequest: beforeRequestOf({ capUsd: () => 1e-9, modelOf: () => capModelOf(route) }) });
  assert.match(refused.asked[0]?.answer?.refuse ?? "", /^spend_cap_reached \(out of budget\): Not sent: /, JSON.stringify(refused.asked[0]?.answer));
  assert.equal(gateway.requests.length, before, "not sent: past the cap");
});

test("every source main's pi takes opens on the runner on its wire, offers the session's tools, and books on the run's ledger", async (t) => {
  for (const [name, source] of Object.entries(SOURCES)) {
    await t.test(name, async (t) => {
      const gateway = await startFauxGateway({ ...(source.calls ? { call: callOnce } : {}), usage: { input: 10, output: 2 } });
      t.after(() => gateway.close());
      const route = await routeOf(source.model, source.env(gateway.url), "default", PI_WIRES, toGateway(gateway.url));
      assert.equal(route.provider.api, source.wire, "its wire");
      assert.equal(typeof route.fetch === "function", Boolean(source.translated), "translated only where pi-ai speaks neither wire");
      const { row, store } = await capRun(t, { specOf: () => specOn(route, toGateway(gateway.url)), beforeRequest: () => undefined });
      assert.equal(row.state, "ended", JSON.stringify(row));
      assert.ok(gateway.requests.length >= 1 && gateway.requests.every((request) => request.path.endsWith(source.path)), JSON.stringify(gateway.requests.map((request) => request.path)));
      assert.deepEqual(toolsOf(gateway.requests[0]), ["note"], "the session's tool is offered");
      assert.ok((await bookedUsd(store)) > 0, "booked on the run's ledger");
    });
  }
});

/** A 1x1 PNG, as a screenshot tool would answer. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** On each wire, a source that speaks it to the gateway, and whether a request carries the tool's image as that API
 *  carries an image: Messages' image block of the tool result, Responses' input_image as a data URL. */
const IMAGE_WIRES = {
  "anthropic-messages": { source: SOURCES.anthropic, carries: (body) => (body.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "tool_result" && Array.isArray(part.content) && part.content.some((block) => block.type === "image" && block.source?.data === PIXEL))) },
  "openai-responses": { source: SOURCES.gateway, carries: (body) => JSON.stringify(body.input ?? []).includes(`"input_image"`) && JSON.stringify(body.input ?? []).includes(PIXEL) },
};

test("a host tool's image reaches the model on either wire, as that wire carries an image", async (t) => {
  assert.deepEqual(Object.keys(IMAGE_WIRES).sort(), Object.keys(WIRES).sort(), "every wire");
  for (const [wire, { source, carries }] of Object.entries(IMAGE_WIRES)) {
    await t.test(wire, async (t) => {
      const gateway = await startFauxGateway({ call: (request) => (JSON.stringify(request.body ?? {}).includes("the page as it looks") ? undefined : { name: "shot", input: {} }) });
      t.after(() => gateway.close());
      const route = await routeOf(source.model, source.env(gateway.url), "default", PI_WIRES, toGateway(gateway.url));
      assert.equal(route.provider.api, wire);
      const shot = { shot: { name: "shot", replaySafe: true, run: async () => "the page as it looks", images: [{ mimeType: "image/png", data: PIXEL }] } };
      const { row } = await capRun(t, { specOf: () => specOn(route, toGateway(gateway.url), [], shot), beforeRequest: () => undefined });
      assert.equal(row.state, "ended", JSON.stringify(row));
      assert.ok(gateway.requests.some((request) => carries(request.body)), `a request carries the tool's image: ${JSON.stringify(gateway.requests.map((request) => request.body?.input ?? request.body?.messages)).slice(0, 2000)}`);
    });
  }
});
