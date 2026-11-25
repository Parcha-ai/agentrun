// Capabilities' `available` on pi says whether a run started now would have a model (beta.54 autoqa P3-9): a key, the
// model gateway with its model, the ChatGPT plan, the faux model, or a model of the Ollama here that calls tools. A model
// that takes no tools is pickable but gives pi no run; nothing at all reads unavailable, in words that name Ollama and a
// key. An Ollama that comes up, or a key saved, after the start turns it available with no restart. The Ollama is a fake
// on loopback (fixtures/fake-ollama.mjs); no test asks this box's Ollama.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeOllama, SYNTH_MODELS } from "./fixtures/fake-ollama.mjs";
import { freePort } from "./fixtures/ports.mjs";
import { agent, serve, withEnv } from "./support.mjs";

const { ollamaAsking, ollamaClock } = await import("../dist/ollama-provider.js");

// The suites turn every Ollama off (support.mjs); this file asks its own fakes alone.
delete process.env.AGENTRUN_SERVE_FAUX_NO_OLLAMA;

/** Every model key and setting a model could come from: none set. */
const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PARTICLE_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "AGENTRUN_FREE_MODEL_REQUESTS", "OLLAMA_HOST"];
const TOOLS = SYNTH_MODELS.find((model) => model.capabilities.includes("tools"));
const NO_TOOLS = SYNTH_MODELS.filter((model) => !model.capabilities.includes("tools"));
/** The words pi reads with no model: Ollama first, then a key (model.ts). */
const NAMES_OLLAMA = /^No model yet: start Ollama and pull a model with tools, or add a model key in Settings → Model keys/;
/** The words where this server asks no Ollama: a key alone. */
const NAMES_KEY = /^No model yet: add a model key in Settings → Model keys/;

const caps = async (api) => (await api("GET", "/capabilities")).body;
const piOf = (body) => body.harnesses.find((harness) => harness.id === "pi");

