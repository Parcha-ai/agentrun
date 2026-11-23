// The openai-responses wire on a translated model (runner/responses-fetch.ts): a Responses request answered through the
// route's own Messages translation (model-route.ts messagesFetch), so an Ollama model runs on the wire codex and opencode
// speak as it runs on pi's: options.num_ctx on every request, tools as text for a model that takes none, errors and
// reasoning through the run's redactor. A tool call comes back as a function_call item; an answer cut at its output
// limit ends response.incomplete with its usage, which codex's and opencode's proxy policies book (and codex's reads as
// a cut, so the harness ends the turn rather than asking again); a replayed turn's call and output reach Ollama as its
// own tool call and tool message. A custom tool or a stored item is refused, never dropped. All against a fake Ollama on
// loopback (fixtures/fake-ollama.mjs); no real Ollama is asked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTE_ORIGIN } from "@parcha/agentrun-kernel/host";
import { codexPolicy } from "@parcha/agentrun-harness-codex";
import { fakeOllama } from "./fixtures/fake-ollama.mjs";

const { routeOf } = await import("../dist/runner/model-route.js");
const { responsesFetch } = await import("../dist/runner/responses-fetch.js");
const { openCodePolicy } = await import("../dist/harness-opencode/host/policy.js");

// The suites turn every Ollama off (support.mjs, OLLAMA_OFF_ENV); this file asks its own fakes alone.
delete process.env.AGENTRUN_SERVE_FAUX_NO_OLLAMA;

const PLAIN = "synth-plain:1b";
const TOOLS = "synth-tools:2b";
const SECRET = "sk-responses-wire-0123456789abcdef";
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
