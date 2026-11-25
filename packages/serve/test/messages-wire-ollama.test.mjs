// Ollama models on every harness of Anthropic's Messages (claude-agent, Goose, a harness module on that wire), on the
// runner's own translation (runner/model-route.ts), as pi runs them. The rule is data (wires.ts TRANSLATED): a model's
// provider names the wires the route translates it onto, and a harness on one of them runs it, whatever its id. Its
// requests go to the route's origin with no key, through the route's fetch: native /api/chat, options.num_ctx, its tools
// as text where it takes them so, $0, and never counted toward the free-model limit. What a Messages client asks beyond
// pi-ai is answered in the translation: its token count, an answer not streamed, every model id it sends (its small
// model's too), and fields the translation does not run (context_management, output_config, deferred tools and tool
// references) never sent on. All against a fake Ollama on loopback (fixtures/fake-ollama.mjs); no real Ollama is asked.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ROUTE_ORIGIN } from "@parcha/agentrun-kernel/host";
import { facts as claudeFacts } from "@parcha/agentrun-harness-claude/facts";
import * as adapters from "../dist/adapters.js";
import { fakeOllama } from "./fixtures/fake-ollama.mjs";
import { freePort } from "./fixtures/ports.mjs";
import { installGoose, needsGoose } from "./fixtures/goose-installed.mjs";
import { messagesLaunches, messagesModule, MESSAGES_MODULE } from "./fixtures/messages-module.mjs";
import { agent, follow, harnessData, runDir, scratch, serve, serverLog, withEnv } from "./support.mjs";

const { HarnessUnavailable, modelOn, providerFor } = await import("../dist/provider.js");
const { harnessOf, HARNESS_MODULES_ENV } = await import("../dist/harness-table.js");
const { routed, WIRES } = await import("../dist/wires.js");
const { cliCapModel, factsOn } = await import("../dist/runner/cli-run-spec.js");
const { TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");

// The suites turn every Ollama off (support.mjs, OLLAMA_OFF_ENV); this file asks its own fakes alone.
delete process.env.AGENTRUN_SERVE_FAUX_NO_OLLAMA;

const PLAIN = "synth-plain:1b";
const TOOLS = "synth-tools:2b";
const MESSAGES = "anthropic-messages";
/** Every model key the default could come from, and the settings that would put another model first: none of them set. */
const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PARTICLE_API_KEY", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "AGENTRUN_FREE_MODEL_REQUESTS"];
const ollamaRef = (tag) => ({ provider: "ollama", modelId: tag });
const NO_CATALOG = { getModel: () => undefined };

const READ = { name: "read", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
/** A Messages request as a client on the wire sends one: `model` whatever id it names, `extra` its own fields. */
const request = (extra = {}) => ({ model: "claude-sonnet-5-5", max_tokens: 256, stream: true, system: "You review code.", tools: [READ], messages: [{ role: "user", content: "Review a.ts." }], ...extra });
const post = (send, body, path = "/v1/messages?beta=true") => send(`${ROUTE_ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", "anthropic-beta": "context-management-2025-06-27,interleaved-thinking-2025-05-14" }, body: JSON.stringify(body) });
const eventsOf = async (response) => (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));

/** An env with the harness module on Messages loaded, the fake Ollama its OLLAMA_HOST, and nothing else. */
async function onOllama(t, options = {}) {
  withEnv(t, {}, KEYS);
  const ollama = await fakeOllama(t, options);
  const env = { OLLAMA_HOST: ollama.host, AGENTRUN_SERVE_DATA: await scratch(t), [HARNESS_MODULES_ENV]: JSON.stringify([messagesModule(await scratch(t))]) };
  return { ollama, env };
}

/** The module's launch for `tag`, as serve builds its adapter for a run: the launch it was handed. */
async function moduleLaunch(env, tag) {
  const before = messagesLaunches().length;
  await harnessOf(env, MESSAGES_MODULE).adapter(env, { model: ollamaRef(tag), models: NO_CATALOG });
  assert.equal(messagesLaunches().length, before + 1, "the module was launched once");
  return messagesLaunches().at(-1);
}

test("the rule is data: the route translates an Ollama model onto Anthropic's Messages and OpenAI's Responses and onto no other wire (a plan's); no other provider, nor a name off the object's prototype", () => {
  assert.deepEqual(Object.keys(WIRES).filter((wire) => routed(wire, { provider: "ollama" })), [MESSAGES, "openai-responses"]);
  assert.equal(routed("plan", { provider: "ollama" }), false, "a harness on its own plan");
  for (const provider of ["anthropic", "openai", "openrouter", "particle", "constructor", "toString", "__proto__", ""]) {
    assert.deepEqual(Object.keys(WIRES).filter((wire) => routed(wire, { provider })), [], provider);
  }
});

test("on every harness of the wire, built-in or a module's, an Ollama model's provider is the route's origin with no key, its tag the model, priced at its own entry", async (t) => {
  const { env } = await onOllama(t);
  for (const id of ["claude-agent", "goose", MESSAGES_MODULE]) {
    const provider = providerFor(MESSAGES, env, ollamaRef(TOOLS), id);
    assert.equal(provider.origin, ROUTE_ORIGIN, id);
    assert.equal(provider.modelId, TOOLS, id);
    assert.deepEqual(provider.priceModel, ollamaRef(TOOLS), id);
    assert.equal(typeof provider.fetch, "function", `${id}: the route's own fetch`);
    assert.equal(provider.credential(), "model-route", `${id}: no key`);
  }
  // Behind serve's gateway every request is the gateway's: no route of serve's own, so an Ollama model is refused there.
  const gateway = { ...env, AGENT_MODEL_BASE_URL: "http://127.0.0.1:9/v1", AGENT_MODEL: "synth-gateway", AGENT_MODEL_API_KEY: "fake-test-key" };
  for (const id of ["claude-agent", MESSAGES_MODULE]) assert.throws(() => providerFor(MESSAGES, gateway, ollamaRef(TOOLS), id), (error) => error instanceof HarnessUnavailable, `${id} behind the gateway`);
});

