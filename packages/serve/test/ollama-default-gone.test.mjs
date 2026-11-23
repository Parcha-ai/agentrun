// The host's Ollama default after its tag is removed (Greptile P1 on #3492): a run that names no model, started by a
// client that never reads capabilities, is chosen again from a fresh listing instead of staying refused on the tag the
// last listing named. Within the listing's TTL nothing more is asked; past it, a tag that no longer answers drops the
// kept listing and lists once more. A model the agent names is never chosen again. The Ollama is a fake on loopback
// (fixtures/fake-ollama.mjs); no test asks this box's Ollama.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeOllama } from "./fixtures/fake-ollama.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const { ollamaClock, OLLAMA_TTL_MS } = await import("../dist/ollama-provider.js");

// The suites turn every Ollama off (support.mjs); this file asks its own fakes alone.
delete process.env.AGENTRUN_SERVE_FAUX_NO_OLLAMA;

/** Every model key and setting a model could come from: none set. */
const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PARTICLE_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "AGENTRUN_FREE_MODEL_REQUESTS", "OLLAMA_HOST"];
const A = { name: "synth-alpha:2b", capabilities: ["completion", "tools"], family: "synthalpha", context_length: 32_768 };
const B = { name: "synth-beta:2b", capabilities: ["completion", "tools"], family: "synthbeta", context_length: 32_768 };
const PLAIN = { name: "synth-plain:1b", capabilities: ["completion"], family: "synthplain", context_length: 40_960 };
/** The words with no model, where this server asks an Ollama (model.ts START_OLLAMA). */
const NO_MODEL = /^No model yet: start Ollama and pull a model with tools, or add a model key in Settings → Model keys/;

/** A server on a fake Ollama listing `models` (a tag removed through the fake's own remove, as `ollama rm`), its listing
 *  aged by a test clock, and an agent `local` on `model` (none: the host default). */
async function setUp(t, models, model) {
  withEnv(t, {}, KEYS);
  let clock = Date.now();
  ollamaClock(() => clock);
  t.after(() => ollamaClock());
  const ollama = await fakeOllama(t, { models });
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api } = await serve(t, { faux: undefined });
  const saved = agent("local", model ? { model } : {});
  if (!model) delete saved.definition.model;
  assert.equal((await api("POST", "/agents", saved)).status, 201);
  const start = () => api("POST", "/agents/local/runs", { input: { content: "Hi." }, max_cost_usd: 1 });
  const ran = async () => {
    const started = await start();
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
    const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
    assert.equal(view.status, "completed", JSON.stringify(view.error));
    return ollama.got.chat.at(-1).model;
  };
  return { ollama, start, ran, age: () => void (clock += OLLAMA_TTL_MS + 1) };
}

test("the host's Ollama default removed: a run that names no model, started without reading capabilities, runs on the next tools model", { timeout: 180_000 }, async (t) => {
  const { ollama, ran, age } = await setUp(t, [A, B]);
  assert.equal(await ran(), A.name, "the default: the first tools model listed");
  const tags = ollama.got.tags;
  assert.equal(await ran(), A.name);
  assert.equal(ollama.got.tags, tags, "a fresh listing is not asked again");
  ollama.remove(A.name);
  // The listing asked again behind the claim's first look lands well after it (CI's order, made certain): the choice
  // must not depend on that listing winning. Under OLLAMA_LIST_TIMEOUT_MS, so the listing still answers.
  ollama.slowTags(800);
  age();
  assert.equal(await ran(), B.name, "chosen again from a fresh listing, never refused on the removed tag");
});

test("the host's Ollama default removed and no tools model left: the run is refused in the no-model words", { timeout: 180_000 }, async (t) => {
  const { ollama, ran, start, age } = await setUp(t, [A, PLAIN]);
  assert.equal(await ran(), A.name);
  ollama.remove(A.name);
  age();
  const refused = await start();
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.match(refused.body.error.message, NO_MODEL);
  assert.doesNotMatch(refused.body.error.message, /synth-alpha/);
});

test("an agent that names ollama/<tag> keeps it once removed: refused naming that tag, never moved to another model", { timeout: 180_000 }, async (t) => {
  const { ollama, ran, start, age } = await setUp(t, [A, B], `ollama/${A.name}`);
  assert.equal(await ran(), A.name);
  ollama.remove(A.name);
  age();
  const chats = ollama.got.chat.length;
  const refused = await start();
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /synth-alpha:2b/);
  assert.equal(ollama.got.chat.length, chats, "nothing ran on another model");
});
