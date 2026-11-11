// Tools as text (runner/text-tools.ts) for a model whose catalog entry takes them so (local-models.ts `toolsAs`:
// OpenRouter's particle-1), on a translated route (runner/model-route.ts): the provider gets no `tools` parameter, the
// tools in the system prompt and every call and result in its history as DSML text, rebuilt the same way each turn; a
// reply's DSML invokes (zero-width spaces and all) or `<tool_call>` blocks come back as Messages tool_use blocks, the
// rest as text. Any other model gets its tools parameter as before. No network: the provider is a fetch that keeps what
// it was sent.
import assert from "node:assert/strict";
import { test } from "node:test";

const { messagesFetch, routeOf } = await import("../dist/runner/model-route.js");
const { callsOfText, toolsAsText } = await import("../dist/runner/text-tools.js");
const { providerModels } = await import("../dist/model.js");

const KEY = `not-a-secret-${"text-tools"}`;
const MODEL = "openrouter/particle-ai/particle-1";
/** An OpenRouter model on the same wire (openai-completions) whose catalog entry says nothing of its tools: native. */
const NATIVE = "openrouter/deepseek/deepseek-chat";
const TOOLS = [{ name: "read", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const REQUEST = {
  model: "route", max_tokens: 256, stream: true, system: "You review code.", tools: TOOLS,
  messages: [
    { role: "user", content: "Review it." },
    { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "const a = 1;" }] },
  ],
};

