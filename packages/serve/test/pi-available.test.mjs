// Capabilities' `available` on pi says whether a run started now would have a model (beta.54 autoqa P3-9): a key, the
// model gateway with its model, the ChatGPT plan, the faux model, or a model of the Ollama here that calls tools. A model
// that takes no tools is pickable but gives pi no run; nothing at all reads unavailable, in words that name Ollama and a
// key. An Ollama that comes up, or a key saved, after the start turns it available with no restart. The Ollama is a fake
// on loopback (fixtures/fake-ollama.mjs); no test asks this box's Ollama.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closedPort, fakeOllama, SYNTH_MODELS } from "./fixtures/fake-ollama.mjs";
import { agent, serve, withEnv } from "./support.mjs";

const { ollamaAsking, ollamaClock, OLLAMA_TTL_MS } = await import("../dist/ollama-provider.js");

// The suites turn every Ollama off (support.mjs); this file asks its own fakes alone.
delete process.env.AGENTRUN_SERVE_FAUX_NO_OLLAMA;

/** Every model key and setting a model could come from: none set. */
const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PARTICLE_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "AGENTRUN_FREE_MODEL_REQUESTS", "OLLAMA_HOST"];
const TOOLS = SYNTH_MODELS.find((model) => model.capabilities.includes("tools"));
const NO_TOOLS = SYNTH_MODELS.filter((model) => !model.capabilities.includes("tools"));
/** The words pi reads with no model: Ollama first, then a key (model.ts). */
const NAMES_OLLAMA = /^No model yet: start Ollama and pull a model with tools, or add a model key in Settings → Model keys/;

const caps = async (api) => (await api("GET", "/capabilities")).body;
const piOf = (body) => body.harnesses.find((harness) => harness.id === "pi");

test("no key and no Ollama: pi is not available, in words that name Ollama and a key; a save on it warns, never refuses", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  withEnv(t, { OLLAMA_HOST: `127.0.0.1:${await closedPort()}` });
  const { api } = await serve(t, { faux: undefined });
  const body = await caps(api);
  const pi = piOf(body);
  assert.equal(pi.available, false, JSON.stringify(pi.reason));
  assert.match(pi.reason, NAMES_OLLAMA);
  assert.equal(body.models.ready, false);
  const saved = await api("POST", "/agents", agent("plain"));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings.map((w) => [w.field, w.reason]), [["definition.model", "not_set_up_here"]]);
  assert.match(saved.body.warnings[0].message, NAMES_OLLAMA);
});

test("an Ollama whose models take no tools gives pi no run: not available, in the same words, its chat model still pickable", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  const ollama = await fakeOllama(t, { models: NO_TOOLS });
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api } = await serve(t, { faux: undefined });
  const body = await caps(api);
  const pi = piOf(body);
  assert.equal(pi.available, false, JSON.stringify(pi));
  assert.match(pi.reason, NAMES_OLLAMA);
  assert.equal(pi.default_model, null);
  assert.equal(body.models.ready, false);
  assert.ok(pi.models.includes("ollama/synth-plain:1b"), String(pi.models));
});

test("an Ollama with a tools model: pi is available, that model its default", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  const ollama = await fakeOllama(t);
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api } = await serve(t, { faux: undefined });
  const body = await caps(api);
  const pi = piOf(body);
  assert.equal(pi.available, true, JSON.stringify(pi));
  assert.equal(pi.default_model, `ollama/${TOOLS.name}`);
  assert.equal(pi.reason, undefined);
  assert.equal(body.models.ready, true);
});

test("an Ollama started after the server, with a tools model: pi turns available once the kept listing goes stale, with no restart", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  let clock = 1_000_000;
  ollamaClock(() => clock);
  t.after(() => ollamaClock());
  const port = await closedPort();
  const env = { OLLAMA_HOST: `127.0.0.1:${port}` };
  withEnv(t, env);
  const { api } = await serve(t, { faux: undefined });
  assert.equal(piOf(await caps(api)).available, false, "Ollama down: no model");
  await fakeOllama(t, { port, models: [TOOLS] });
  clock += OLLAMA_TTL_MS;
  await api("GET", "/capabilities");
  await ollamaAsking(env);
  const pi = piOf(await caps(api));
  assert.equal(pi.available, true, JSON.stringify(pi));
  assert.equal(pi.default_model, `ollama/${TOOLS.name}`);
});

/** Anthropic as a key's save checks it (key-check.ts: GET /v1/models at ANTHROPIC_BASE_URL), on loopback: it takes any
 *  key and answers only that path, so the save never reaches the network. */
async function fakeAnthropic(t) {
  const { createServer } = await import("node:http");
  const asked = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://fake").pathname;
    asked.push(`${req.method} ${path}`);
    if (req.method === "GET" && path === "/v1/models") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [], has_more: false }));
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, asked };
}

test("a model key saved after the start turns pi available with no restart", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  const anthropic = await fakeAnthropic(t);
  withEnv(t, { OLLAMA_HOST: `127.0.0.1:${await closedPort()}`, ANTHROPIC_BASE_URL: anthropic.base });
  const { api } = await serve(t, { faux: undefined });
  assert.equal(piOf(await caps(api)).available, false);
  const put = await api("PUT", "/settings/tool-keys/anthropic", { values: { ANTHROPIC_API_KEY: `not-a-secret-${"pi-available"}` } });
  assert.equal(put.status, 204, JSON.stringify(put.body));
  assert.deepEqual(anthropic.asked, ["GET /v1/models"], "the save's check went to the fake alone");
  const pi = piOf(await caps(api));
  assert.equal(pi.available, true, JSON.stringify(pi));
  assert.match(pi.default_model, /^anthropic\//);
});

test("the faux model, and the model gateway with its model: pi is available; a gateway with none is not, in words that name no Ollama", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  const faux = await serve(t, {});
  assert.equal(piOf(await caps(faux.api)).available, true, "faux");
  withEnv(t, { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL: "synth-gateway", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}` });
  const gateway = await serve(t, { faux: undefined });
  assert.equal(piOf(await caps(gateway.api)).available, true, "gateway with its model");
  withEnv(t, { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}` }, ["AGENT_MODEL"]);
  const unnamed = await serve(t, { faux: undefined });
  const pi = piOf(await caps(unnamed.api));
  assert.equal(pi.available, false, "a gateway with no model named");
  assert.doesNotMatch(pi.reason ?? "", /Ollama/);
});

test("the Ollama words go only where a model of the Ollama here would give the harness its model: pi, on a server that asks one", async () => {
  const { chooseModel, ollamaWouldRun } = await import("../dist/model.js");
  assert.equal(ollamaWouldRun({}, "pi"), true);
  assert.equal(ollamaWouldRun({}, "claude-agent"), false, "claude-agent runs Anthropic's models alone");
  assert.equal(ollamaWouldRun({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1" }, "pi"), false, "the model gateway takes every model");
  assert.equal(ollamaWouldRun({ AGENTRUN_SERVE_FAUX: "/x" }, "pi"), false, "the faux model");
  assert.match((await chooseModel({}, undefined, "default", "pi")).why, NAMES_OLLAMA);
  assert.doesNotMatch((await chooseModel({}, undefined, "default", "claude-agent")).why, /Ollama/);
});