test("no key and no Ollama: pi is not available, in words that name Ollama and a key; a save on it warns, never refuses", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  withEnv(t, { OLLAMA_HOST: `127.0.0.1:${await freePort()}` });
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

test("an Ollama started after the server, with a tools model: pi turns available with no wait for a TTL (the down answer is never kept fresh) and no restart", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  // Held still: nothing here waits for the kept listing to age.
  ollamaClock(() => 1_000_000);
  t.after(() => ollamaClock());
  const port = await freePort();
  const env = { OLLAMA_HOST: `127.0.0.1:${port}` };
  withEnv(t, env);
  const { api } = await serve(t, { faux: undefined });
  assert.equal(piOf(await caps(api)).available, false, "Ollama down: no model");
  await ollamaAsking(env);
  await fakeOllama(t, { port, models: [TOOLS] });
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
  withEnv(t, { OLLAMA_HOST: `127.0.0.1:${await freePort()}`, ANTHROPIC_BASE_URL: anthropic.base });
  const { api } = await serve(t, { faux: undefined });
  assert.equal(piOf(await caps(api)).available, false);
  const put = await api("PUT", "/settings/tool-keys/anthropic", { values: { ANTHROPIC_API_KEY: `not-a-secret-${"pi-available"}` } });
  assert.equal(put.status, 204, JSON.stringify(put.body));
  // Includes, not equals: a stray probe of this box once hit the fake's ephemeral port with GET / (nothing in serve asks it).
  assert.ok(anthropic.asked.includes("GET /v1/models"), `the save's check went to the fake: ${JSON.stringify(anthropic.asked)}`);
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

test("the Ollama words go only where a model of the Ollama here would give the harness its model: pi and every harness on a wire the route translates (claude-agent on Messages; codex and opencode on Responses), on a server that asks one", async () => {
  const { chooseModel, ollamaWouldRun } = await import("../dist/model.js");
  // The env a server hands its own reads and its runner's: OLLAMA_HOST set where it asks one (server.ts, ollamaHostOf).
  // A closed port: this file clears the suites' Ollama switch, and no test asks this box's Ollama.
  const asks = { OLLAMA_HOST: `127.0.0.1:${await freePort()}` };
  assert.equal(ollamaWouldRun(asks, "pi"), true);
  assert.equal(ollamaWouldRun({}, "pi"), false, "no OLLAMA_HOST: a shared server asks no Ollama");
  assert.equal(ollamaWouldRun({ OLLAMA_HOST: "10.0.0.5:11434" }, "pi"), false, "a refused OLLAMA_HOST is never asked");
  // The wire decides (wires.ts TRANSLATED): the route translates an Ollama model onto Anthropic's Messages, claude-agent's, and onto OpenAI's Responses, codex's and opencode's.
  assert.equal(ollamaWouldRun(asks, "claude-agent"), true, "claude-agent, on Messages, runs an Ollama model through the route");
  for (const harness of ["codex", "opencode"]) assert.equal(ollamaWouldRun(asks, harness), true, `${harness}, on OpenAI's Responses, runs an Ollama model through the route`);
  assert.equal(ollamaWouldRun({ ...asks, AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1" }, "pi"), false, "the model gateway takes every model");
  assert.equal(ollamaWouldRun({ ...asks, AGENTRUN_SERVE_FAUX: "/x" }, "pi"), false, "the faux model");
  assert.match((await chooseModel(asks, undefined, "default", "pi")).why, NAMES_OLLAMA);
  assert.match((await chooseModel({}, undefined, "default", "pi")).why, NAMES_KEY);
  assert.match((await chooseModel(asks, undefined, "default", "claude-agent")).why, NAMES_OLLAMA);
  assert.match((await chooseModel(asks, undefined, "default", "codex")).why, NAMES_OLLAMA);
});

// The Ollama step is offered only where this server asks an Ollama (Greptile P2 on #3492): OLLAMA_HOST, else the default
// address on one owner's own machine (ollama-provider.ts ollamaHostOf). A shared server with no OLLAMA_HOST never asks
// the default, so starting Ollama there leaves the run blocked: its words name a key alone.
/** What makes a test's server one owner's own (server.ts whyNotOwnMachine) unset, and every model key with them. */
const OWNER = [...KEYS, "AGENTRUN_RUN_USER", "AGENTRUN_STORE_URL"];

test("a shared server with no OLLAMA_HOST never asks an Ollama: its words name a key, never 'start Ollama'", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, OWNER);
  const { api, ollamaHost } = await serve(t, { faux: undefined, runner: false, runnerApart: true });
  assert.equal(ollamaHost, undefined);
  const pi = piOf(await caps(api));
  assert.equal(pi.available, false, JSON.stringify(pi));
  assert.match(pi.reason, NAMES_KEY);
  assert.doesNotMatch(pi.reason, /Ollama/);
});

test("a shared server whose operator sets OLLAMA_HOST asks that Ollama: its words offer starting it", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, OWNER);
  withEnv(t, { OLLAMA_HOST: `127.0.0.1:${await freePort()}` });
  const { api } = await serve(t, { faux: undefined, runner: false, runnerApart: true });
  const pi = piOf(await caps(api));
  assert.equal(pi.available, false, JSON.stringify(pi));
  assert.match(pi.reason, NAMES_OLLAMA);
});

test("one owner's own server with no OLLAMA_HOST asks the default address: its words offer starting Ollama", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, OWNER);
  // The address stays the default; the test switch keeps this box's own Ollama unasked (ollama-provider.ts OLLAMA_OFF_ENV).
  withEnv(t, { AGENTRUN_SERVE_FAUX_NO_OLLAMA: "1" });
  const { api, ollamaHost } = await serve(t, { faux: undefined, runner: false });
  assert.equal(ollamaHost, "127.0.0.1:11434");
  const pi = piOf(await caps(api));
  assert.equal(pi.available, false, JSON.stringify(pi));
  assert.match(pi.reason, NAMES_OLLAMA);
});
