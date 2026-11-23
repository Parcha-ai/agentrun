// The openai-responses wire on a translated model (runner/responses-fetch.ts): a Responses request answered through the
// route's own Messages translation (model-route.ts messagesFetch), so an Ollama model runs on the wire codex and opencode
// speak as it runs on pi's: options.num_ctx on every request, tools as text for a model that takes none, errors and
// reasoning through the run's redactor. A tool call comes back as a function_call item; an answer cut at its output
// limit ends response.incomplete with its usage, which codex's and opencode's proxy policies book (and codex's reads as
// a cut, so the harness ends the turn rather than asking again); a replayed turn's call and output reach Ollama as its
// own tool call and tool message. A custom tool or a stored item is refused, never dropped. The wire decides (wires.ts
// TRANSLATED): codex, opencode and any harness on Responses get the route's origin and fetch, no key, $0 and local, under
// the route's trust rules; codex offers no live web search there. All against a fake Ollama on loopback
// (fixtures/fake-ollama.mjs); no real Ollama is asked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTE_ORIGIN } from "@parcha/agentrun-kernel/host";
import { codexPolicy } from "@parcha/agentrun-harness-codex";
import { readFile } from "node:fs/promises";
import { closedPort, fakeOllama } from "./fixtures/fake-ollama.mjs";
import { harnessData, scratch, withEnv } from "./support.mjs";