test("a harness module on Messages is handed the route's fetch: its requests reach the fake's /api/chat with num_ctx, its tools native on a tools model and as text on one without", async (t) => {
  const { ollama, env } = await onOllama(t);
  const tools = await moduleLaunch(env, TOOLS);
  assert.equal(tools.model, TOOLS);
  assert.equal(tools.provider.origin, ROUTE_ORIGIN);
  assert.equal(typeof tools.fetch, "function", "ModuleLaunch.fetch: the module's proxy forwards with it");
  const native = await eventsOf(await post(tools.fetch, request()));
  assert.equal(native.at(-1)?.type, "message_stop", JSON.stringify(native));
  const toolsBody = ollama.got.chat.at(-1);
  assert.equal(toolsBody.model, TOOLS);
  assert.equal(toolsBody.options?.num_ctx, 65_536, "trained on 131,072: 64k");
  assert.deepEqual(toolsBody.tools?.map((tool) => tool.function.name), ["read"]);

  const plain = await moduleLaunch(env, PLAIN);
  await eventsOf(await post(plain.fetch, request()));
  const plainBody = ollama.got.chat.at(-1);
  assert.equal(plainBody.model, PLAIN);
  assert.equal(plainBody.options?.num_ctx, 40_960, "its own trained context");
  assert.equal("tools" in plainBody, false, "tools as text");
  assert.match(plainBody.messages[0].content, /<functions>/);
});

test("Messages' token count is answered on the route, never run on the model: input_tokens from the body, and nothing reaches /api/chat", async (t) => {
  const { ollama, env } = await onOllama(t);
  const { fetch: send } = await moduleLaunch(env, TOOLS);
  const body = request({ stream: undefined });
  const counted = await post(send, body, "/v1/messages/count_tokens?beta=true");
  assert.equal(counted.status, 200);
  assert.match(counted.headers.get("content-type") ?? "", /application\/json/);
  const { input_tokens } = await counted.json();
  assert.equal(input_tokens, Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4));
  assert.equal(ollama.got.chat.length, 0, "the model was never asked");
});

test("a request with no `stream: true` gets its answer whole, one JSON message as Messages writes it: its text, a tool call's input parsed, its stop and usage", async (t) => {
  let n = 0;
  const { ollama, env } = await onOllama(t, { reply: () => (++n === 1 ? { text: "Done.", usage: { input: 20, output: 3 } } : { calls: [{ name: "read", arguments: { path: "a.ts" } }], usage: { input: 30, output: 4 } }) });
  const { fetch: send } = await moduleLaunch(env, TOOLS);
  const text = await post(send, request({ stream: false }));
  assert.equal(text.status, 200);
  assert.match(text.headers.get("content-type") ?? "", /application\/json/);
  const said = await text.json();
  assert.equal(said.type, "message");
  assert.equal(said.role, "assistant");
  assert.deepEqual(said.content, [{ type: "text", text: "Done." }]);
  assert.equal(said.stop_reason, "end_turn");
  assert.equal(said.usage?.output_tokens, 3);
  const call = await (await post(send, request({ stream: undefined }))).json();
  const use = call.content.find((block) => block.type === "tool_use");
  assert.deepEqual([use?.name, use?.input], ["read", { path: "a.ts" }], JSON.stringify(call));
  assert.equal(call.stop_reason, "tool_use");
  assert.equal(ollama.got.chat.length, 2);
});

