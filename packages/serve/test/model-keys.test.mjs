// A model provider's key gives the host its default model when AGENT_MODEL is not set (model.ts' MODEL_KEYS), saved
// through /settings/tool-keys with no restart; capabilities say whether a revision that names no model runs
// (`models.ready`) and what it needs. No network: the run below talks to a Responses endpoint on loopback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { claudeModel, harnessModelKeys } from "../dist/adapters.js";
import { chooseModel, harnessRuns, hostModel, MODEL_KEYS } from "../dist/model.js";
import { readingOf } from "../dist/server.js";
import { agent, client, FAUX, follow, printed, responsesEndpoint, scratch, serve, withEnv } from "./support.mjs";
import { fileURLToPath } from "node:url";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
/** A fake key, made at runtime: distinct per name, and no credential-shaped literal for the source export to flag. */
const fakeKey = (name) => ["not-a-secret", name].join("-");

const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENTRUN_SEAL_KEY", ...MODEL_KEYS.map((row) => row.field)];
/** A throwaway value: none is a real key. */
const made = () => `not-a-secret-${randomBytes(12).toString("hex")}`;
/** Each form a value could plausibly leak in: as text, base64, base64url and hex, and its random part's first 8. */
const formsOf = (value) => [value, ...["base64", "base64url", "hex"].map((code) => Buffer.from(value).toString(code)), value.slice(13, 21)];
const holdsNone = (bytes, forms, where) => { for (const form of forms) assert.ok(!Buffer.from(bytes).includes(form), `${where} holds the key`); };
// Files only: the Claude Code a first use installs (linked here from this repository: support.mjs linkHarnesses) is not the server's writing.
const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []));
const keyed = (...ids) => Object.fromEntries(MODEL_KEYS.filter((row) => ids.includes(row.id)).map((row) => [row.field, made()]));

test("with no AGENT_MODEL a provider's key gives the default: anthropic, then openai, then openrouter; a harness takes only a key it runs on; AGENT_MODEL wins", () => {
  assert.equal(hostModel({}), undefined);
  assert.equal(hostModel(keyed("anthropic", "openai", "openrouter")), "anthropic/claude-sonnet-5-5");
  assert.equal(hostModel(keyed("openai", "openrouter")), "openai/gpt-6.1-sol");
  assert.equal(hostModel(keyed("openrouter")), "openrouter/openai/gpt-6-sol", "pi's on OpenRouter: on its bearer route (model.ts)");
  assert.equal(hostModel({ ...keyed("anthropic"), AGENT_MODEL: "openai/gpt-6-luna" }), "openai/gpt-6-luna", "the host's own default wins");
  assert.equal(hostModel(keyed("anthropic"), "fast"), "anthropic/claude-sonnet-5-5", "a tier with no model of its own takes the default");
  assert.equal(hostModel(keyed("anthropic", "openai"), "default", "codex"), "openai/gpt-6.1-sol", "codex runs OpenAI's models");
  assert.equal(hostModel(keyed("anthropic", "openai"), "default", "claude-agent"), "anthropic/claude-sonnet-5-5");
  assert.equal(hostModel(keyed("openai", "openrouter"), "default", "claude-agent"), "anthropic/claude-sonnet-5.5", "claude-agent runs Anthropic's, through OpenRouter on its key");
  assert.equal(hostModel(keyed("openai"), "default", "claude-agent"), undefined, "claude-agent runs Anthropic's only");
});

