// A model named in a form its harness does not take is refused at save, in a person's words: the form that harness takes
// (with examples this server can run) and the likely id when one is obvious, never the catalog's own. Capabilities serve
// each harness's pickable models in that exact form (harnesses[].models), which the console's Model picker lists.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, serve, withEnv } from "./support.mjs";

const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const withKey = (t, env) => {
  withEnv(t, env, MODEL_VARS);
  return serve(t, { faux: undefined });
};
const message = (answer) => answer.body.error.fields[0].message;

test("pi refuses anthropic/claude-sonnet-5.5 at save, naming the form and the likely id, not the catalog's words", async (t) => {
  const { api } = await withKey(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` });
  const refused = await api("POST", "/agents", agent("dotted", { model: "anthropic/claude-sonnet-5.5" }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error.fields[0].field, "definition.model");
  assert.match(message(refused), /On pi, a model is <provider>\/<model id>, like anthropic\/claude-sonnet-5-5/);
  assert.match(message(refused), /Did you mean anthropic\/claude-sonnet-5-5\?/);
  assert.doesNotMatch(message(refused), /pi-ai|AGENT_MODEL_BASE_URL/);
});

test("pi refuses a name with no provider, and suggests the id it likely means", async (t) => {
  const { api } = await withKey(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` });
  const refused = await api("POST", "/agents", agent("plain-name", { model: "Sonnet 5.5" }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.match(message(refused), /On pi, a model is <provider>\/<model id>, like anthropic\/claude-sonnet-5-5 or openrouter\/anthropic\/claude-sonnet-5\.5/);
  assert.match(message(refused), /Did you mean anthropic\/claude-sonnet-5-5\?/);
  assert.doesNotMatch(message(refused), /pi-ai|host's default/);
});

test("with only an OpenRouter key, the likely id and the examples are OpenRouter's forms", async (t) => {
  const { api } = await withKey(t, { OPENROUTER_API_KEY: `not-a-secret-${"router"}` });
  const refused = await api("POST", "/agents", agent("via-router", { model: "openrouter/anthropic/claude-sonnet-5-5" }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.match(message(refused), /like openrouter\/anthropic\/claude-sonnet-5\.5:/);
  assert.match(message(refused), /Did you mean openrouter\/anthropic\/claude-sonnet-5\.5\?/);
});

test("capabilities serve each harness's pickable models in the form it takes", async (t) => {
  const { api } = await withKey(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, OPENAI_API_KEY: `not-a-secret-${"openai"}` });
  const harnesses = (await api("GET", "/capabilities")).body.harnesses;
  const pi = harnesses.find((h) => h.id === "pi");
  assert.deepEqual(pi.models, ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5", "anthropic/claude-fable-5-2", "openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "openai/gpt-6-luna"]);
  for (const h of harnesses) assert.ok(Array.isArray(h.models), h.id);
  for (const h of harnesses.filter((h) => !h.available)) assert.deepEqual(h.models, [], h.id);
});

const GATEWAY = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:4000/v1", AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}` };

test("behind a gateway whose model name has no provider, no choice is listed that a save would refuse", async (t) => {
  const { api } = await withKey(t, { ...GATEWAY, AGENT_MODEL: "gpt-test" });
  const harnesses = (await api("GET", "/capabilities")).body.harnesses;
  for (const h of harnesses) {
    for (const model of h.models) {
      const saved = await api("POST", "/agents", agent(`gw-${h.id}-${model.replace(/\W/g, "-")}`, { model, harness: h.id }));
      assert.notEqual(saved.status, 422, `${h.id} lists ${model}: ${JSON.stringify(saved.body)}`);
    }
  }
  assert.ok(!harnesses.find((h) => h.id === "pi").models.includes("gpt-test"));
});

test("behind a gateway, Claude is offered no OpenAI model, pi is offered the gateway's provider/model name", async (t) => {
  const { api } = await withKey(t, { ...GATEWAY, AGENT_MODEL: "openai/gpt-6.1-sol", ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}` });
  const harnesses = (await api("GET", "/capabilities")).body.harnesses;
  const claude = harnesses.find((h) => h.id === "claude-agent");
  for (const model of claude.models) assert.match(model, /^anthropic\//, `claude-agent lists ${model}`);
  assert.ok(harnesses.find((h) => h.id === "pi").models.includes("openai/gpt-6.1-sol"));
});