// The whole answer is read from the route's own stream; a part of it that does not read (a data line that is not JSON, a
// tool call's input cut short) is a Messages error with words, as an error event is, never a throw out of the fetch.
test("an answer asked whole whose stream does not read (a data line not JSON, a tool input cut short) is a Messages error, 500 with words", async () => {
  const { forMessagesClients } = await import("../dist/runner/model-route.js");
  const sse = (...events) => events.map(([event, data]) => `event: ${event}\ndata: ${data}\n\n`).join("");
  const start = ["message_start", JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: TOOLS, content: [], usage: { input_tokens: 3, output_tokens: 0 } } })];
  const streams = {
    "a data line not JSON": sse(start, ["content_block_start", "{not json"]),
    "a tool input cut short": sse(start, ["content_block_start", JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } })], ["content_block_delta", JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": "a' } })], ["message_stop", JSON.stringify({ type: "message_stop" })]),
  };
  for (const [what, body] of Object.entries(streams)) {
    const send = forMessagesClients(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const answer = await send(`${ROUTE_ORIGIN}/v1/messages`, { method: "POST", body: JSON.stringify(request({ stream: false })) });
    assert.equal(answer.status, 500, what);
    const said = await answer.json();
    assert.equal(said.type, "error", what);
    assert.equal(said.error?.type, "api_error", what);
    assert.match(said.error?.message ?? "", /could not be read whole/, what);
  }
});

test("every model id a Messages client sends (its default, its small model's, any other) lands on the one Ollama route: the request runs the route's tag", async (t) => {
  const { ollama, env } = await onOllama(t);
  const { fetch: send } = await moduleLaunch(env, TOOLS);
  for (const model of [TOOLS, "claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-sonnet-5-5[1m]", ""]) {
    await eventsOf(await post(send, request({ model })));
    assert.equal(ollama.got.chat.at(-1).model, TOOLS, `sent as ${JSON.stringify(model)}`);
  }
});

test("guard: what the translation does not run is never sent on to Ollama: context_management, output_config, deferred tools (defer_loading) and tool references", async (t) => {
  const { ollama, env } = await onOllama(t);
  const { fetch: send } = await moduleLaunch(env, TOOLS);
  const body = request({
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    output_config: { effort: "high" },
    tools: [READ, { ...READ, name: "lookup", defer_loading: true }],
    messages: [
      { role: "user", content: "Review a.ts." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "tool_search", input: { query: "lookup" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "tool_reference", tool_name: "lookup" }] }] },
    ],
  });
  const events = await eventsOf(await post(send, body));
  assert.equal(events.at(-1)?.type, "message_stop", JSON.stringify(events));
  assert.doesNotMatch(JSON.stringify(ollama.got.chat.at(-1)), /context_management|clear_tool_uses|output_config|defer_loading|tool_reference/);
});

test("a tool_choice that forces a call (any, or one naming a tool) is refused with a 400 in Messages' words and never reaches Ollama, as is any other type; auto, none and none at all run as before, their tools sent", async (t) => {
  const { ollama, env } = await onOllama(t);
  const { fetch: send } = await moduleLaunch(env, TOOLS);
  const unkept = 'is not taken on this model\'s route: the model here cannot be made to call a tool, so send "auto"';
  const refusals = [
    [{ type: "any" }, `tool_choice "any" ${unkept}`],
    [{ type: "tool", name: "read" }, `tool_choice naming the tool read ${unkept}`],
    [{ type: "every" }, 'tool_choice "every" is not taken on this model\'s route: "auto" and "none" only'],
  ];
  for (const [choice, message] of refusals) {
    for (const stream of [true, undefined]) {
      const answer = await post(send, request({ tool_choice: choice, stream }));
      assert.equal(answer.status, 400, `${JSON.stringify(choice)}, stream ${stream}`);
      assert.deepEqual(await answer.json(), { type: "error", error: { type: "invalid_request_error", message } });
    }
  }
  assert.equal(ollama.got.chat.length, 0, "no refused request reached the model");
  for (const choice of [{ type: "auto" }, { type: "none" }, undefined]) {
    const events = await eventsOf(await post(send, request(choice ? { tool_choice: choice } : {})));
    assert.equal(events.at(-1)?.type, "message_stop", `${JSON.stringify(choice)}: ${JSON.stringify(events)}`);
    assert.deepEqual(ollama.got.chat.at(-1).tools?.map((tool) => tool.function.name), ["read"], `${JSON.stringify(choice)}: its tools reach the model`);
  }
  assert.equal(ollama.got.chat.length, 3);
});

