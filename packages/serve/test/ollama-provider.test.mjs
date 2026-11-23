// Ollama as a model provider (ollama-provider.ts): its models listed live from the Ollama on this machine (OLLAMA_HOST,
// read as the ollama CLI reads it, else 127.0.0.1:11434), each request on its native /api/chat with options.num_ctx the
// model's trained context up to 64k, every time. A model whose /api/show capabilities name `tools` takes them natively;
// any other takes them as text on the runner's translated route. Pi alone runs them, at $0, and their requests never
// count toward the free-model limit (CapModel.local). With no key, the first Ollama model that calls tools is the
// default; any key wins. All against a fake Ollama on loopback (fixtures/fake-ollama.mjs), which counts only its own
// three paths; no real Ollama is asked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closedPort, fakeOllama, SYNTH_MODELS } from "./fixtures/fake-ollama.mjs";
import { agent, follow, journalOf, serve, withEnv } from "./support.mjs";

const { chooseModel, hostModel, providerModels, runModels } = await import("../dist/model.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { listOllama, ollamaAsking, ollamaBase, ollamaClock, OLLAMA_NUM_CTX, OLLAMA_TTL_MS } = await import("../dist/ollama-provider.js");

const PLAIN = "synth-plain:1b";
const TOOLS = "synth-tools:2b";
/** Every model key the default could come from, and the settings that would put another model first: none of them set. */
const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PARTICLE_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "AGENTRUN_FREE_MODEL_REQUESTS"];