/** An upstream that keeps each body and answers `reply` as one streamed chat completion. */
function upstreamOf(reply, sent) {
  return async (_url, init = {}) => {
    sent.push(JSON.parse(String(init.body)));
    const chunk = (delta, finish, usage) => `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 0, model: "particle-ai/particle-1", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}`;
    return new Response([chunk({ role: "assistant", content: reply }, null), chunk({}, "stop", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }), "data: [DONE]", "", ""].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

/** The Messages events of `fetch`'s answer to REQUEST. */
async function eventsOf(fetch, origin = "https://model-route.invalid") {
  const response = await fetch(`${origin}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(REQUEST) });
  return (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
}

/** REQUEST on `model`'s route, its provider answering `reply`: what the provider was sent, and the Messages events. */
async function exchange(reply, model = MODEL) {
  const sent = [];
  const route = await routeOf(model, { OPENROUTER_API_KEY: KEY }, "default", undefined, upstreamOf(reply, sent));
  const events = await eventsOf(route.fetch, route.provider.origin);
  return { body: sent[0], events };
}

test("particle-1 routes as text tools by its catalog entry's toolsAs; another model, and the same model with no toolsAs, send the tools parameter", async () => {
  const models = await providerModels({ OPENROUTER_API_KEY: KEY });
  const particle = models.getModel("openrouter", "particle-ai/particle-1");
  const native = models.getModel("openrouter", "deepseek/deepseek-chat");
  assert.equal(particle.toolsAs, "text", "the model setting (local-models.ts)");
  assert.equal(native.toolsAs, undefined);
  assert.equal(native.api, particle.api, "the same wire: only the setting differs");
  assert.equal((await exchange("Done.", MODEL)).body.tools, undefined, "particle-1: no tools parameter");
  assert.equal((await exchange("Done.", NATIVE)).body.tools?.[0]?.function?.name, "read", "another model: its tools parameter");
  // The route reads the setting, not the model's id: particle-1's entry without it goes native, another's with it as text.
  for (const [target, asText] of [[{ ...particle, toolsAs: undefined }, false], [{ ...native, toolsAs: "text" }, true]]) {
    const sent = [];
    await eventsOf(messagesFetch(models, target, undefined, upstreamOf("Done.", sent)));
    assert.equal(sent[0].tools === undefined, asText, `${target.id} toolsAs=${target.toolsAs}`);
  }
});

test("as text: no tools parameter, the tools and the history as text, and a reply's call as tool_use", async () => {
  const { body, events } = await exchange('Next.\n\n<\u200b｜DSML｜ function_calls>\n<｜DSML｜invoke name="read">\n<｜DSML｜parameter name="path" string="true">b.ts</\u200b｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>');
  assert.equal(body.tools, undefined, "no tools parameter");
  assert.match(body.messages[0].content, /## Tools[\s\S]*<functions>\n\{"name":"read","description":"Read a file\.","parameters":\{"type":"object"/);
  assert.ok(body.messages.every((message) => message.role !== "tool" && !message.tool_calls), JSON.stringify(body.messages));
  const history = body.messages.map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("")).join("\n---\n");
  assert.match(history, /Reading\.\n\n<function_calls>\n<invoke name="read">\n<parameter name="path" string="true">a\.ts<\/parameter>\n<\/invoke>\n<\/function_calls>/);
  assert.match(history, /<function_results>\n<result tool="read">\nconst a = 1;\n<\/result>\n<\/function_results>/);
  const started = events.filter((event) => event.type === "content_block_start").map((event) => event.content_block.type);
  assert.deepEqual(started, ["text", "tool_use"]);
  assert.equal(events.find((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta").delta.partial_json, '{"path":"b.ts"}');
  assert.equal(events.find((event) => event.type === "message_delta").delta.stop_reason, "tool_use");
});

test("a model that takes its tools natively gets the tools parameter and its native calls, as before", async () => {
  const { body, events } = await exchange("Done.", NATIVE);
  assert.equal(body.tools?.[0]?.function?.name, "read");
  assert.ok(body.messages.some((message) => message.role === "tool"), "its history's results as tool messages");
  assert.equal(events.find((event) => event.type === "message_delta").delta.stop_reason, "end_turn");
});

test("a reply's blocks: calls in order, a block that is no JSON stays text, the history rebuilt the same each time", () => {
  assert.deepEqual(callsOfText('a <tool_call>{"name":"x","arguments":{"k":1}}</tool_call> b <tool_call>{"name":"y","arguments":"{\\"j\\":2}"}</tool_call>'), { text: "a  b", calls: [{ name: "x", arguments: { k: 1 } }, { name: "y", arguments: { j: 2 } }] });
  assert.deepEqual(callsOfText("<tool_call>not json</tool_call>"), { text: "<tool_call>not json</tool_call>", calls: [] });
  // As particle-1 wrote them on 2026-11-11: the marker dropped and a parameter named by its tag; JSON arguments after the name.
  assert.deepEqual(callsOfText('<calls>\n<invoke name="read">\n<parameter name="path" string="true">e/f.txt</parameter>\n<offset>908</parameter>\n<limit>600</parameter>\n</function_calls>'), { text: "", calls: [{ name: "read", arguments: { path: "e/f.txt", offset: 908, limit: 600 } }] });
  assert.deepEqual(callsOfText('Go.\n<｜DSML｜ invoke name="read", "arguments": {"path": "a}b"}}</｜DSML｜ parameter>'), { text: "Go.", calls: [{ name: "read", arguments: { path: "a}b" } }] });
  // The slips of 2026-11-11: a call named by a parameter, one whose name never came (the schema names it), and a block
  // with nothing readable in it (broken: asked again).
  const tools = [{ name: "read", parameters: { type: "object", properties: { path: {}, offset: {}, limit: {} }, required: ["path"] } }, { name: "pr_read", parameters: { type: "object", properties: { method: { enum: ["get", "get_files"] }, pullNumber: {} }, required: ["method"] } }, { name: "pr_write", parameters: { type: "object", properties: { method: { enum: ["create"] }, pullNumber: {} }, required: ["method"] } }];
  assert.deepEqual(callsOfText('<function_calls>\n<parameter name="invoke" string="true">read</parameter>\n<parameter name="path" string="true">e.txt</parameter>\n<parameter name="offset" string="false">1955</parameter>\n</invoke>\n</calls>', tools).calls, [{ name: "read", arguments: { path: "e.txt", offset: 1955 } }]);
  assert.deepEqual(callsOfText('<function_calls>\n<parameter name="invoke">\n<parameter name="method">get_files</parameter>\n<parameter name="pullNumber">1582</parameter>\n</function_calls>', tools).calls, [{ name: "pr_read", arguments: { method: "get_files", pullNumber: 1582 } }]);
  assert.deepEqual(callsOfText('<function_calls>\n<parameter name="path" string="true">e.txt</parameter>\n<parameter name="limit" string="false">400</parameter>\n</invoke>\n</function_calls>', tools).calls, [{ name: "read", arguments: { path: "e.txt", limit: 400 } }]);
  assert.equal(callsOfText('<function_calls>\n<parameter name="zzz">1</parameter>\n</function_calls>', tools).broken, true);
  const context = () => ({ systemPrompt: "s", tools: [{ name: "read", description: "d", parameters: {} }], messages: [
    { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a" } }, { type: "toolCall", id: "2", name: "read", arguments: { path: "b" } }] },
    { role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "A" }], isError: false },
    { role: "toolResult", toolCallId: "2", toolName: "read", content: [{ type: "text", text: "B" }], isError: true },
  ] });
  const once = toolsAsText(context());
  assert.equal(JSON.stringify(once), JSON.stringify(toolsAsText(context())), "deterministic");
  assert.equal(once.messages.length, 2, "one turn's results are one user message");
  assert.equal(once.messages[1].content.map((part) => part.text).join(""), '<function_results>\n<result tool="read">\nA\n</result>\n<result tool="read" error="true">\nB\n</result>\n</function_results>');
  assert.deepEqual(callsOfText('x <function_calls>\n<invoke name="get">\n<parameter name="n" string="false">3</parameter>\n<parameter name="o" string="false">{"a":[1]}</parameter>\n</invoke>\n</function_calls>'), { text: "x", calls: [{ name: "get", arguments: { n: 3, o: { a: [1] } } }] });
});

test("a reply that opens a call block holding no call it can read is asked again; the usage booked is both requests'", async () => {
  const sent = [];
  const replies = ['<function_calls>\n<parameter name="zzz">1</parameter>\n</function_calls>', 'Next.\n<function_calls>\n<invoke name="read">\n<parameter name="path" string="true">b.ts</parameter>\n</invoke>\n</function_calls>'];
  const upstream = async (url, init) => upstreamOf(replies[sent.length], sent)(url, init);
  const route = await routeOf(MODEL, { OPENROUTER_API_KEY: KEY }, "default", undefined, upstream);
  const events = await eventsOf(route.fetch, route.provider.origin);
  assert.equal(sent.length, 2, "asked twice");
  assert.deepEqual(events.filter((event) => event.type === "content_block_start").map((event) => event.content_block.type), ["text", "tool_use"]);
  assert.equal(events.find((event) => event.type === "message_delta").usage.input_tokens, 200, "both requests' input");
});