test("the cap counts an Ollama model's requests as local on every harness of the wire, so they never count toward the free-model limit; a key's model is not local", async (t) => {
  const { env } = await onOllama(t);
  for (const id of ["claude-agent", MESSAGES_MODULE]) {
    const capped = await cliCapModel(harnessOf(env, id), env, `ollama/${TOOLS}`);
    assert.equal(capped.local, true, `${id}: ${JSON.stringify(capped)}`);
  }
  const keyed = { ...env, ANTHROPIC_API_KEY: "fake-test-key" };
  assert.notEqual((await cliCapModel(harnessOf(keyed, "claude-agent"), keyed, "anthropic/claude-sonnet-5-5")).local, true);
});

test("a run on a model the route translates gets its harness's facts with no tool search of its own (the host's offered in its place); any other model, or a harness with none, the facts as they are", () => {
  assert.equal(claudeFacts.ownToolSearch, true, "claude-agent's own facts: Claude Code's tool search");
  const routedFacts = factsOn(claudeFacts, ollamaRef(TOOLS));
  assert.equal("ownToolSearch" in routedFacts, false);
  assert.deepEqual({ ...routedFacts, ownToolSearch: true }, { ...claudeFacts }, "nothing else changed");
  assert.equal(factsOn(claudeFacts, { provider: "anthropic", modelId: "claude-sonnet-5-5" }), claudeFacts);
  assert.equal(factsOn(undefined, ollamaRef(TOOLS)), undefined, "pi: no facts");
});

test("claude-agent on an Ollama model: its CLI's one model is the tag (no small, fast or strong of another), its proxy forwards with the route's fetch to the route's origin, and no native web search", { timeout: 60_000 }, async (t) => {
  const { env } = await onOllama(t);
  const real = await import("@parcha/agentrun-harness-claude");
  let seen;
  const load = async () => ({ ...real, claudeAgentAdapter: (options) => ((seen = options), { id: "claude-agent" }) });
  const chosen = await modelOn(MESSAGES, env, `ollama/${TOOLS}`, "claude-agent");
  assert.deepEqual(chosen.model, ollamaRef(TOOLS), JSON.stringify(chosen));
  await adapters.claudeOf({ ...env, AGENTRUN_SERVE_DATA: await harnessData(t), [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "native" }) }, { model: chosen.model, models: NO_CATALOG }, load);
  assert.deepEqual(seen.model, { default: TOOLS }, "one model: Claude Code's small, fast and strong defaults all take it (env.ts durableEnv)");
  assert.equal(seen.smallModel, undefined);
  assert.equal(seen.provider?.origin, ROUTE_ORIGIN);
  assert.equal(typeof seen.fetch, "function");
  assert.equal(seen.webSearch, undefined, "the translation runs no provider search");
});

test("with no key and no Ollama, a harness on the wire says to start Ollama, as pi does", async (t) => {
  withEnv(t, {}, KEYS);
  const env = { OLLAMA_HOST: `127.0.0.1:${await freePort()}`, AGENTRUN_SERVE_DATA: await scratch(t) };
  const { why } = await modelOn(MESSAGES, env, undefined, "claude-agent");
  assert.match(why, /^No model yet for claude-agent: start Ollama and pull a model with tools, or add an OpenRouter or Anthropic key/, why);
  assert.match((await modelOn("openai-responses", env, undefined, "codex")).why, /^No model yet: start Ollama and pull a model with tools, or /, "codex, on Responses, the route's too");
});

