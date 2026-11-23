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

const { ollamaClock, ollamaModels, ollamaReading, ollamaShown, OLLAMA_SHOW_TIMEOUT_MS, OLLAMA_TTL_MS } = await import("../dist/ollama-provider.js");

// The suites turn every Ollama off (support.mjs); this file asks its own fakes alone.
delete process.env.AGENTRUN_SERVE_FAUX_NO_OLLAMA;

/** Every model key and setting a model could come from: none set. */
const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PARTICLE_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "AGENTRUN_FREE_MODEL_REQUESTS", "OLLAMA_HOST"];
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
  // A run's choice is no reading: past the TTL it asks /api/show (the gate settles; the deadline, short here, ends it).
  const run = ollamaShown(env, MODELS[2].name, { timeoutMs: 200 });
  assert.equal(await ollama.showAsked, MODELS[2].name, "a run asks /api/show past the TTL");
  assert.equal(await run, undefined, "and a hung Ollama gives it nothing");
});

test("a key's save while the Ollama hangs past its listing's TTL: the 204 asks it nothing, and the offers keep the kept models", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, KEYS);
  let clock = Date.now();
  ollamaClock(() => clock);
  t.after(() => ollamaClock());
  const ollama = await hangingOllama(t);
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api } = await serve(t, { faux: undefined });
  const piFree = async () => (await api("GET", "/capabilities")).body.harnesses.find((h) => h.id === "pi").free_models.map((m) => m.id);
  assert.deepEqual(await piFree(), IDS, "listed while Ollama answers");
  ollama.hang();
  const shown = ollama.got.show.length;
  clock += OLLAMA_TTL_MS + 1;
  const started = performance.now();
  // OpenAI keys are not checked (key-check.ts NOT_CHECKED), so the save calls no provider.
  const save = api("PUT", "/settings/tool-keys/openai", { values: { OPENAI_API_KEY: `sk-test-${randomBytes(12).toString("hex")}` } });
  const first = await Promise.race([save.then((saved) => ({ saved })), ollama.showAsked.then((model) => ({ model }))]);
  assert.ok("saved" in first, `the save asked the hung Ollama for /api/show of ${first.model} before its 204`);
  assert.equal(first.saved.status, 204, JSON.stringify(first.saved.body));
  assert.ok(performance.now() - started < OLLAMA_SHOW_TIMEOUT_MS, "well inside one /api/show deadline");
  assert.deepEqual(ollama.got.show.slice(shown), [], "no /api/show once it hung");
  assert.deepEqual(await piFree(), IDS, "the offers still name the kept listing's models");
});