const READ = { name: "read", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const REQUEST = { model: "route", max_tokens: 256, stream: true, system: "You review code.", tools: [READ], messages: [{ role: "user", content: "Review a.ts." }] };

/** The Messages events `route`'s own translation answers REQUEST with. */
async function eventsOf(route) {
  const response = await route.fetch(`${route.provider.origin}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(REQUEST) });
  return (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
}

test("providerModels lists exactly the chat models the Ollama here lists, from /api/tags and /api/show; a down Ollama lists none and throws nothing", async (t) => {
  const ollama = await fakeOllama(t);
  const models = await providerModels({ OLLAMA_HOST: ollama.host });
  const listed = models.getModels("ollama");
  assert.deepEqual(listed.map((model) => model.id), [PLAIN, TOOLS], "the fake's two chat tags, in its order; the embedding model is no chat model");
  assert.equal(ollama.got.tags, 1);
  assert.deepEqual(ollama.got.show, SYNTH_MODELS.map((model) => model.name), "each tag's capabilities asked of /api/show");
  const [plain, tools] = listed;
  assert.equal(plain.toolsAs, "text", "no `tools` capability: tools as text");
  assert.equal(tools.toolsAs, undefined, "a `tools` capability: native");
  assert.equal(tools.reasoning, true, "a `thinking` capability reasons");
  assert.equal(plain.reasoning, false);
  assert.ok(listed.every((model) => model.api !== "openai-responses" && model.api !== "anthropic-messages" && model.baseUrl === ollama.url));
  assert.deepEqual([plain.cost, tools.cost], [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }], "$0");
  assert.ok(await models.getAuth(plain), "keyless: it runs with no key");

  const down = await providerModels({ OLLAMA_HOST: `127.0.0.1:${await closedPort()}` });
  assert.deepEqual(down.getModels("ollama"), [], "nothing listening: no ollama models");
  assert.ok(down.getModels("openai").length > 0, "and every other provider as before");
});

test("under the model gateway or the faux model, providerModels never asks Ollama and lists no Ollama model", async (t) => {
  const ollama = await fakeOllama(t);
  for (const env of [{ AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL: "synth-gateway" }, { AGENTRUN_SERVE_FAUX: "1" }]) {
    const models = await providerModels({ OLLAMA_HOST: ollama.host, ...env });
    assert.deepEqual(models.getModels("ollama"), [], Object.keys(env)[0]);
  }
  assert.equal(ollama.got.tags, 0, "the fake was never asked for its tags");
  assert.deepEqual(ollama.got.show, []);
});

test("a listing whose deadline passes while one /api/show is pending keeps the models shown before it", async (t) => {
  const ollama = await fakeOllama(t, { hangOn: (route, body) => route === "show" && body?.model === TOOLS });
  const listed = await listOllama({ OLLAMA_HOST: ollama.host }, { timeoutMs: 300 });
  assert.deepEqual(listed.map((model) => model.name), [PLAIN, "synth-embed:1b"], "the hung one left out, the others kept");
});

test("a run pinned to an Ollama model resolves it with its /api/show alone: a hung /api/tags is never waited on", async (t) => {
  const ollama = await fakeOllama(t, { hangOn: (route) => route === "tags" });
  const env = { OLLAMA_HOST: ollama.host };
  const route = await routeOf(`ollama/${TOOLS}`, env);
  assert.equal(route.like?.contextWindow, 65_536);
  const pinned = await runModels(env, { pinned: { provider: "ollama", modelId: TOOLS } });
  assert.equal(pinned.models.getModel("ollama", TOOLS)?.contextWindow, 65_536);
  assert.equal(ollama.got.tags, 0, "the listing never asked");
  assert.ok(ollama.got.show.length > 0 && ollama.got.show.every((name) => name === TOOLS), JSON.stringify(ollama.got.show));
});

test("a start on another provider's model never asks Ollama: an OpenRouter key, the host default or a named model, with an Ollama that never answers", async (t) => {
  const ollama = await fakeOllama(t, { hang: true });
  const env = { OLLAMA_HOST: ollama.host, OPENROUTER_API_KEY: `not-a-secret-${"keyed-start"}` };
  const chosen = await chooseModel(env, undefined, "default", "pi");
  assert.equal(chosen.model?.provider, "openrouter", JSON.stringify(chosen));
  await runModels(env, undefined);
  await runModels(env, "openrouter/openai/gpt-6.1-sol");
  assert.equal(ollama.got.tags, 0, "no listing started, so none awaited");
  assert.deepEqual(ollama.got.show, []);
});

test("an Ollama cloud model (remote_model and remote_host, run on ollama.com) is never listed, so never local and never the default, even newest and with tools", async (t) => {
  const cloud = { name: "synth-cloud:20b-cloud", remote_model: "synth-cloud:20b", remote_host: "https://ollama.com", capabilities: ["completion", "tools", "thinking"], family: "synthcloud" };
  const ollama = await fakeOllama(t, { models: [cloud, ...SYNTH_MODELS] });
  const env = { OLLAMA_HOST: ollama.host };
  const models = await providerModels(env);
  assert.deepEqual(models.getModels("ollama").map((model) => model.id), [PLAIN, TOOLS], "the cloud model left out");
  assert.equal(hostModel(env, "default", "pi"), `ollama/${TOOLS}`, "the default is the first local model with tools");
  assert.ok(!ollama.got.show.includes(cloud.name), "its tag alone says it is a cloud model: no /api/show for it");
});

test("an Ollama that takes the request and never answers lists nothing once its timeout passes, and that answer is kept for its address", async (t) => {
  const ollama = await fakeOllama(t, { hang: true });
  const env = { OLLAMA_HOST: ollama.host };
  assert.deepEqual(await listOllama(env, { timeoutMs: 50 }), [], "no models, no throw");
  assert.equal(ollama.got.tags, 1, "it was asked");
  const models = await providerModels(env);
  assert.deepEqual(models.getModels("ollama"), [], "providerModels takes the kept answer");
  assert.equal(ollama.got.tags, 1, "and asks the stuck Ollama no more");
});

test("a model trained on more than 64k runs at 64k: every /api/chat request carries options.num_ctx 65536, and its window is 65536", async (t) => {
  const ollama = await fakeOllama(t, { reply: () => ({ text: "Fine." }) });
  const env = { OLLAMA_HOST: ollama.host };
  const route = await routeOf(`ollama/${TOOLS}`, env);
  assert.equal(route.like?.contextWindow, OLLAMA_NUM_CTX, "pi's session compacts at the context Ollama is asked for");
  await eventsOf(route);
  await eventsOf(route);
  const models = await providerModels(env);
  const model = models.getModel("ollama", TOOLS);
  assert.equal(model.contextWindow, 65_536);
  const side = await models.completeSimple(model, { messages: [{ role: "user", content: "Hi.", timestamp: 0 }] });
  assert.equal(side.stopReason, "stop", side.errorMessage);
  assert.equal(ollama.got.chat.length, 3, "two route turns and one side request");
  for (const body of ollama.got.chat) assert.equal(body.options?.num_ctx, 65_536, JSON.stringify(body.options));
});

test("OLLAMA_CONTEXT_LENGTH, set to a whole number above 0, caps num_ctx and the window below 64k and the trained context; any other value is ignored", async (t) => {
  const ollama = await fakeOllama(t, { reply: () => ({ text: "Fine." }) });
  const capped = { OLLAMA_HOST: ollama.host, OLLAMA_CONTEXT_LENGTH: "32768" };
  const route = await routeOf(`ollama/${TOOLS}`, capped);
  assert.equal(route.like?.contextWindow, 32_768, "the user's own context length, below 64k and the trained 131072");
  await eventsOf(route);
  assert.equal(ollama.got.chat.at(-1).options?.num_ctx, 32_768);
  const models = await providerModels(capped);
  assert.equal(models.getModel("ollama", TOOLS).contextWindow, 32_768);
  assert.equal((await providerModels({ ...capped, OLLAMA_CONTEXT_LENGTH: "50000" })).getModel("ollama", PLAIN).contextWindow, 40_960, "above the trained context: the trained one");
  for (const ignored of ["0", "-1", "lots", "8192.5", ""]) {
    assert.equal((await providerModels({ ...capped, OLLAMA_CONTEXT_LENGTH: ignored })).getModel("ollama", TOOLS).contextWindow, 65_536, `${JSON.stringify(ignored)} ignored`);
  }
});

test("a model trained on less than 64k runs at its own context, in num_ctx and its window alike", async (t) => {
  const ollama = await fakeOllama(t, { reply: () => ({ text: "Fine." }) });
  const env = { OLLAMA_HOST: ollama.host };
  const model = (await providerModels(env)).getModel("ollama", PLAIN);
  assert.equal(model.contextWindow, 40_960);
  const route = await routeOf(`ollama/${PLAIN}`, env);
  assert.equal(route.like?.contextWindow, 40_960);
  await eventsOf(route);
  assert.equal(ollama.got.chat.at(-1).options?.num_ctx, 40_960);
});

test("a model whose /api/show names no context length runs at 64k", async (t) => {
  const ollama = await fakeOllama(t, { models: [{ name: "synth-nolength:1b", capabilities: ["completion", "tools"], family: "synthnolength" }], reply: () => ({ text: "Fine." }) });
  const env = { OLLAMA_HOST: ollama.host };
  assert.equal((await providerModels(env)).getModel("ollama", "synth-nolength:1b").contextWindow, 65_536);
  await eventsOf(await routeOf("ollama/synth-nolength:1b", env));
  assert.equal(ollama.got.chat.at(-1).options?.num_ctx, 65_536);
});

test("a model without the thinking capability that opens its answer with <think> has that part as thinking, up to </think>, as Ollama splits it for a thinking model", async (t) => {
  const texts = ["<think>\n\n</think>\nThe answer.", "<think>\nWeighing it.</think>\n\nThe answer.", "<thinking>kept</thinking> as said.", "A <think> later stays.", "<think>x"];
  const ollama = await fakeOllama(t, { reply: (_body, n) => ({ text: texts[(n - 1) % texts.length] }) });
  const models = await providerModels({ OLLAMA_HOST: ollama.host });
  const ask = async (id) => (await models.completeSimple(models.getModel("ollama", id), { messages: [{ role: "user", content: "Hi.", timestamp: 0 }] })).content.map((block) => [block.type, block.text ?? block.thinking]);
  assert.deepEqual(await ask(PLAIN), [["text", "The answer."]], "an empty think block: no thinking, and no tag in the answer");
  assert.deepEqual(await ask(PLAIN), [["thinking", "Weighing it."], ["text", "The answer."]]);
  assert.deepEqual(await ask(PLAIN), [["text", "<thinking>kept</thinking> as said."]], "<think> alone, no other tag form");
  assert.deepEqual(await ask(PLAIN), [["text", "A <think> later stays."]], "only where the answer opens with it");
  assert.deepEqual(await ask(PLAIN), [["thinking", "x"]], "a tag cut across two chunks (the fake sends each answer in two halves), and none closed by the end");
  assert.deepEqual(await ask(TOOLS), [["text", "<think>\n\n</think>\nThe answer."]], "a thinking model's content is Ollama's own split: left as it is");
});

test("a model without the tools capability gets its tools as text, no `tools` field, and a call in its text comes back a real call; a tools model gets native tools", async (t) => {
  const ollama = await fakeOllama(t, {
    reply: (body) => body.model === PLAIN
      ? { text: 'Reading.\n<function_calls>\n<invoke name="read">\n<parameter name="path" string="true">a.ts</parameter>\n</invoke>\n</function_calls>' }
      : { calls: [{ name: "read", arguments: { path: "b.ts" } }] },
  });
  const env = { OLLAMA_HOST: ollama.host };
  const route = await routeOf(`ollama/${PLAIN}`, env);
  assert.equal(route.provider.api, "anthropic-messages", "the translated route: Messages to the route's own fetch");
  const asText = await eventsOf(route);
  const plainBody = ollama.got.chat.at(-1);
  assert.equal(plainBody.model, PLAIN);
  assert.equal("tools" in plainBody, false, "no tools field");
  assert.equal(plainBody.messages[0].role, "system");
  assert.match(plainBody.messages[0].content, /You review code\.[\s\S]*<functions>\n\{"name":"read"/, "the tools in its system prompt");
  const textUse = asText.find((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  assert.equal(textUse?.content_block.name, "read", JSON.stringify(asText));
  assert.equal(asText.find((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta").delta.partial_json, '{"path":"a.ts"}');
  assert.equal(asText.find((event) => event.type === "message_delta").delta.stop_reason, "tool_use");

  const native = await eventsOf(await routeOf(`ollama/${TOOLS}`, env));
  const toolsBody = ollama.got.chat.at(-1);
  assert.deepEqual(toolsBody.tools?.map((tool) => [tool.type, tool.function.name]), [["function", "read"]], "native tools");
  assert.doesNotMatch(toolsBody.messages[0].content, /<functions>/);
  const nativeUse = native.find((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
  assert.equal(nativeUse?.content_block.name, "read");
  assert.equal(native.find((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta").delta.partial_json, '{"path":"b.ts"}');
  assert.equal(native.find((event) => event.type === "message_delta").delta.stop_reason, "tool_use");
});

test("a run on an Ollama model books $0, and its requests never count toward the free-model limit", { timeout: 120_000 }, async (t) => {
  // The limit at 2: a free model's third request would be refused. The run makes four.
  withEnv(t, { AGENTRUN_FREE_MODEL_REQUESTS: "2" }, KEYS);
  const ollama = await fakeOllama(t, { reply: (_body, n) => (n <= 3 ? { calls: [{ name: "lookup", arguments: { n } }], usage: { input: 50, output: 5 } } : { text: "All done.", usage: { input: 60, output: 4 } }) });
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api, data } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("local", { model: `ollama/${TOOLS}` }))).status, 201);
  const started = await api("POST", "/agents/local/runs", { input: { content: "Look it up three times." }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.equal(view.cost?.usd, 0, JSON.stringify(view.cost));
  assert.equal(ollama.got.chat.length, 4, "past the limit of 2, every request was sent");
  const requests = journalOf(data, started.body.run_id).filter((entry) => entry.kind === "runner.request").map((entry) => entry.data);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.freeRequest === undefined), "none counted toward the limit");
});

test("an agent's max_requests stops a run on an Ollama model at that many requests: local skips the server's limit alone, never the agent's", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  // A model that calls a tool on every answer: with no limit the run would loop until its turns ran out.
  const ollama = await fakeOllama(t, { reply: (_body, n) => ({ calls: [{ name: "lookup", arguments: { n } }], usage: { input: 50, output: 5 } }) });
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api, data } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("capped", { model: `ollama/${TOOLS}`, max_requests: 2 }))).status, 201);
  const started = await api("POST", "/agents/capped/runs", { input: { content: "Look it up until told to stop." }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(view.status, "failed", JSON.stringify(view));
  assert.match(String(view.error?.message ?? view.error), /2-request limit/, JSON.stringify(view.error));
  assert.equal(ollama.got.chat.length, 2, "the third request was never sent");
  assert.match(JSON.stringify(ollama.got.chat[0].messages), /2 free-model requests left in this run/, "told to finish, as a run near the server's limit is");
  const requests = journalOf(data, started.body.run_id).filter((entry) => entry.kind === "runner.request").map((entry) => entry.data);
  assert.ok(requests.every((request) => request.freeRequest === undefined), "none counted toward the server's limit");
});

test("a run on the host default books the Ollama model it ran on: its usage line names ollama and the tag, as the run page reads it", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  const ollama = await fakeOllama(t);
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api } = await serve(t, { faux: undefined });
  const named = agent("local");
  delete named.definition.model;
  assert.equal((await api("POST", "/agents", named)).status, 201);
  const started = await api("POST", "/agents/local/runs", { input: { content: "Hi." }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.equal(view.cost.tokens.requests, 1, "the run view's request count, which the run header reads the usage again on");
  assert.equal(ollama.got.chat[0].model, TOOLS, "it ran on the default");
  const lines = (await api("GET", `/runs/${started.body.run_id}/usage`)).body.lines.filter((line) => line.meter === "tokens");
  assert.deepEqual(lines.map((line) => [line.provider, line.model, line.requests, line.usd]), [["ollama", TOOLS, 1, 0]], "provider/model is the id the console labels: ollama/<tag>");
});

test("with no key and Ollama up, the default is the first Ollama model that calls tools, listed in the picker and its free models; any key wins", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  const ollama = await fakeOllama(t);
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api } = await serve(t, { faux: undefined });
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.models.default, `ollama/${TOOLS}`, JSON.stringify(caps.models));
  assert.equal(caps.models.ready, true);
  const pi = caps.harnesses.find((harness) => harness.id === "pi");
  assert.equal(pi.default_model, `ollama/${TOOLS}`);
  for (const id of [`ollama/${PLAIN}`, `ollama/${TOOLS}`]) {
    assert.ok(pi.models.includes(id), `${id} in pi's models: ${pi.models}`);
    assert.ok(pi.free_models.some((model) => model.id === id), `${id} in pi's free models`);
  }
  assert.equal(pi.free_models.find((model) => model.id === `ollama/${PLAIN}`).context_window, 40_960);
  for (const harness of caps.harnesses.filter((h) => h.id !== "pi")) {
    assert.ok(!(harness.models ?? []).some((id) => id.startsWith("ollama/")), `${harness.id} never runs pi's local models`);
    assert.ok(!String(harness.default_model ?? "").startsWith("ollama/"), `${harness.id} has no local default`);
    assert.equal(hostModel({ OLLAMA_HOST: ollama.host }, "default", harness.id), undefined, `${harness.id}: its facts run no Ollama model, so the host gives it none`);
  }
  assert.equal(hostModel({ OLLAMA_HOST: ollama.host }, "default", "pi"), `ollama/${TOOLS}`);

  withEnv(t, { OPENROUTER_API_KEY: `not-a-secret-${"ollama-default"}` });
  const keyed = await serve(t, { faux: undefined });
  const withKey = (await keyed.api("GET", "/capabilities")).body;
  assert.equal(withKey.models.default, "openrouter/openai/gpt-6.1-sol", "a key's model wins over Ollama's");
  assert.ok(withKey.harnesses.find((h) => h.id === "pi").models.includes(`ollama/${TOOLS}`), "Ollama's models stay pickable");
});

