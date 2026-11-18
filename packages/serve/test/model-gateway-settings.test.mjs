// The model gateway saved in the console (model-gateway.ts: Settings → Model keys → Use a model gateway), end to end. The
// gateway is a loopback stand-in (fixtures/faux-gateway.mjs) that lists its models and records the key each request
// carried. Proven here:
//   - saved from the owner's session, it puts every model on the gateway at once, with no restart: capabilities read
//     ready, and a run is sent to it on its key; removed, the provider keys are in force again;
//   - the API token can neither save, remove nor test it (each carries or directs the key), and can read it;
//   - an address is refused by the one rule AGENT_MODEL_BASE_URL is (provider.ts gatewayBase), in its words;
//   - AGENT_MODEL_BASE_URL set where AgentRun starts wins whole: the saved gateway and its key are never used, and its
//     changes are 409;
//   - the test lists the gateway's models, with its key, follows no redirect, and never says the key;
//   - the key (a canary) is in no answer, log line, the store's bytes in the clear, this process's environment, or what a
//     run's environment is made of.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, serve, storeBytes, withEnv } from "./support.mjs";

const { gatewayBase } = await import("../dist/provider.js");
const { withSavedGateway, GATEWAY_KEY_ROW } = await import("../dist/model-gateway.js");
const { withoutSecrets } = await import("../dist/secrets.js");

/** The key: a canary, no real one. */
const CANARY = `not-a-secret-${"gateway-canary"}-7c41e9d2`;
/** A key that is not the gateway's, and one the environment holds for no gateway: dummies too. */
const WRONG = `not-a-secret-${"not-the-key"}`;
const ENV_KEY = `not-a-secret-${"environments-own-key"}`;
const MODEL = "claude-sonnet-5-5";
/** Every variable these tests set or clear: the server holds no model key, and names no gateway, of its own. */
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SERVE_GRADE_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];

/** The bearer token each POST the gateway took carried, in order. */
const bearers = (gw) => gw.requests.filter((request) => request.method === "POST").map((request) => request.headers.authorization);
/** The words gatewayBase refuses `value` in, under `name`. */
const refusalOf = (name, value) => {
  try {
    gatewayBase(name, value);
  } catch (error) {
    return error.message;
  }
  throw new Error(`${value} is not refused`);
};

