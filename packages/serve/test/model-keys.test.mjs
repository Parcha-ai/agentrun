// A model provider's key gives the host its default model when AGENT_MODEL is not set (model.ts' MODEL_KEYS), saved
// through /settings/tool-keys with no restart; capabilities say whether a revision that names no model runs
// (`models.ready`) and what it needs. No network: the run below talks to a Responses endpoint on loopback.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { hostModel, MODEL_KEYS } from "../dist/model.js";
import { readingOf } from "../dist/server.js";
import { agent, FAUX, follow, responsesEndpoint, serve, withEnv } from "./support.mjs";

const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SEAL_KEY", ...MODEL_KEYS.map((row) => row.field)];
/** A throwaway value: none is a real key. */
const made = () => `not-a-secret-${randomBytes(12).toString("hex")}`;
/** Each form a value could plausibly leak in: as text, base64, base64url and hex, and its random part's first 8. */
const formsOf = (value) => [value, ...["base64", "base64url", "hex"].map((code) => Buffer.from(value).toString(code)), value.slice(13, 21)];
const holdsNone = (bytes, forms, where) => { for (const form of forms) assert.ok(!Buffer.from(bytes).includes(form), `${where} holds the key`); };
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
const keyed = (...ids) => Object.fromEntries(MODEL_KEYS.filter((row) => ids.includes(row.id)).map((row) => [row.field, made()]));

test("with no AGENT_MODEL a provider's key gives the default: anthropic, then openai, then openrouter; a harness takes only a key it runs on; AGENT_MODEL wins", () => {
  assert.equal(hostModel({}), undefined);
  assert.equal(hostModel(keyed("anthropic", "openai", "openrouter")), "anthropic/claude-sonnet-5-5");
  assert.equal(hostModel(keyed("openai", "openrouter")), "openai/gpt-6.1-sol");
  assert.equal(hostModel(keyed("openrouter")), "openrouter/anthropic/claude-sonnet-5.5");
  assert.equal(hostModel({ ...keyed("anthropic"), AGENT_MODEL: "openai/gpt-6-luna" }), "openai/gpt-6-luna", "the host's own default wins");
  assert.equal(hostModel(keyed("anthropic"), "fast"), "anthropic/claude-sonnet-5-5", "a tier with no model of its own takes the default");
  assert.equal(hostModel(keyed("anthropic", "openai"), "default", "codex"), "openai/gpt-6.1-sol", "codex runs OpenAI's models");
  assert.equal(hostModel(keyed("anthropic", "openai"), "default", "claude-agent"), "anthropic/claude-sonnet-5-5");
  assert.equal(hostModel(keyed("openai", "openrouter"), "default", "claude-agent"), undefined, "claude-agent runs Anthropic's only");
});

test("the host's model counts for a harness only when that harness runs it: claude-agent Anthropic's, codex OpenAI's or the gateway's, pi any; else the harness takes its own key's default", () => {
  const gateway = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: "gpt-6-luna" };
  // A gateway id names no provider: pi and codex run it through the gateway; claude-agent, which talks to Anthropic only,
  // takes its own key's default (a placeholder key behind a broker counts as a key).
  assert.equal(hostModel({ ...gateway, ...keyed("anthropic") }, "default", "pi"), "gpt-6-luna");
  assert.equal(hostModel({ ...gateway, ...keyed("anthropic") }, "default", "codex"), "gpt-6-luna");
  assert.equal(hostModel({ ...gateway, ...keyed("anthropic") }, "default", "claude-agent"), "anthropic/claude-sonnet-5-5");
  assert.equal(hostModel({ ...gateway, ANTHROPIC_API_KEY: "placeholder", ANTHROPIC_BASE_URL: "http://127.0.0.1:8" }, "default", "claude-agent"), "anthropic/claude-sonnet-5-5", "the broker case");
  assert.equal(hostModel(gateway, "default", "claude-agent"), undefined, "no Anthropic key: none");
  // A provider's id runs on its own harness and on pi only.
  assert.equal(hostModel({ AGENT_MODEL: "openai/gpt-6-luna" }, "default", "claude-agent"), undefined);
  assert.equal(hostModel({ AGENT_MODEL: "openai/gpt-6-luna" }, "default", "codex"), "openai/gpt-6-luna");
  assert.equal(hostModel({ AGENT_MODEL: "anthropic/claude-opus-5-5", ...keyed("openai") }, "default", "codex"), "openai/gpt-6.1-sol");
  assert.equal(hostModel({ AGENT_MODEL: "anthropic/claude-opus-5-5", ...keyed("openai") }, "default", "claude-agent"), "anthropic/claude-opus-5-5");
  assert.equal(hostModel({ AGENT_MODEL: "anthropic/claude-opus-5-5", ...keyed("openai") }), "anthropic/claude-opus-5-5", "pi runs any");
  // A tier's own model the harness can't run is skipped, never an error: the default stands in.
  assert.equal(hostModel({ AGENT_MODEL_FAST: "openai/gpt-6-mini", AGENT_MODEL: "anthropic/claude-haiku-5" }, "fast", "claude-agent"), "anthropic/claude-haiku-5");
  assert.equal(hostModel({ AGENT_MODEL_FAST: "openai/gpt-6-mini", AGENT_MODEL: "anthropic/claude-haiku-5" }, "fast"), "openai/gpt-6-mini");
});