test("an Ollama whose models take no tools gives no default: they stay pickable, and pi still asks for a key", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  const ollama = await fakeOllama(t, { models: SYNTH_MODELS.filter((model) => model.name !== TOOLS) });
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api } = await serve(t, { faux: undefined });
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.models.default, null, JSON.stringify(caps.models));
  assert.equal(caps.models.ready, false);
  const pi = caps.harnesses.find((harness) => harness.id === "pi");
  assert.equal(pi.default_model, null);
  assert.ok(pi.models.includes(`ollama/${PLAIN}`), String(pi.models));
});

test("an Ollama started after the server, with a model pulled, shows in capabilities once the kept listing goes stale: refreshed behind one answer, in the next, with no restart and no key saved", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, KEYS);
  let clock = 1_000_000;
  ollamaClock(() => clock);
  t.after(() => ollamaClock());
  const port = await closedPort();
  const env = { OLLAMA_HOST: `127.0.0.1:${port}` };
  withEnv(t, env);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("GET", "/capabilities")).body.models.default, null, "Ollama down: nothing listed");
  const ollama = await fakeOllama(t, { port, models: [SYNTH_MODELS.find((model) => model.name === TOOLS)] });
  assert.equal((await api("GET", "/capabilities")).body.models.default, null, "the down answer is still fresh");
  assert.equal(ollama.got.tags, 0, "nothing asked while it is fresh");
  clock += OLLAMA_TTL_MS;
  await api("GET", "/capabilities");
  await ollamaAsking(env);
  assert.equal(ollama.got.tags, 1, "the stale answer asked again, behind the answer");
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.models.default, `ollama/${TOOLS}`, JSON.stringify(caps.models));
  assert.equal(caps.models.ready, true);
  assert.ok(caps.harnesses.find((harness) => harness.id === "pi").models.includes(`ollama/${TOOLS}`));
});