test("the host's model counts for a harness only when that harness runs it: claude-agent Anthropic's, codex OpenAI's or the gateway's, pi any; else the harness takes its own key's default", () => {
  const gateway = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL: "gpt-6-luna" };
  // A gateway id names no provider: pi and codex run it through the gateway; claude-agent, which talks to Anthropic only,
  // takes its own key's default (a placeholder key behind a broker counts as a key).
  assert.equal(hostModel({ ...gateway, ...keyed("anthropic") }, "default", "pi"), "gpt-6-luna");
  assert.equal(hostModel({ ...gateway, ...keyed("anthropic") }, "default", "codex"), "gpt-6-luna");
  assert.equal(hostModel({ ...gateway, ...keyed("anthropic") }, "default", "claude-agent"), "anthropic/claude-sonnet-5-5");
  assert.equal(hostModel({ ...gateway, ANTHROPIC_API_KEY: "not-a-secret", ANTHROPIC_BASE_URL: "http://127.0.0.1:8" }, "default", "claude-agent"), "anthropic/claude-sonnet-5-5", "the broker case");
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

// A gateway id is the gateway's own string: on the gateway route nothing reads a provider out of it, so codex runs a
// namespaced one (team/model) and even one that looks like another vendor's. Without a gateway, codex runs OpenAI's only.
test("behind a gateway, codex takes AGENT_MODEL as the gateway's own string, whatever it holds; without one, only OpenAI's ids", () => {
  const gw = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9" };
  for (const id of ["team/model", "my-gw/gpt-x", "anthropic/x", "gpt-6-luna", "openai/gpt-6-luna", "openrouter/openai/gpt-6-sol"]) assert.equal(harnessRuns(gw, id, "codex"), true, `behind a gateway: ${id}`);
  for (const [id, runs] of [["team/model", false], ["my-gw/gpt-x", false], ["anthropic/x", false], ["gpt-6-luna", false], ["openai/gpt-6-luna", true], ["openrouter/openai/gpt-6-sol", true]]) assert.equal(harnessRuns({}, id, "codex"), runs, `no gateway: ${id}`);
  assert.equal(hostModel({ ...gw, AGENT_MODEL: "team/model" }, "default", "codex"), "team/model");
  assert.equal(hostModel({ ...gw, AGENT_MODEL: "team/model", ...keyed("openai") }, "default", "codex"), "team/model", "never the OpenAI key's default instead");
  assert.equal(hostModel({ ...gw, AGENT_MODEL: "team/model" }, "default", "claude-agent"), undefined, "claude-agent never takes the gateway");
});

test("opencode runs the models codex runs, OpenAI's, OpenRouter's or the gateway's: an OpenAI key gives it its default, and another provider's model is skipped for it", () => {
  // OpenCode's model requests go where codex's do (adapters.ts' codexProvider): OpenAI with its key, OpenRouter with its
  // key, or the gateway.
  assert.equal(hostModel(keyed("anthropic", "openai"), "default", "opencode"), "openai/gpt-6.1-sol", "an OpenAI key's default");
  assert.equal(hostModel(keyed("anthropic", "openrouter"), "default", "opencode"), "openai/gpt-6-sol", "OpenRouter's key alone: codex's route");
  assert.equal(hostModel(keyed("anthropic"), "default", "opencode"), undefined, "no OpenAI or OpenRouter key: none");
  assert.equal(hostModel({ AGENT_MODEL: "gpt-6-luna", AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", ...keyed("anthropic") }, "default", "opencode"), "gpt-6-luna", "the gateway's own id");
  assert.equal(hostModel({ AGENT_MODEL: "openai/gpt-6-luna" }, "default", "opencode"), "openai/gpt-6-luna");
  assert.equal(hostModel({ AGENT_MODEL: "anthropic/claude-opus-5-5", ...keyed("openai") }, "default", "opencode"), "openai/gpt-6.1-sol", "an Anthropic AGENT_MODEL is skipped for the OpenAI key's default");
  assert.equal(hostModel({ AGENT_MODEL: "anthropic/claude-opus-5-5" }, "default", "opencode"), undefined, "an Anthropic AGENT_MODEL alone: none");
  assert.deepEqual(MODEL_KEYS.find((row) => row.id === "openai").harnesses, ["pi", "codex", "opencode"], "the OpenAI key runs pi, codex and opencode");
  // Guard (#1571): behind a gateway, opencode runs the gateway's model id as given, as codex does, a namespaced one and one
  // that looks like another vendor's alike; without a gateway, neither.
  const gw = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9" };
  assert.equal(harnessRuns(gw, "team/model", "opencode"), true, "behind a gateway: team/model");
  assert.equal(harnessRuns(gw, "anthropic/x", "opencode"), true, "behind a gateway: anthropic/x, the gateway's own string");
  assert.equal(hostModel({ ...gw, AGENT_MODEL: "team/model", ...keyed("openai") }, "default", "opencode"), "team/model", "never the OpenAI key's default instead");
  assert.equal(harnessRuns({}, "team/model", "opencode"), false, "no gateway: team/model");
});

// A key-less first run (npx, no key yet) is told what a person does: add a key in the console or where AgentRun starts.
// Operator detail (--faux, AGENT_MODEL, a tier's variable) is the README's. A model no catalog knows is still named.
test("with no model here, the refusal says what a person does: a model key in Settings or where AgentRun starts, no operator flags", async () => {
  const none = "No model yet: add a model key in Settings → Model keys, or set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY where AgentRun starts.";
  assert.equal((await chooseModel({}, undefined)).why, none);
  assert.equal((await chooseModel({}, undefined, "fast")).why, none.replace("No model yet:", "No model yet for this workflow's fast tier:"));
  assert.equal((await chooseModel({}, "openai/gpt-5")).why, "No OpenAI key here for openai/gpt-5: add one in Settings → Model keys, or set OPENAI_API_KEY where AgentRun starts.");
  assert.equal(claudeModel({}, undefined).why, "No model yet for claude-agent: add an OpenRouter or Anthropic key in Settings → Model keys, or set OPENROUTER_API_KEY or ANTHROPIC_API_KEY where AgentRun starts.");
  for (const why of [(await chooseModel({}, undefined)).why, (await chooseModel({}, "openai/gpt-5")).why, claudeModel({}, undefined).why]) assert.doesNotMatch(why, /--faux|AGENT_MODEL|agentrun-serve/);
  const unknown = await chooseModel({ OPENAI_API_KEY: made() }, "openai/no-such-model");
  assert.deepEqual([unknown.needs, /no-such-model/.test(unknown.why)], ["model", true], "a model no catalog knows is named");
});

// A gateway that takes bare ids gets a key's default as it gets the same model named (the part after the provider, its
// provider pricing it); a host's own AGENT_MODEL goes as its operator set it.
test("on a gateway that takes bare ids, a key's default goes as the same model named does; AGENT_MODEL goes as configured", async () => {
  const gateway = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_GATEWAY_IDS: "bare", OPENAI_API_KEY: "not-a-secret" };
  const keyed = await chooseModel(gateway, undefined);
  assert.deepEqual(keyed, await chooseModel(gateway, "openai/gpt-6.1-sol"));
  assert.deepEqual(keyed, { model: { provider: "agent-model", modelId: "gpt-6.1-sol" }, namedProvider: "openai" });
  assert.deepEqual((await chooseModel({ ...gateway, AGENT_MODEL: "openai/gpt-6.1-sol" }, undefined)).model.modelId, "openai/gpt-6.1-sol", "an operator's AGENT_MODEL goes as configured");
});

test("behind a gateway, a run that holds the gateway's key alone takes the model the server's keys give, as the server chooses it: pi's and codex's, at each tier, bare ids too; a tier the host names keeps its own", async () => {
  const gateway = { AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: fakeKey("gateway") };
  // The server's view at a run's launch: every key it holds. The run's: the gateway's key, and the model the server's
  // keys give, from the server (AGENTRUN_SERVE_DEFAULT_MODEL), never the key that gives it.
  for (const extra of [{}, { AGENT_MODEL_GATEWAY_IDS: "bare" }, { AGENT_MODEL_FAST: "fast-1" }]) {
    const served = { ...gateway, ...extra, OPENAI_API_KEY: fakeKey("openai") };
    const run = { ...gateway, ...extra, AGENTRUN_SERVE_DEFAULT_MODEL: "openai/gpt-6.1-sol" };
    for (const harness of ["pi", "codex"]) {
      for (const tier of ["default", "fast", "strong"]) {
        const chosen = await chooseModel(served, undefined, tier, harness);
        assert.ok("model" in chosen, JSON.stringify(chosen));
        assert.deepEqual(await chooseModel(run, undefined, tier, harness), chosen, `${harness} at ${tier} with ${JSON.stringify(extra)}`);
      }
    }
  }
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

// The server remakes its capabilities from parts after each write (startHolding): whether a revision that names no model
// runs (models.needs) is one, made from env alone and remade with it at each key write. So the next read after a model
// key's PUT or DELETE says so, with no restart, and a tool-settings write in between (which remakes the caps from the
// parts held) keeps it.
test("a model key's PUT or DELETE changes capabilities' models.needs on the next read, with no restart, and a tool-settings write keeps it", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, MODEL_VARS);
  const { api } = await serve(t, { faux: undefined });
  const ready = async () => { const { ready, needs } = (await api("GET", "/capabilities")).body.models; return [ready, needs]; };
  assert.deepEqual(await ready(), [false, "key"]);
  assert.equal((await api("PUT", "/settings/tool-keys/openai", { values: { OPENAI_API_KEY: made() } })).status, 204);
  assert.deepEqual(await ready(), [true, null], "saved: a revision that names no model runs, with no restart");
  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "auto" } })).status, 200);
  assert.deepEqual(await ready(), [true, null], "a tool-settings write keeps it");
  assert.equal((await api("DELETE", "/settings/tool-keys/openai")).status, 204);
  assert.deepEqual(await ready(), [false, "key"], "deleted: none again");
});