test("a gateway saved from the owner's session puts every model on it at once: capabilities ready, a run sent to it on its key; removed, the provider keys are back; the key is nowhere else", { timeout: 180_000 }, async (t) => {
  const gw = await startFauxGateway({ text: "Answered.", models: [MODEL, "gpt-6.1-sol"], key: CANARY });
  t.after(() => gw.close());
  withEnv(t, {}, NAMES);
  const logs = [];
  const server = await serve(t, { faux: undefined, log: (line) => logs.push(line) });
  const { api, store, data } = server;
  const answers = [];
  const said = async (...args) => {
    const answer = await api(...args);
    answers.push(answer.body);
    return answer;
  };
  const models = async () => (await said("GET", "/capabilities")).body.models;
  assert.equal((await models()).ready, false, "no key, no gateway: no model");
  assert.deepEqual((await said("GET", "/settings/model-gateway")).body.source, null);

  // The form's Test: the gateway's models, asked with the key it was given, before anything is saved.
  const listed = await said("POST", "/settings/model-gateway/test", { base_url: `${gw.url}/v1`, api_key: CANARY });
  assert.deepEqual([listed.status, listed.body], [200, { ok: true, models: [MODEL, "gpt-6.1-sol"] }]);
  const wrongKey = await said("POST", "/settings/model-gateway/test", { base_url: gw.url, api_key: WRONG });
  assert.equal(wrongKey.body.ok, false);
  assert.match(wrongKey.body.why, /refused the key \(401\)/);

  const saved = await said("PUT", "/settings/model-gateway", { base_url: `${gw.url}/v1`, api_key: CANARY, models: { default: MODEL } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.source, saved.body.base_url, saved.body.ids, saved.body.models, saved.body.secret.set, saved.body.secret.source, saved.body.problem], ["console", `${gw.url}/v1`, "as_named", { default: MODEL, fast: null, strong: null }, true, "console", null]);
  assert.deepEqual([(await models()).ready, (await models()).source], [true, "gateway"], "in force at once, with no restart");
  // Test with no body: the gateway in force, on its saved key.
  assert.deepEqual((await said("POST", "/settings/model-gateway/test")).body, { ok: true, models: [MODEL, "gpt-6.1-sol"] });

  assert.equal((await api("POST", "/agents", agent("on-gateway"))).status, 201);
  const started = await said("POST", "/agents/on-gateway/runs", { input: { content: "Answer." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { last, rows } = await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
  const posts = gw.requests.filter((request) => request.method === "POST");
  assert.ok(posts.length >= 1, "the run's model requests went to the gateway");
  assert.deepEqual([...new Set(bearers(gw))], [`Bearer ${CANARY}`], "every one on the saved key");
  assert.deepEqual([...new Set(posts.map((request) => request.body.model))], [MODEL], "on the saved default model");

  // A new origin with a key saved: the key is never sent there unless entered again (or none said outright).
  const moved = await said("PUT", "/settings/model-gateway", { base_url: "https://gateway.example/v1", models: { default: MODEL } });
  assert.deepEqual([moved.status, moved.body.error?.fields?.[0]?.field], [422, "api_key"], JSON.stringify(moved.body));

  // Removed: the key's row gone, and the provider keys in force again, with no restart.
  const removed = await said("DELETE", "/settings/model-gateway");
  assert.deepEqual([removed.status, removed.body.source, removed.body.secret.set], [200, null, false]);
  assert.equal((await models()).ready, false, "back to the provider keys: none here");
  assert.equal(await store.sealedKeys.get(GATEWAY_KEY_ROW), undefined, "the key's sealed row is gone");

  // The canary: in no answer, no log line, not in the store's bytes in the clear, not in this process's environment.
  answers.push((await api("GET", `/runs/${started.body.run_id}`)).body, (await api("GET", `/runs/${started.body.run_id}/timeline`)).body);
  await store.flush();
  assert.equal(JSON.stringify(answers).includes(CANARY), false, "not in any answer");
  assert.equal(logs.join("\n").includes(CANARY), false, "not in any log line");
  assert.equal(storeBytes(data).includes(Buffer.from(CANARY)), false, "not in the store's bytes in the clear");
  assert.equal(Object.values(process.env).some((value) => value?.includes(CANARY)), false, "not in this process's environment");
});

test("the saved gateway's key is read by name alone: never in a spread, a JSON of the environment, or the environment a child gets; an environment's own key never goes to it", () => {
  const env = withSavedGateway({ PATH: "/bin", AGENT_MODEL_API_KEY: ENV_KEY }, { v: 1, base_url: "https://gateway.example", ids: "bare", models: { default: "m-1" }, key: CANARY });
  assert.deepEqual([env.AGENT_MODEL_BASE_URL, env.AGENT_MODEL, env.AGENT_MODEL_GATEWAY_IDS, env.AGENT_MODEL_API_KEY], ["https://gateway.example", "m-1", "bare", CANARY]);
  for (const [what, made] of [["a spread", JSON.stringify({ ...env })], ["its JSON", JSON.stringify(env)], ["a child's environment", JSON.stringify(withoutSecrets(env))], ["its keys", Object.keys(env).join(" ")]]) assert.equal(made.includes(CANARY), false, `not in ${what}`);
  const keyless = withSavedGateway({ AGENT_MODEL_API_KEY: ENV_KEY }, { v: 1, base_url: "https://gateway.example", ids: "as_named", models: { default: "m-1" } });
  assert.equal(keyless.AGENT_MODEL_API_KEY, "", "a key set where AgentRun starts goes only to the gateway set there, never to a saved one");
  // AGENT_MODEL_BASE_URL set where AgentRun starts wins whole: nothing saved is laid over it.
  const own = { AGENT_MODEL_BASE_URL: "https://own.example", AGENT_MODEL: "own-model" };
  assert.equal(withSavedGateway(own, { v: 1, base_url: "https://gateway.example", ids: "as_named", models: { default: "m-1" }, key: CANARY }), own);
  // A tier's variable set where AgentRun starts wins over the saved field.
  assert.equal(withSavedGateway({ AGENT_MODEL: "env-model" }, { v: 1, base_url: "https://gateway.example", ids: "as_named", models: { default: "m-1" } }).AGENT_MODEL, "env-model");
});

test("only the owner's session saves, removes or tests the gateway: the API token is refused each, and reads it", { timeout: 60_000 }, async (t) => {
  withEnv(t, {}, NAMES);
  const server = await serve(t);
  const asToken = { authorization: `Bearer ${server.token}` };
  const body = { base_url: "https://gateway.example/v1", api_key: CANARY, models: { default: MODEL } };
  for (const [method, path, sent] of [["PUT", "/settings/model-gateway", body], ["DELETE", "/settings/model-gateway", undefined], ["POST", "/settings/model-gateway/test", { base_url: "https://gateway.example", api_key: CANARY }]]) {
    const refused = await server.api(method, path, sent, asToken);
    assert.equal(refused.status, 403, `${method} ${path}: ${JSON.stringify(refused.body)}`);
  }
  const read = await server.api("GET", "/settings/model-gateway", undefined, asToken);
  assert.deepEqual([read.status, read.body.source], [200, null], "nothing was saved");
});

test("an address is refused by the one rule AGENT_MODEL_BASE_URL is, in its words, by the save and the test alike; nothing is saved", { timeout: 60_000 }, async (t) => {
  withEnv(t, {}, NAMES);
  const { api } = await serve(t);
  for (const bad of ["http://gateway.example/v1", "https://user@gateway.example", "https://gateway.example/a/../b", "https://gateway.example/v1?team=1"]) {
    const words = refusalOf("base_url", bad);
    assert.equal(words, refusalOf("AGENT_MODEL_BASE_URL", bad).replace("AGENT_MODEL_BASE_URL", "base_url"), "the environment's rule, under the field's name");
    for (const [method, path, body] of [["PUT", "/settings/model-gateway", { base_url: bad, models: { default: MODEL } }], ["POST", "/settings/model-gateway/test", { base_url: bad }]]) {
      const refused = await api(method, path, body);
      assert.deepEqual([refused.status, refused.body.error?.fields?.[0]?.field, refused.body.error?.fields?.[0]?.message], [422, "base_url", words], `${method} ${bad}: ${JSON.stringify(refused.body)}`);
    }
  }
  assert.equal((await api("GET", "/settings/model-gateway")).body.source, null, "nothing was saved");
  // No default model, and none set where AgentRun starts: refused by name.
  const noModel = await api("PUT", "/settings/model-gateway", { base_url: "https://gateway.example" });
  assert.deepEqual([noModel.status, noModel.body.error?.fields?.[0]?.field], [422, "models.default"]);
});

test("the test follows no redirect: a gateway that redirects is said so, and the key never reaches the address it names", { timeout: 60_000 }, async (t) => {
  const elsewhere = await startFauxGateway({ models: ["m-1"] });
  t.after(() => elsewhere.close());
  const redirecting = createServer((req, res) => res.writeHead(302, { location: `${elsewhere.url}${req.url}` }).end());
  await new Promise((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (redirecting.closeAllConnections(), redirecting.close(resolve))));
  withEnv(t, {}, NAMES);
  const { api } = await serve(t);
  const answer = await api("POST", "/settings/model-gateway/test", { base_url: `http://127.0.0.1:${redirecting.address().port}`, api_key: CANARY });
  assert.equal(answer.body.ok, false);
  assert.match(answer.body.why, /redirect \(302\)/);
  assert.equal(JSON.stringify(answer.body).includes(CANARY), false);
  assert.equal(elsewhere.requests.length, 0, "nothing reached the address it redirects to");
});

test("AGENT_MODEL_BASE_URL set where AgentRun starts wins over the saved gateway, whole: its runs go there, the saved key is never sent, and the saved one can't be changed", { timeout: 240_000 }, async (t) => {
  const saved = await startFauxGateway({ text: "From the saved gateway." });
  const own = await startFauxGateway({ text: "From the environment's gateway." });
  t.after(() => saved.close());
  t.after(() => own.close());
  withEnv(t, {}, NAMES);
  const first = await serve(t, { faux: undefined });
  const kept = await first.api("PUT", "/settings/model-gateway", { base_url: saved.url, api_key: CANARY, models: { default: MODEL } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  await first.stop();

  withEnv(t, { AGENT_MODEL_BASE_URL: own.url, AGENT_MODEL: MODEL }, NAMES);
  const logs = [];
  const server = await serve(t, { faux: undefined, data: first.data, log: (line) => logs.push(line) });
  const { api } = server;
  const view = await api("GET", "/settings/model-gateway");
  assert.deepEqual([view.body.source, view.body.base_url, view.body.models.default, view.body.secret.set, view.body.set_at_start], ["env", own.url, MODEL, false, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL"]], JSON.stringify(view.body));
  for (const [method, path, body] of [["PUT", "/settings/model-gateway", { base_url: saved.url, models: { default: MODEL } }], ["DELETE", "/settings/model-gateway", undefined]]) {
    const refused = await api(method, path, body);
    assert.deepEqual([refused.status, refused.body.error?.code], [409, "key_set_by_server"], `${method}: ${JSON.stringify(refused.body)}`);
  }
  assert.equal((await api("POST", "/agents", agent("env-wins"))).status, 201);
  // The environment's gateway holds no key here: each run brings its own (run-model-key.ts), as without a saved one.
  const started = await api("POST", "/agents/env-wins/runs", { input: { content: "Answer." }, model_key: "a-run-key-of-its-own" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { last, rows } = await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.slice(-3)));
  assert.ok(own.requests.some((request) => request.method === "POST"), "the run went to the environment's gateway");
  assert.equal(saved.requests.length, 0, "nothing went to the saved one");
  assert.equal(JSON.stringify([own.requests, logs]).includes(CANARY), false, "the saved key was never sent, nor logged");
});

test("a claimed run's tools never get the saved gateway's key: its model routes read it, by name, from the run environment alone", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomBytes } = await import("node:crypto");
  const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
  const { claimSecrets, claimModelEnv } = await import("../dist/runner/claim-secrets.js");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gateway-claim-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  const runEnv = withSavedGateway({ PATH: "/bin" }, { v: 1, base_url: "https://gateway.example", ids: "as_named", models: { default: "m-1" }, key: CANARY });
  const tools = await claimSecrets({ store, sealKey: randomBytes(32), env: runEnv }, { kind: "agentic", body: { tools: [] } }, { model: { provider: "agent-model", modelId: "m-1" } });
  assert.equal(JSON.stringify(Object.getOwnPropertyNames(tools).map((name) => tools[name])).includes(CANARY), false, "not on the tools' environment");
  assert.equal(claimModelEnv(runEnv, tools, undefined).AGENT_MODEL_API_KEY, CANARY, "the model routes read it");
});