// OLLAMA_HOST as the ollama CLI reads it: a scheme or none (http), a port or the default (11434 with no scheme; the
// scheme's own with one), 0.0.0.0 and :: (where `ollama serve` listens on every address) connecting to this machine.
test("OLLAMA_HOST unset: 127.0.0.1:11434", () => assert.equal(ollamaBase({}), "http://127.0.0.1:11434"));
test("OLLAMA_HOST 0.0.0.0: this machine, on 11434", () => assert.equal(ollamaBase({ OLLAMA_HOST: "0.0.0.0" }), "http://127.0.0.1:11434"));
test("OLLAMA_HOST 0.0.0.0:11434: this machine", () => assert.equal(ollamaBase({ OLLAMA_HOST: "0.0.0.0:11434" }), "http://127.0.0.1:11434"));
test("OLLAMA_HOST [::]:7000: this machine over IPv6", () => assert.equal(ollamaBase({ OLLAMA_HOST: "[::]:7000" }), "http://[::1]:7000"));
test("OLLAMA_HOST host:port with no scheme: http", () => assert.equal(ollamaBase({ OLLAMA_HOST: "127.0.0.1:7000" }), "http://127.0.0.1:7000"));
test("OLLAMA_HOST a host with no scheme and no port: 11434", () => assert.equal(ollamaBase({ OLLAMA_HOST: "localhost" }), "http://localhost:11434"));
test("OLLAMA_HOST http://host:port", () => assert.equal(ollamaBase({ OLLAMA_HOST: "http://[::1]:7000" }), "http://[::1]:7000"));
test("OLLAMA_HOST https://host: https's own port", () => assert.equal(ollamaBase({ OLLAMA_HOST: "https://ollama.example.test" }), "https://ollama.example.test"));
test("OLLAMA_HOST with a path keeps it", () => assert.equal(ollamaBase({ OLLAMA_HOST: "https://gpu.example.test/ollama/" }), "https://gpu.example.test/ollama"));

test("OLLAMA_HOST plain http to another machine is refused, and a refused Ollama is never asked", async () => {
  for (const refused of ["http://10.0.0.5:11434", "10.0.0.5:11434", "ollama.example.test", "http://someone@127.0.0.1:11434", "ftp://127.0.0.1:11434"]) {
    assert.throws(() => ollamaBase({ OLLAMA_HOST: refused }), /OLLAMA_HOST/, refused);
    let asked = 0;
    const counting = async () => (asked += 1, new Response("{}"));
    assert.deepEqual(await listOllama({ OLLAMA_HOST: refused }, { fetch: counting }), [], refused);
    assert.equal(asked, 0, `${refused}: nothing sent`);
  }
});