// Key writes that overlap (a PUT still remaking whether a model runs when a DELETE lands) leave the capabilities agreeing
// with the keys as they end up: the latest write's answer stands, never an older one that finished after it. Each server
// is a process of its own, so its first key write loads the model catalog for the first time, the slow part a DELETE can
// land in.
test("overlapping model key writes leave capabilities' models.needs agreeing with the keys as they end up, on a server's first write", { timeout: 120_000 }, async (t) => {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !MODEL_VARS.includes(name))), AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
  for (let round = 0; round < 3; round++) {
    const data = join(await scratch(t), "agents");
    const script = `const { startServe } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
const server = await startServe({ data: ${JSON.stringify(data)}, port: 0 });
process.stdout.write(JSON.stringify({ base: server.baseUrl, token: server.token }) + "\\n");`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env });
    t.after(() => child.kill("SIGKILL"));
    const out = await printed(child, /\n/);
    const { base, token } = JSON.parse(out.slice(0, out.indexOf("\n")));
    const api = client(base, token);
    await Promise.all([api("PUT", "/settings/tool-keys/openai", { values: { OPENAI_API_KEY: made() } }), api("DELETE", "/settings/tool-keys/openai")]);
    const set = (await api("GET", "/settings/tool-keys")).body.keys.find((key) => key.id === "openai").fields[0].set;
    const { ready, needs } = (await api("GET", "/capabilities")).body.models;
    assert.deepEqual([ready, needs], set ? [true, null] : [false, "key"], `round ${round}: the key is ${set ? "set" : "not set"}`);
    child.kill("SIGKILL");
  }
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
  // OpenAI's key: a save does not check it with its provider (key-check.ts' NOT_CHECKED), so this reaches no network.
  assert.equal((await api("PUT", "/settings/tool-keys/openai", { values: { OPENAI_API_KEY: value } })).status, 204);
  const model = "openai/gpt-6.1-sol";
  assert.deepEqual(await models(), { source: "gateway", route_prefix: "agent-model", fast: `agent-model/${model}`, default: `agent-model/${model}`, strong: `agent-model/${model}`, ready: true, needs: null }, "no restart");
  const offered = (await api("GET", "/capabilities")).body.harnesses.filter((harness) => harness.available).map((harness) => harness.id);
  const row = (await api("GET", "/settings/tool-keys")).body.keys.find((key) => key.id === "openai");
  assert.deepEqual([row.kind, row.unlocks, row.harnesses, row.fields], ["model", [], ["pi", "codex", "opencode"].filter((id) => offered.includes(id)), [{ name: "OPENAI_API_KEY", set: true, source: "stored" }]]);
  const started = await api("POST", "/agents/plain/runs", { input: { content: "What is six times seven?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  assert.ok(endpoint.models.length > 0 && endpoint.models.every((asked) => asked === model), `the gateway is asked for the key's default: ${endpoint.models}`);

  const answers = [await api("GET", "/capabilities"), await api("GET", "/settings/tool-keys"), await api("GET", `/runs/${started.body.run_id}`), await api("GET", `/runs/${started.body.run_id}/timeline`)].map((answer) => JSON.stringify(answer.body));
  holdsNone(answers.join("\n"), formsOf(value), "an answer");
  holdsNone(JSON.stringify(endpoint.bodies), formsOf(value), "what the gateway was sent");
  holdsNone(lines.join("\n"), formsOf(value), "the log");
  for (const file of filesUnder(data)) holdsNone(readFileSync(file), formsOf(value), file);

  assert.equal((await api("DELETE", "/settings/tool-keys/openai")).status, 204);
  assert.deepEqual(await models(), { source: "gateway", route_prefix: "agent-model", fast: null, default: null, strong: null, ready: false, needs: "key" }, "deleted, none again");
});

// Behind a gateway, AGENT_MODEL is the gateway's own string, for codex as for pi (#1571: no provider is read out of a
// gateway's id), so with OpenAI's key also on the server, an agent naming no model still runs on AGENT_MODEL, on the
// gateway's key alone: the host's setting wins over a key's default. (This case began as Greptile's P1 on #1470, when
// codex skipped an Anthropic AGENT_MODEL behind a gateway; fix C's default for a run with no AGENT_MODEL is pinned by the
// custody and saved-key cases.)
const CODEX_FAKE = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));
const CODEX_STAND_IN = { AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [CODEX_FAKE], env: { FAKE_CODEX_MODEL: "remote" } }) };
for (const [harness, model] of [["codex", "anthropic/claude-sonnet-5-5"], ["pi", "anthropic/claude-sonnet-5-5"]]) {
  test(`behind a gateway, with AGENT_MODEL set and OpenAI's key on the server, a ${harness} agent naming no model runs on AGENT_MODEL's string (${model}), on the gateway's key alone`, { timeout: 90_000 }, async (t) => {
    const gw = await startFauxGateway({ text: "42" });
    t.after(() => gw.close());
    const gateway = made();
    const openai = made();
    withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL_API_KEY: gateway, AGENT_MODEL: "anthropic/claude-sonnet-5-5", OPENAI_API_KEY: openai, ...CODEX_STAND_IN }, [...MODEL_VARS, ...Object.keys(CODEX_STAND_IN)]);
    const { api } = await serve(t, { faux: undefined });
    assert.equal((await api("POST", "/agents", agent(`${harness}-default`, harness === "pi" ? {} : { harness }))).status, 201);
    const started = await api("POST", `/agents/${harness}-default/runs`, { input: { content: "What is six times seven?" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const { last } = await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
    assert.equal(last.status, "completed", JSON.stringify((await api("GET", `/runs/${started.body.run_id}`)).body.error));
    const sent = gw.requests.filter((r) => r.method === "POST");
    assert.ok(sent.length > 0 && sent.every((r) => r.body?.model === model), `the gateway is asked for ${model}: ${JSON.stringify(sent.map((r) => r.body?.model))}`);
    assert.ok(sent.every((r) => r.headers.authorization === `Bearer ${gateway}`), "on the gateway's key");
    assert.ok(!JSON.stringify(sent).includes(openai), "OpenAI's key is in no request");
  });
}

test("an opencode run is handed the model key its route sends, as a codex run is: the gateway's, OpenAI's, or OpenRouter's", () => {
  const k = fakeKey("any");
  for (const env of [{ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9", AGENT_MODEL_API_KEY: k }, { OPENAI_API_KEY: k }, { OPENROUTER_API_KEY: k }, { OPENAI_API_KEY: k, OPENROUTER_API_KEY: k }]) {
    const codex = harnessModelKeys("codex", env);
    assert.equal(codex.length, 1, `setup: codex holds one key with ${Object.keys(env)}`);
    assert.deepEqual(harnessModelKeys("opencode", env), codex, `opencode, with ${Object.keys(env)}`);
  }
  assert.deepEqual(harnessModelKeys("opencode", { OPENROUTER_API_KEY: k }, "openrouter/openai/gpt-6-sol"), ["OPENROUTER_API_KEY"], "a model named on OpenRouter");
});