const { routeOf } = await import("../dist/runner/model-route.js");
const adapters = await import("../dist/adapters.js");
const { modelOn, providerFor } = await import("../dist/provider.js");
const { harnessOf } = await import("../dist/harness-table.js");
const { routed, WIRES } = await import("../dist/wires.js");
const { cliCapModel } = await import("../dist/runner/cli-run-spec.js");
const { ollamaHostOf } = await import("../dist/ollama-provider.js");
const { TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");
const { responsesFetch } = await import("../dist/runner/responses-fetch.js");
const { openCodePolicy } = await import("../dist/harness-opencode/host/policy.js");

// The suites turn every Ollama off (support.mjs, OLLAMA_OFF_ENV); this file asks its own fakes alone.
delete process.env.AGENTRUN_SERVE_FAUX_NO_OLLAMA;

const PLAIN = "synth-plain:1b";
const TOOLS = "synth-tools:2b";
// A provider key's shape, built at run time so the source holds no literal key (export:source reads none).
const SECRET = ["sk", "responses-wire", "0123456789abcdef"].join("-");
const redact = (text) => text.split(SECRET).join("[redacted]");

const READ = { type: "function", name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const ASK = { model: TOOLS, stream: true, store: false, instructions: "You review code.", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Review a.ts." }] }], tools: [READ], tool_choice: "auto", parallel_tool_calls: false, max_output_tokens: 256 };

/** The Responses fetch over `tag`'s route on the fake Ollama `ollama`: the route's Messages translation, wrapped. */
async function responsesOn(ollama, tag) {
  const route = await routeOf(`ollama/${tag}`, { OLLAMA_HOST: ollama.host }, "default", undefined, undefined, redact);
  return responsesFetch(route.fetch, { reasons: tag === TOOLS });
}

/** `body` sent to `fetcher` as codex's and opencode's proxies send it: its status, its text and its events' data. */
async function answerOf(fetcher, body) {
  const response = await fetcher(`${ROUTE_ORIGIN}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, events: text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))) };
}

const ofType = (events, type) => events.filter((event) => event.type === type);

const RESPONSES = "openai-responses";
/** Every model key the default could come from, and the settings that would put another model first: none of them set. */
const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PARTICLE_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "AGENTRUN_FREE_MODEL_REQUESTS"];
const ollamaRef = (tag) => ({ provider: "ollama", modelId: tag });
const NO_CATALOG = { getModel: () => undefined };

/** An env with no key, the fake Ollama its OLLAMA_HOST, and a data directory of its own. */
async function onOllama(t, options = {}) {
  withEnv(t, {}, KEYS);
  const ollama = await fakeOllama(t, options);
  return { ollama, env: { OLLAMA_HOST: ollama.host, AGENTRUN_SERVE_DATA: await scratch(t) } };
}

test("a tool call comes back as a function_call item, streamed, then response.completed with the usage; the request carries num_ctx and the tools", async (t) => {
  const ollama = await fakeOllama(t, { reply: () => ({ calls: [{ name: "read", arguments: { path: "a.ts" } }], usage: { input: 40, output: 7 } }) });
  const { status, events } = await answerOf(await responsesOn(ollama, TOOLS), ASK);
  assert.equal(status, 200);
  assert.equal(events[0].type, "response.created");
  const added = ofType(events, "response.output_item.added").map((event) => event.item);
  const done = ofType(events, "response.output_item.done").map((event) => event.item);
  const call = done.find((item) => item.type === "function_call");
  assert.ok(call, JSON.stringify(done));
  assert.equal(call.name, "read");
  assert.deepEqual(JSON.parse(call.arguments), { path: "a.ts" });
  assert.match(call.call_id, /^[A-Za-z0-9_-]+$/);
  assert.equal(call.status, "completed");
  assert.ok(added.some((item) => item.type === "function_call" && item.call_id === call.call_id), "the call's item added before it is done");
  assert.equal(ofType(events, "response.function_call_arguments.done")[0].arguments, call.arguments);
  const end = events.at(-1);
  assert.equal(end.type, "response.completed");
  assert.equal(end.response.status, "completed");
  assert.deepEqual(end.response.usage, { input_tokens: 40, input_tokens_details: { cached_tokens: 0 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 47 });
  assert.ok(end.response.output.some((item) => item.type === "function_call" && item.call_id === call.call_id), "the final response holds the call");
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, i) => i), "numbered in order");
  const sent = ollama.got.chat[0];
  assert.equal(sent.options?.num_ctx, 65_536, "the model's context asked on every request, as on pi's route");
  assert.deepEqual(sent.tools?.map((tool) => tool.function?.name), ["read"]);
  assert.equal(sent.messages[0].role, "system");
  assert.match(sent.messages[0].content, /You review code\./);
});

test("an answer cut at its output limit ends response.incomplete (max_output_tokens) with its usage, which codex's and opencode's policies book, and codex's reads as a cut", async (t) => {
  const ollama = await fakeOllama(t, { reply: () => ({ text: "The weather in Paris is 18", doneReason: "length", usage: { input: 30, output: 256 } }) });
  const { text, events } = await answerOf(await responsesOn(ollama, TOOLS), ASK);
  const end = events.at(-1);
  assert.equal(end.type, "response.incomplete", events.map((event) => event.type).join(" "));
  assert.equal(end.response.status, "incomplete");
  assert.deepEqual(end.response.incomplete_details, { reason: "max_output_tokens" });
  assert.equal(end.response.usage.output_tokens, 256);
  assert.equal(ofType(events, "response.completed").length, 0);
  assert.equal(ofType(events, "response.output_text.done")[0].text, "The weather in Paris is 18");
  // What each proxy books for it: the tokens it used, never nothing.
  const codex = codexPolicy({ model: TOOLS, tools: ["read"] });
  assert.deepEqual(codex.usageOf(text), { input: 30, output: 256, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  assert.deepEqual(codex.cut(text, []), { outputTokens: 256 }, "codex's policy reads it as an answer cut at its limit");
  const opencode = openCodePolicy({ model: TOOLS, tools: ["read"] });
  assert.deepEqual(opencode.usageOf(text), { input: 30, output: 256, cacheRead: 0, cacheWrite: 0 });
});

test("a replayed turn: its reasoning (OpenAI's encrypted one too) is dropped, never refused; its function_call and function_call_output reach Ollama as the assistant's tool call and the tool's message", async (t) => {
  const ollama = await fakeOllama(t, { reply: () => ({ text: "a.ts is fine." }) });
  const replay = {
    ...ASK,
    include: ["reasoning.encrypted_content"],
    input: [
      ...ASK.input,
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Read the file first." }], encrypted_content: "gAAAAABpZ-opaque-openai-blob" },
      { type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "Then answer." }] },
      { type: "function_call", id: "fc_1", call_id: "call_abc123", name: "read", arguments: "{\"path\":\"a.ts\"}" },
      { type: "function_call_output", call_id: "call_abc123", output: "export const a = 1;" },
    ],
  };
  const { events } = await answerOf(await responsesOn(ollama, TOOLS), replay);
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(ofType(events, "response.output_text.done")[0].text, "a.ts is fine.");
  const sent = ollama.got.chat[0].messages;
  assert.deepEqual(sent.map((message) => message.role), ["system", "user", "assistant", "tool"]);
  assert.deepEqual(sent[2].tool_calls?.map((call) => [call.function?.name, call.function?.arguments]), [["read", { path: "a.ts" }]]);
  assert.equal(sent[2].thinking, undefined, "replayed reasoning is not sent back");
  assert.ok(!JSON.stringify(ollama.got.chat[0]).includes("opaque-openai-blob") && !JSON.stringify(ollama.got.chat[0]).includes("Then answer."), "no reasoning reaches Ollama");
  assert.equal(sent[3].tool_name, "read", "the output names the tool its call named");
  assert.equal(sent[3].content, "export const a = 1;");
});

test("a model that takes tools as text: its tools in its prompt, and the call it writes comes back as a function_call item", async (t) => {
  const ollama = await fakeOllama(t, { reply: () => ({ text: '<tool_call>{"name":"read","arguments":{"path":"b.ts"}}</tool_call>' }) });
  const { events } = await answerOf(await responsesOn(ollama, PLAIN), { ...ASK, model: PLAIN });
  const call = ofType(events, "response.output_item.done").map((event) => event.item).find((item) => item.type === "function_call");
  assert.ok(call, JSON.stringify(events.map((event) => event.type)));
  assert.equal(call.name, "read");
  assert.deepEqual(JSON.parse(call.arguments), { path: "b.ts" });
  assert.equal(events.at(-1).type, "response.completed");
  const sent = ollama.got.chat[0];
  assert.equal(sent.tools, undefined, "no tools parameter for a model that takes none");
  assert.match(sent.messages[0].content, /read/);
});

test("reasoning comes back as a reasoning item's summary, through the run's redactor; a failed answer is response.failed, redacted", async (t) => {
  const ollama = await fakeOllama(t, { reply: (_body, n) => (n === 1 ? { thinking: `The key is ${SECRET}.`, text: "Done." } : { status: 500, error: `upstream refused ${SECRET}` }) });
  const fetcher = await responsesOn(ollama, TOOLS);
  const thought = await answerOf(fetcher, ASK);
  const reasoning = ofType(thought.events, "response.output_item.done").map((event) => event.item).find((item) => item.type === "reasoning");
  assert.ok(reasoning, JSON.stringify(thought.events.map((event) => event.type)));
  assert.equal(reasoning.summary[0].text, "The key is [redacted].");
  assert.ok(!thought.text.includes("encrypted_content"), "this route writes no encrypted reasoning: its own reasoning items carry a summary alone");
  assert.ok(!thought.text.includes(SECRET), "the secret nowhere in the answer");
  const failed = await answerOf(fetcher, ASK);
  const end = failed.events.at(-1);
  assert.equal(end.type, "response.failed", failed.events.map((event) => event.type).join(" "));
  assert.equal(end.response.status, "failed");
  assert.match(end.response.error.message, /\[redacted\]/);
  assert.ok(!failed.text.includes(SECRET));
});

test("what the route does not take is refused with a 400 naming it, and Ollama is never asked: a custom tool or its call, local_shell, web_search, store or a stored item or a previous response, an image by URL", async (t) => {
  const ollama = await fakeOllama(t);
  const fetcher = await responsesOn(ollama, TOOLS);
  const refusals = [
    [{ ...ASK, tools: [READ, { type: "custom", name: "apply_patch", description: "Patch files.", format: { type: "grammar" } }] }, /custom/],
    [{ ...ASK, input: [...ASK.input, { type: "item_reference", id: "msg_1" }] }, /item_reference/],
    [{ ...ASK, input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.png" }] }] }, /data URL/],
    [{ ...ASK, input: [...ASK.input, { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "x" }] }, /custom_tool_call/],
    [{ ...ASK, previous_response_id: "resp_1" }, /previous_response_id/],
    [{ ...ASK, store: true }, /store/],
    [{ ...ASK, tools: [READ, { type: "local_shell" }] }, /local_shell/],
    [{ ...ASK, tools: [READ, { type: "web_search" }] }, /web_search/],
  ];
  for (const [body, words] of refusals) {
    const { status, text } = await answerOf(fetcher, body);
    assert.equal(status, 400, text);
    assert.match(JSON.parse(text).error.message, words);
  }
  assert.equal(ollama.got.chat.length, 0, "no refused request reached Ollama");
});

// The edge reads the route's own Messages stream; a part of it that does not read is a failed response with words of its
// own, never the part's raw text and never a throw out of the fetch (as PR 1's wholeOf answers a Messages client).
test("a Messages stream that does not read (a data line not JSON, a body that breaks mid-read) is response.failed with words, or a 500 when asked whole (as PR 1's wholeOf answers a Messages client); never its raw text, never a throw", async () => {
  const sse = (...events) => events.map(([event, data]) => `event: ${event}\ndata: ${data}\n\n`).join("");
  const start = ["message_start", JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: TOOLS, content: [], usage: { input_tokens: 3, output_tokens: 0 } } })];
  const notJson = () => new Response(sse(start, ["content_block_start", `{not json ${SECRET}`]), { status: 200, headers: { "content-type": "text/event-stream" } });
  const broken = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse(start))); controller.error(new Error(`socket hang up ${SECRET}`)); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  for (const [what, answer] of Object.entries({ "a data line not JSON": notJson, "a body that breaks mid-read": broken })) {
    const fetcher = responsesFetch(async () => answer());
    const { status, text, events } = await answerOf(fetcher, ASK);
    assert.equal(status, 200, what);
    assert.equal(events.at(-1).type, "response.failed", `${what}: ${text}`);
    assert.match(events.at(-1).response.error.message, /could not be read/, what);
    assert.doesNotMatch(text, new RegExp(SECRET), `${what}: the part's own text is never said`);
    const whole = await answerOf(fetcher, { ...ASK, stream: false });
    assert.equal(whole.status, 500, `${what}: ${whole.text}`);
    assert.match(JSON.parse(whole.text).error.message, /could not be read/, what);
    assert.doesNotMatch(whole.text, new RegExp(SECRET), what);
  }
});

test("stream: false gets the final response as one JSON body", async (t) => {
  const ollama = await fakeOllama(t, { reply: () => ({ calls: [{ name: "read", arguments: { path: "c.ts" } }], usage: { input: 9, output: 2 } }) });
  const response = await (await responsesOn(ollama, TOOLS))(`${ROUTE_ORIGIN}/v1/responses`, { method: "POST", body: JSON.stringify({ ...ASK, stream: false }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "response");
  assert.equal(body.status, "completed");
  assert.deepEqual(body.output.filter((item) => item.type === "function_call").map((item) => [item.name, JSON.parse(item.arguments)]), [["read", { path: "c.ts" }]]);
  assert.equal(body.usage.input_tokens, 9);
  assert.equal(body.store, false, "nothing is stored here");
});

test("side requests land on the routed model: codex's and opencode's policies set every body's model to the session's, and the route answers on its own model whatever id a body names", async (t) => {
  const ollama = await fakeOllama(t, { reply: () => ({ text: "A title." }) });
  const fetcher = await responsesOn(ollama, TOOLS);
  // A title or compaction request names a model of codex's own; opencode's small model is the session's (config.ts).
  const side = { model: "gpt-5.4-mini", stream: true, store: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Name this thread." }] }], tools: [] };
  const codex = codexPolicy({ model: TOOLS, tools: [] });
  const opencode = openCodePolicy({ model: TOOLS, tools: [] });
  const applied = [await codex.apply(structuredClone(side), { method: "POST", path: "/v1/responses" }), await opencode.apply(structuredClone(side), { method: "POST", path: "/v1/responses" })];
  for (const body of applied) assert.equal(body.model, TOOLS, "the body names the session's model");
  // And a body that still named another id is answered on the route's own model all the same.
  for (const body of [...applied, side]) {
    const { events } = await answerOf(fetcher, body);
    assert.equal(events.at(-1).type, "response.completed");
  }
  assert.deepEqual(ollama.got.chat.map((sent) => sent.model), [TOOLS, TOOLS, TOOLS], "every request reached Ollama on the routed model");
});

test("the wire decides: codex and opencode on Responses get an Ollama model's provider as the route's origin with no key, its tag the model, priced at its own entry; no other provider is routed, nor a plan's harness", async (t) => {
  const { env } = await onOllama(t);
  assert.equal(routed(RESPONSES, ollamaRef(TOOLS)), true);
  assert.equal(routed("plan", ollamaRef(TOOLS)), false, "a harness on its own plan: no route of ours");
  for (const provider of ["openai", "openrouter", "anthropic"]) assert.equal(routed(RESPONSES, { provider }), false, provider);
  assert.ok(RESPONSES in WIRES);
  // Any harness on the wire alike, built in or not: the harness's id is never asked.
  for (const id of ["codex", "opencode", "a-module-on-responses"]) {
    const provider = providerFor(RESPONSES, env, ollamaRef(TOOLS), id);
    assert.equal(provider.origin, ROUTE_ORIGIN, id);
    assert.equal(provider.modelId, TOOLS, id);
    assert.deepEqual(provider.priceModel, ollamaRef(TOOLS), id);
    assert.equal(typeof provider.fetch, "function", `${id}: the route's own fetch`);
    assert.equal(provider.credential(), "model-route", `${id}: no key`);
  }
  // Behind serve's gateway every request is the gateway's: no route of serve's own.
  const gateway = { ...env, AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL: "synth-gateway", AGENT_MODEL_API_KEY: "fake-test-key" };
  assert.notEqual(providerFor(RESPONSES, gateway, ollamaRef(TOOLS), "codex").origin, ROUTE_ORIGIN);
});

test("the cap counts an Ollama model's requests on codex and opencode as local, at $0, never toward the free-model limit; OpenAI's model on its key is not local", async (t) => {
  const { env } = await onOllama(t);
  for (const id of ["codex", "opencode"]) {
    assert.ok(harnessOf(env, id).runs(env, `ollama/${TOOLS}`), `${id} runs the tag`);
    const capped = await cliCapModel(harnessOf(env, id), env, `ollama/${TOOLS}`);
    assert.equal(capped.local, true, `${id}: ${JSON.stringify(capped)}`);
  }
  const keyed = { ...env, OPENAI_API_KEY: "fake-test-key" };
  assert.notEqual((await cliCapModel(harnessOf(keyed, "codex"), keyed, "openai/gpt-6.1-sol")).local, true);
});

test("the trust rules are the route's, unchanged on Responses: a shared server with no OLLAMA_HOST asks no Ollama, and an OLLAMA_HOST in plain http off this machine is refused", async (t) => {
  withEnv(t, {}, KEYS);
  assert.equal(ollamaHostOf({}, false), undefined, "a shared server never asks the default address");
  const shared = { AGENTRUN_SERVE_DATA: await scratch(t) };
  const none = await modelOn(RESPONSES, shared, `ollama/${TOOLS}`, "codex");
  assert.equal("model" in none, false, JSON.stringify(none));
  assert.doesNotMatch((await modelOn(RESPONSES, shared, undefined, "codex")).why, /Ollama/, "no Ollama here: its words name a key");
  const remote = { OLLAMA_HOST: "http://10.20.30.40:11434", AGENTRUN_SERVE_DATA: await scratch(t) };
  const refused = await modelOn(RESPONSES, remote, `ollama/${TOOLS}`, "opencode");
  assert.equal("model" in refused, false, JSON.stringify(refused));
  // With no Ollama answering on the machine's own address, codex is told to start one, as pi is.
  const down = { OLLAMA_HOST: `127.0.0.1:${await closedPort()}`, AGENTRUN_SERVE_DATA: await scratch(t) };
  assert.match((await modelOn(RESPONSES, down, undefined, "codex")).why, /start Ollama and pull a model with tools/);
});

test("codex and opencode on an Ollama model: each adapter is handed the route's fetch for its proxies, and codex offers no live web search, which the translation cannot run", { timeout: 60_000 }, async (t) => {
  const { env } = await onOllama(t);
  const plane = { [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "native" }) };
  const chosen = await modelOn(RESPONSES, env, `ollama/${TOOLS}`, "codex");
  assert.deepEqual(chosen.model, ollamaRef(TOOLS), JSON.stringify(chosen));
  const needs = { model: chosen.model, models: NO_CATALOG };

  const codex = await import("@parcha/agentrun-harness-codex");
  let seen;
  const loadCodex = async () => ({ ...codex, codexAdapter: (options) => ((seen = options), { id: "codex" }) });
  const standIn = { [adapters.CODEX_STANDIN_ENV]: JSON.stringify({ command: "true" }) };
  await adapters.codexOf({ ...env, ...plane, ...standIn, AGENTRUN_SERVE_DATA: await harnessData(t) }, needs, loadCodex);
  assert.equal(seen.model, TOOLS);
  assert.equal(seen.provider.origin, ROUTE_ORIGIN);
  assert.equal(typeof seen.fetch, "function", "codex's proxies forward with the route's fetch");
  assert.equal(seen.webSearch, undefined, "no live web search on the route");
  // The same settings on OpenAI's own model do offer it: the check above is the route's, not the settings'.
  const keyed = { ...env, ...plane, ...standIn, OPENAI_API_KEY: "fake-test-key", AGENTRUN_SERVE_DATA: await harnessData(t) };
  await adapters.codexOf(keyed, { model: { provider: "openai", modelId: "gpt-6.1-sol" }, models: NO_CATALOG }, loadCodex);
  assert.equal(seen.webSearch, "live");
  assert.equal(seen.fetch, undefined);

  const opencode = await import("../dist/harness-opencode/index.js");
  let opened;
  const loadOpenCode = async () => ({ ...opencode, openCodeAdapter: (options) => ((opened = options), { id: "opencode" }) });
  await adapters.opencodeOf({ ...env, [adapters.OPENCODE_STANDIN_ENV]: JSON.stringify({ command: "true" }), AGENTRUN_SERVE_DATA: await harnessData(t) }, needs, loadOpenCode, false);
  assert.equal(opened.model, TOOLS);
  assert.equal(opened.provider.origin, ROUTE_ORIGIN);
  assert.equal(typeof opened.fetch, "function", "opencode's proxies forward with the route's fetch");
});

// What codex 0.164.0 sends for a model id that is not OpenAI's, through serve's proxy (recorded at a stand-in endpoint:
// its keys, its tools' and input items' shapes, never their text): every key is one the edge takes, its include
// (reasoning.encrypted_content) is read for nothing, and its developer messages are the system prompt. Its `tools` is
// empty because the recorded agent named no host tool: on a model Codex's catalog does not list, Codex offers each host
// tool as a function in `tools` (the classic shape, run-adapters-codex test/offer.mjs), never code mode's custom `exec`.
test("codex 0.164.0's own request, as recorded through serve's proxy on a model not OpenAI's, is taken whole: its keys, its include, its developer messages as the system prompt", async (t) => {
  const recorded = JSON.parse(await readFile(new URL("./fixtures/codex-0.164.0-responses-request-routed.json", import.meta.url), "utf8"));
  const values = { include: recorded.include, input: undefined, max_output_tokens: 256, model: TOOLS, parallel_tool_calls: false, prompt_cache_key: "thread-1", reasoning: { effort: "medium", summary: "auto" }, store: recorded.store, stream: recorded.stream, tool_choice: recorded.tool_choice, tools: recorded.tools.map((tool) => ({ ...tool, description: "a tool" })) };
  assert.deepEqual(Object.keys(values).sort(), recorded.keys, "the fixture's keys, each given a value");
  values.input = recorded.input.map(([type, role], at) => ({ type, role, content: [{ type: "input_text", text: `part ${at}` }] }));
  const ollama = await fakeOllama(t, { reply: () => ({ text: "done." }) });
  const { status, events } = await answerOf(await responsesOn(ollama, TOOLS), values);
  assert.equal(status, 200);
  assert.equal(events.at(-1).type, "response.completed", JSON.stringify(events.at(-1)));
  const sent = ollama.got.chat.at(-1);
  assert.deepEqual(sent.messages.map((message) => message.role), ["system", "user"], "two developer messages one system prompt, two user messages one turn");
  assert.match(sent.messages[0].content, /part 0[\s\S]*part 1/);
  assert.doesNotMatch(JSON.stringify(events), /encrypted_content/);
});

// Ollama cannot be made to call a tool (its chat takes no tool_choice), so a forced choice is refused with words, never
// run as "auto"; "auto" and "none" are taken as they are ("none": no tool reaches the model). Codex 0.164.0 and
// opencode 1.19.5 send "auto" on a turn (fixtures/codex-0.164.0-responses-request-routed.json).
test("tool_choice \"required\", or one naming a function, is refused with a 400, and Ollama is never asked; \"auto\" and \"none\" are taken", async (t) => {
  const ollama = await fakeOllama(t);
  const fetcher = await responsesOn(ollama, TOOLS);
  for (const [choice, words] of [["required", /tool_choice "required"/], [{ type: "function", name: "read" }, /tool_choice naming the function read/], [{ type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "read" }] }, /tool_choice "allowed_tools"/]]) {
    const { status, text } = await answerOf(fetcher, { ...ASK, tool_choice: choice });
    assert.equal(status, 400, text);
    const { error } = JSON.parse(text);
    assert.equal(error.type, "invalid_request_error", text);
    assert.match(error.message, words);
    assert.match(error.message, /is not taken on this model's route/);
  }
  assert.equal(ollama.got.chat.length, 0, "no refused request reached Ollama");
  assert.equal((await answerOf(fetcher, ASK)).status, 200);
  assert.deepEqual(ollama.got.chat[0].tools?.map((tool) => tool.function?.name), ["read"], "\"auto\": the tools reach the model");
  assert.equal((await answerOf(fetcher, { ...ASK, tool_choice: "none" })).status, 200);
  assert.equal(ollama.got.chat[1].tools, undefined, "\"none\": no tool reaches the model");
});

// Codex writes its window as model_context_window and opencode as the model's limit.context; each adapter's default is
// 272,000. On the route the model runs at the window every request asks Ollama for (options.num_ctx: the model's trained
// context, at most 64k, at most the host's OLLAMA_CONTEXT_LENGTH), so each harness is given that one figure: the run's
// pi-ai entry for the model, which the route's own model is (ollama-provider.ts contextOf).
test("codex and opencode on an Ollama model are given the window the route runs it at, the num_ctx it asks Ollama for, never their adapters' 272,000 default", { timeout: 60_000 }, async (t) => {
  const { ollama, env } = await onOllama(t);
  const { providerModels, ollamaTagsOf } = await import("../dist/model.js");
  const codex = await import("@parcha/agentrun-harness-codex");
  const opencode = await import("../dist/harness-opencode/index.js");
  let seen;
  let opened;
  const loadCodex = async () => ({ ...codex, codexAdapter: (options) => ((seen = options), { id: "codex" }) });
  const loadOpenCode = async () => ({ ...opencode, openCodeAdapter: (options) => ((opened = options), { id: "opencode" }) });
  const windows = async (extra, tag) => {
    const runEnv = { ...env, ...extra, AGENTRUN_SERVE_DATA: await harnessData(t) };
    const chosen = await modelOn(RESPONSES, runEnv, `ollama/${tag}`, "codex");
    assert.deepEqual(chosen.model, ollamaRef(tag), JSON.stringify(chosen));
    // The run's models as a CLI claim reads them (cli-run-spec.ts modelsOf): pi-ai's, with this Ollama's tag.
    const needs = { model: chosen.model, models: await providerModels(runEnv, { ollama: ollamaTagsOf([chosen.model]) }) };
    await adapters.codexOf({ ...runEnv, [adapters.CODEX_STANDIN_ENV]: JSON.stringify({ command: "true" }) }, needs, loadCodex);
    await adapters.opencodeOf({ ...runEnv, [adapters.OPENCODE_STANDIN_ENV]: JSON.stringify({ command: "true" }) }, needs, loadOpenCode, false);
    // One request through codex's own fetch: the num_ctx the route asks Ollama for.
    const asked = ollama.got.chat.length;
    assert.equal((await answerOf(seen.fetch, { ...ASK, model: tag })).status, 200);
    return { codex: seen.contextWindow, opencode: opened.contextWindow, numCtx: ollama.got.chat[asked].options?.num_ctx };
  };
  // A qwen3:8b-shaped model, trained on 40,960, under the route's 64k bound.
  assert.deepEqual(await windows({}, PLAIN), { codex: 40_960, opencode: 40_960, numCtx: 40_960 });
  // One trained on 131,072: the route's 64k bound.
  assert.deepEqual(await windows({}, TOOLS), { codex: 65_536, opencode: 65_536, numCtx: 65_536 });
  // A host that set OLLAMA_CONTEXT_LENGTH lower: that.
  assert.deepEqual(await windows({ OLLAMA_CONTEXT_LENGTH: "8192" }, TOOLS), { codex: 8_192, opencode: 8_192, numCtx: 8_192 });
  // OpenAI's own model, not routed: its adapter's own window, as before.
  const keyed = { ...env, OPENAI_API_KEY: "fake-test-key", AGENTRUN_SERVE_DATA: await harnessData(t), [adapters.CODEX_STANDIN_ENV]: JSON.stringify({ command: "true" }) };
  await adapters.codexOf(keyed, { model: { provider: "openai", modelId: "gpt-6.1-sol" }, models: await providerModels(keyed) }, loadCodex);
  assert.equal(seen.contextWindow, undefined);
});
