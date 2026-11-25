// A key's save on a server whose Ollama hangs (#3492 review, batch 46 row 1). Each save makes the offers and the model
// needs again; past the kept listing's TTL they asked /api/show once per Ollama model, in series, 10 s each, and the
// save's 204 waited on all of it. The offers are made from the kept listing, so they now read each model from it at any
// age (ollama-provider.ts ollamaReading) and ask a stuck Ollama nothing. A run's own choice still asks /api/show past
// the TTL. The Ollama is a fake on loopback (fixtures/fake-ollama.mjs); no test asks this box's Ollama.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fakeOllama } from "./fixtures/fake-ollama.mjs";
import { serve, withEnv } from "./support.mjs";

const { ollamaClock, ollamaModels, ollamaReading, ollamaShown, OLLAMA_TTL_MS } = await import("../dist/ollama-provider.js");

// The suites turn every Ollama off (support.mjs); this file asks its own fakes alone.
delete process.env.AGENTRUN_SERVE_FAUX_NO_OLLAMA;

/** Every model key and setting a model could come from, and the tool key a test removes: none set. */
const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PARTICLE_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "AGENTRUN_FREE_MODEL_REQUESTS", "OLLAMA_HOST", "OLLAMA_CONTEXT_LENGTH", "PARALLEL_API_KEY"];
/** N synthetic models that chat and call tools. */
const MODELS = Array.from({ length: 4 }, (_, i) => ({ name: `synth-n${i}:1b`, capabilities: ["completion", "tools"], family: `synthn${i}`, context_length: 32_768 }));
const IDS = MODELS.map((model) => `ollama/${model.name}`);

/** A fake Ollama that answers until `hang()`, then takes every request and never answers. `showAsked` settles with the
 *  model of the first /api/show it takes once hung: the gate a test races a save against, with no clock. */
async function hangingOllama(t) {
  let hung = false;
  let asked;
  const showAsked = new Promise((resolve) => (asked = resolve));
  const ollama = await fakeOllama(t, {
    models: MODELS,
    hangOn: (route, body) => {
      if (!hung) return false;
      if (route === "show") asked(body?.model);
      return true;
    },
  });
  return { ...ollama, showAsked, hang: () => void (hung = true) };
}

test("ollamaShown inside ollamaReading: a stale kept listing answers and nothing is asked; outside it a run still asks /api/show", async (t) => {
  let at = 1_000_000;
  ollamaClock(() => at);
  t.after(() => ollamaClock());
  const ollama = await hangingOllama(t);
  const env = { OLLAMA_HOST: ollama.host };
  assert.deepEqual((await ollamaModels(env)).map((model) => model.name), MODELS.map((model) => model.name));
  ollama.hang();
  at += OLLAMA_TTL_MS + 1;
  const shown = ollama.got.show.length;
  const read = await ollamaReading(() => ollamaShown(env, MODELS[2].name));
  assert.deepEqual(read, { name: MODELS[2].name, capabilities: ["completion", "tools"], trained: 32_768 }, "the kept entry, at any age");
  assert.equal(await ollamaReading(() => ollamaShown(env, "synth-never:1b")), undefined, "a tag the kept listing lacks: none, and nothing asked");
  assert.equal(ollama.got.show.length, shown, "no /api/show inside a reading");
  // A run's choice is no reading: past the TTL it asks /api/show (the gate settles), and the test ends the ask itself, as
  // the deadline would: no clock.
  const stop = new AbortController();
  const send = (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, stop.signal]) : stop.signal });
  const run = ollamaShown(env, MODELS[2].name, { fetch: send });
  assert.equal(await ollama.showAsked, MODELS[2].name, "a run asks /api/show past the TTL");
  stop.abort();
  assert.equal(await run, undefined, "and a hung Ollama gives it nothing");
});

/** A server on a hanging fake Ollama, its listing kept while it answers; `write(api)` then runs past the TTL with the
 *  Ollama hung, raced against its first /api/show. Returns the server's client, the fake and the write's answer. */
async function writeWhileHung(t, write) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, KEYS);
  let clock = Date.now();
  ollamaClock(() => clock);
  t.after(() => ollamaClock());
  const ollama = await hangingOllama(t);
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api } = await serve(t, { faux: undefined });
  const caps = async () => (await api("GET", "/capabilities")).body;
  const piFree = async () => (await caps()).harnesses.find((h) => h.id === "pi").free_models.map((m) => m.id);
  assert.deepEqual(await piFree(), IDS, "listed while Ollama answers");
  ollama.hang();
  const shown = ollama.got.show.length;
  clock += OLLAMA_TTL_MS + 1;
  // Raced against the hung Ollama's first /api/show: the write answering first proves it asked none, with no clock.
  const first = await Promise.race([write(api).then((answer) => ({ answer })), ollama.showAsked.then((model) => ({ model }))]);
  assert.ok("answer" in first, `the write asked the hung Ollama for /api/show of ${first.model} before its 204`);
  assert.equal(first.answer.status, 204, JSON.stringify(first.answer.body));
  assert.deepEqual(ollama.got.show.slice(shown), [], "no /api/show once it hung");
  assert.deepEqual(await piFree(), IDS, "the offers still name the kept listing's models");
  return { caps };
}

// The offers (harnessOffers): a model key changes them, so its save probes them again; with OpenAI's key the host's
// default is OpenAI's, so the model needs ask Ollama nothing and only the offers' Ollama models are read.
test("a model key's save while the Ollama hangs past its listing's TTL: the offers ask it nothing, and keep the kept models", { timeout: 60_000 }, async (t) => {
  // OpenAI keys are not checked (key-check.ts NOT_CHECKED), so the save calls no provider.
  await writeWhileHung(t, (api) => api("PUT", "/settings/tool-keys/openai", { values: { OPENAI_API_KEY: `sk-test-${randomBytes(12).toString("hex")}` } }));
});

// The model needs (server.ts needsOf): with no model key the host's default is the Ollama's first tools model. A tool
// key's removal leaves the offers' inputs as they were (nothing probed again), so only the needs read the Ollama.
test("a tool key's removal with Ollama the default, while it hangs past its listing's TTL: the model needs ask it nothing", { timeout: 60_000 }, async (t) => {
  const { caps } = await writeWhileHung(t, (api) => api("DELETE", "/settings/tool-keys/parallel"));
  const { ready, needs } = (await caps()).models;
  assert.deepEqual([ready, needs], [true, null], "a run that names no model still runs, on the kept default");
});