test("a claude-agent run on an Ollama model, on the real Claude CLI through serve: its tool call writes the file, every request reaches /api/chat with num_ctx at the tag, $0, none counted toward a limit of 1, booked as ollama/<tag>", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const server = serverLog(t);
  withEnv(t, { AGENTRUN_FREE_MODEL_REQUESTS: "1" }, KEYS);
  // Keyed on the request, never on its count: the CLI's side requests (no tools) get a word, its turn the write, then
  // the answer once the write's result is back.
  const ollama = await fakeOllama(t, {
    reply: (body) => {
      const names = (body.tools ?? []).map((tool) => tool.function?.name);
      const answered = (body.messages ?? []).some((message) => message.role === "tool");
      if (answered) return { text: "Done." };
      if (names.includes("mcp__hands__write")) return { calls: [{ name: "mcp__hands__write", arguments: { path: "hello.md", content: "hello\n" } }] };
      return { text: "ok" };
    },
  });
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const { api, data } = await serve(t, { faux: undefined });
  const offer = (await api("GET", "/capabilities")).body.harnesses.find((harness) => harness.id === "claude-agent");
  assert.equal(offer.available, true, JSON.stringify(offer));
  assert.equal(offer.default_model, `ollama/${TOOLS}`);
  assert.equal((await api("POST", "/agents", agent("local-claude", { harness: "claude-agent", model: `ollama/${TOOLS}`, tools: ["write"] }))).status, 201);
  const run = await api("POST", "/agents/local-claude/runs", { input: { content: "Write hello.md saying hello." }, max_cost_usd: 1 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 150_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.equal(await readFile(join(runDir(data, run.body.run_id), "work", "hello.md"), "utf8"), "hello\n", "the model's call ran");
  assert.ok(ollama.got.chat.length >= 2, `past the limit of 1: ${ollama.got.chat.length} requests sent`);
  assert.deepEqual([...new Set(ollama.got.chat.map((body) => `${body.model} ${body.options?.num_ctx}`))], [`${TOOLS} 65536`], "every request at the tag, at 64k");
  assert.equal(view.cost?.usd, 0, JSON.stringify(view.cost));
  const lines = (await api("GET", `/runs/${run.body.run_id}/usage`)).body.lines.filter((line) => line.meter === "tokens");
  assert.deepEqual([...new Set(lines.map((line) => `${line.provider}/${line.model}`))], [`ollama/${TOOLS}`], "the id the run page labels local (Ollama)");
  assert.doesNotMatch(server.text(), /model proxy \(claude-agent\): refused/, "no request of the CLI's was refused at its proxy");
});

test("a Goose run on an Ollama model through serve: its requests reach /api/chat with num_ctx at the tag, $0, booked as ollama/<tag>", { skip: needsGoose || (!existsSync("/usr/bin/setpriv") && "no setpriv here"), timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_FREE_MODEL_REQUESTS: "1" }, KEYS);
  const ollama = await fakeOllama(t, { reply: () => ({ text: "GOOSE_RAN" }) });
  withEnv(t, { OLLAMA_HOST: ollama.host });
  const data = installGoose(join(await scratch(t), "agents"));
  const { api } = await serve(t, { data, faux: undefined });
  assert.equal((await api("POST", "/agents", agent("local-goose", { harness: "goose", model: `ollama/${TOOLS}` }))).status, 201);
  const run = await api("POST", "/agents/local-goose/runs", { input: { content: "SAY GOOSE_RAN" }, max_cost_usd: 1 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { rows } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 150_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.ok(rows.some((row) => row.kind === "final_answer" && row.text === "GOOSE_RAN"), JSON.stringify(rows).slice(0, 4000));
  assert.ok(ollama.got.chat.length >= 1);
  assert.deepEqual([...new Set(ollama.got.chat.map((body) => `${body.model} ${body.options?.num_ctx}`))], [`${TOOLS} 65536`]);
  assert.equal(view.cost?.usd, 0, JSON.stringify(view.cost));
  const lines = (await api("GET", `/runs/${run.body.run_id}/usage`)).body.lines.filter((line) => line.meter === "tokens");
  assert.deepEqual([...new Set(lines.map((line) => `${line.provider}/${line.model}`))], [`ollama/${TOOLS}`]);
});

// The Messages wire stays as #3619 proved it: what the Responses edge asks Ollama past the Messages body (a format, its
// sampling, no thinking) rides that edge's own in-process call (responses-fetch.ts EdgeAsks), so a Messages client's
// own temperature, top_p, output_config.format and effort "none" reach Ollama as they did: not at all.
test("guard: a Messages client's temperature, top_p, output_config.format and effort \"none\" never reach Ollama, with tools or without", async (t) => {
  const { ollama, env } = await onOllama(t);
  const { fetch: send } = await moduleLaunch(env, TOOLS);
  const asked = { temperature: 0.3, top_p: 0.5, thinking: { type: "disabled" }, output_config: { effort: "none", format: { type: "json_schema", schema: { type: "object" } } } };
  for (const body of [request(asked), request({ ...asked, tools: undefined })]) {
    const events = await eventsOf(await post(send, body));
    assert.equal(events.at(-1)?.type, "message_stop", JSON.stringify(events));
    const sent = ollama.got.chat.at(-1);
    assert.equal(sent.options?.temperature, undefined, "temperature");
    assert.equal(sent.options?.top_p, undefined, "top_p");
    assert.equal(sent.format, undefined, "format");
    assert.equal(sent.think, undefined, "think");
  }
  assert.equal(ollama.got.chat.length, 2);
});