test("each default is a model pi-ai's catalog lists and prices, of the key's own provider, and not that provider's dearest", () => {
  const models = builtinModels();
  for (const row of MODEL_KEYS) {
    const slash = row.model.indexOf("/");
    const [provider, id] = [row.model.slice(0, slash), row.model.slice(slash + 1)];
    assert.equal(provider, row.id);
    const model = models.getModel(provider, id);
    assert.ok(model && model.cost.input > 0 && model.cost.output > 0, `${row.model} is listed with a price`);
    const dearest = Math.max(...models.getModels(provider).map((m) => m.cost.input + m.cost.output));
    assert.ok(model.cost.input + model.cost.output < dearest, `${row.model} is not ${provider}'s dearest`);
  }
});

test("capabilities' models.ready and needs: a key when none names a model or the default's provider has none, a model when pi-ai knows none such", async () => {
  const models = async (env) => { const { ready, needs } = (await readingOf(env, 1)).caps.models; return { ready, needs }; };
  assert.deepEqual(await models({}), { ready: false, needs: "key" });
  assert.deepEqual(await models(keyed("openrouter")), { ready: true, needs: null });
  assert.deepEqual(await models({ AGENT_MODEL: "anthropic/claude-sonnet-5-5", ...keyed("openai") }), { ready: false, needs: "key" }, "AGENT_MODEL wins, and its provider has no key");
  assert.deepEqual(await models({ AGENT_MODEL: "anthropic/no-such-model", ...keyed("anthropic") }), { ready: false, needs: "model" });
  assert.deepEqual(await models({ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9" }), { ready: false, needs: "key" });
  assert.deepEqual(await models({ AGENTRUN_SERVE_FAUX: FAUX }), { ready: true, needs: null });
});

test("a model key saved with no restart: a server with none says no model runs and refuses the run; saved, a revision that names no model runs on its default; the key is in no answer, log or file", { timeout: 60_000 }, async (t) => {
  const endpoint = await responsesEndpoint(t, "42", 10);
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENT_MODEL_BASE_URL: endpoint.url }, MODEL_VARS);
  const lines = [];
  const { api, data } = await serve(t, { faux: undefined, log: (line) => lines.push(line) });
  const models = async () => (await api("GET", "/capabilities")).body.models;
  assert.deepEqual(await models(), { source: "gateway", route_prefix: "agent-model", fast: null, default: null, strong: null, ready: false, needs: "key" });
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const refused = await api("POST", "/agents/plain/runs", { input: { content: "hi" } });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "agent_not_runnable"]);

  const value = made();
  assert.equal((await api("PUT", "/settings/tool-keys/anthropic", { values: { ANTHROPIC_API_KEY: value } })).status, 204);
  const model = "anthropic/claude-sonnet-5-5";
  assert.deepEqual(await models(), { source: "gateway", route_prefix: "agent-model", fast: `agent-model/${model}`, default: `agent-model/${model}`, strong: `agent-model/${model}`, ready: true, needs: null }, "no restart");
  const offered = (await api("GET", "/capabilities")).body.harnesses.filter((harness) => harness.available).map((harness) => harness.id);
  const row = (await api("GET", "/settings/tool-keys")).body.keys.find((key) => key.id === "anthropic");
  assert.deepEqual([row.kind, row.unlocks, row.harnesses, row.fields], ["model", [], ["pi", "claude-agent"].filter((id) => offered.includes(id)), [{ name: "ANTHROPIC_API_KEY", set: true, source: "stored" }]]);
  const started = await api("POST", "/agents/plain/runs", { input: { content: "What is six times seven?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  assert.ok(endpoint.models.length > 0 && endpoint.models.every((asked) => asked === model), `the gateway is asked for the key's default: ${endpoint.models}`);

  const answers = [await api("GET", "/capabilities"), await api("GET", "/settings/tool-keys"), await api("GET", `/runs/${started.body.run_id}`), await api("GET", `/runs/${started.body.run_id}/timeline`)].map((answer) => JSON.stringify(answer.body));
  holdsNone(answers.join("\n"), formsOf(value), "an answer");
  holdsNone(JSON.stringify(endpoint.bodies), formsOf(value), "what the gateway was sent");
  holdsNone(lines.join("\n"), formsOf(value), "the log");
  for (const file of filesUnder(data)) holdsNone(readFileSync(file), formsOf(value), file);

  assert.equal((await api("DELETE", "/settings/tool-keys/anthropic")).status, 204);
  assert.deepEqual(await models(), { source: "gateway", route_prefix: "agent-model", fast: null, default: null, strong: null, ready: false, needs: "key" }, "deleted, none again");
});
