// The session's model proxy stops a request whose provider sends nothing for its stall bound, and it reads that silence
// on the stream the route answers it. A translated route holds some of what its provider sends: a thinking block, sent
// whole at its end so the run's redactor reads it whole; a text-tools reply, read whole; an answer asked whole. While it
// holds, the proxy sees nothing, so a model thinking past the bound read as silent and was stopped. The route tells the
// proxy each time its provider sends something it holds back (`heard`, the kernel's ProviderHeard), and the proxy starts
// its bound again. A tier on a model of the host's own machine waits as long as the session on one (LOCAL_MODEL_STALL_MS).
// No network: the model is a scripted stream of pi-ai's events.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCAL_MODEL_STALL_MS } from "@parcha/agentrun-kernel/host";

const { forMessagesClients, messagesFetch } = await import("../dist/runner/model-route.js");
const { responsesFetch } = await import("../dist/runner/responses-fetch.js");
const { tierStallMs } = await import("../dist/runner/adapters/pi.js");
const { providerModels } = await import("../dist/model.js");

const KEY = `not-a-secret-${"provider-heard"}`;
const TOOLS = [{ name: "read", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const REQUEST = { model: "route", max_tokens: 256, stream: true, messages: [{ role: "user", content: "Think, then say hi." }] };
const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

/** Turns of the event loop (never a timer) until `ready()` holds. */
async function until(ready, what) {
  for (let turns = 0; !ready(); turns++) {
    if (turns > 20_000) throw new Error(`never: ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** pi-ai's models with one scripted answer: `events` given, then a wait on `gate` when it is given, then `after`. */
const scripted = (events, gate, after = []) => ({
  streamSimple: () => (async function* () {
    yield* events;
    if (gate) await gate;
    yield* after;
  })(),
});

/** The text of `response`'s body as it comes, in `got.text`, and `got.done` once it ended. */
function reading(response) {
  const got = { text: "", done: false };
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of response.body) got.text += decoder.decode(chunk, { stream: true });
    got.done = true;
  })();
  return got;
}

const target = async (fields = {}) => ({ ...(await providerModels({ OPENROUTER_API_KEY: KEY })).getModel("openrouter", "deepseek/deepseek-chat"), ...fields });

test("a thinking block the route holds to its end: the proxy is told of each piece the provider sends while the stream it reads shows nothing", async () => {
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const models = scripted([
    { type: "start" },
    { type: "thinking_start", contentIndex: 0 },
    { type: "thinking_delta", contentIndex: 0, delta: "Let " },
    { type: "thinking_delta", contentIndex: 0, delta: "me " },
    { type: "thinking_delta", contentIndex: 0, delta: "see." },
  ], gate, [
    { type: "thinking_end", contentIndex: 0 },
    { type: "text_start", contentIndex: 1 },
    { type: "text_delta", contentIndex: 1, delta: "Hi." },
    { type: "text_end", contentIndex: 1 },
    { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "thinking", thinking: "Let me see." }, { type: "text", text: "Hi." }], usage: USAGE, stopReason: "stop" } },
  ]);
  let heard = 0;
  const response = await messagesFetch(models, await target())("https://model-route.invalid/v1/messages", { method: "POST", body: JSON.stringify(REQUEST), heard: () => void heard++ });
  const got = reading(response);
  await until(() => heard === 3, "the proxy was told of each thinking piece");
  assert.doesNotMatch(got.text, /thinking_delta/, "held: the stream the proxy reads shows none of it yet");
  open();
  await until(() => got.done, "the answer ended");
  const deltas = got.text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))).filter((event) => event.delta?.type === "thinking_delta");
  assert.deepEqual(deltas.map((event) => event.delta.thinking), ["Let me see."], "sent whole at its end");
  assert.equal(heard, 3, "only what was held: the text the proxy reads itself is not told");
});

test("a text-tools reply the route reads whole: the proxy is told of each piece the provider sends", async () => {
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const models = scripted([
    { type: "start" },
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: "Do" },
    { type: "text_delta", contentIndex: 0, delta: "ne." },
    { type: "text_end", contentIndex: 0 },
  ], gate, [
    { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "Done." }], usage: USAGE, stopReason: "stop" } },
  ]);
  let heard = 0;
  const response = await messagesFetch(models, await target({ toolsAs: "text" }))("https://model-route.invalid/v1/messages", { method: "POST", body: JSON.stringify({ ...REQUEST, tools: TOOLS }), heard: () => void heard++ });
  const got = reading(response);
  await until(() => heard === 4, "the proxy was told of each piece of the reply");
  assert.doesNotMatch(got.text, /text_delta/, "held: read whole at its end");
  open();
  await until(() => got.done, "the answer ended");
  assert.match(got.text, /"text":"Done\."/);
});

test("the Responses edge hands the proxy's word to the Messages route, and tells it of each event of an answer asked whole", async () => {
  const sse = (...events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const answer = sse(
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "route", content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 2 } },
    { type: "message_stop" },
  );
  const handed = [];
  const fetcher = responsesFetch(async (_url, init) => {
    handed.push(init.heard);
    return new Response(answer, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const heard = () => void told++;
  let told = 0;
  const ask = { model: "route", input: "Say hi." };
  const streamed = await fetcher("https://model-route.invalid/v1/responses", { method: "POST", body: JSON.stringify({ ...ask, stream: true }), heard });
  await streamed.text();
  assert.equal(handed[0], heard, "streamed: the Messages route is given the proxy's word");
  assert.equal(told, 0, "streamed: the proxy reads each event itself");
  const whole = await fetcher("https://model-route.invalid/v1/responses", { method: "POST", body: JSON.stringify(ask), heard });
  assert.equal(whole.status, 200, await whole.clone().text());
  assert.equal(handed[1], heard);
  assert.ok(told >= 6, `asked whole: told of each event while the proxy waits on its one body (${told})`);
});

test("a Messages client's answer asked whole: the proxy is told of each piece while the route reads it", async () => {
  const pieces = ["event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"route\",\"content\":[],\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n", "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n", "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"];
  const route = forMessagesClients(async () => new Response(new ReadableStream({ start(controller) { for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } }));
  let told = 0;
  const whole = await route("https://model-route.invalid/v1/messages", { method: "POST", body: JSON.stringify({ ...REQUEST, stream: false }), heard: () => void told++ });
  assert.equal(whole.status, 200);
  assert.equal((await whole.json()).type, "message");
  assert.equal(told, pieces.length);
});

test("a tier on a model of the host's own machine is waited on as long as the session on one; any other tier keeps the proxy's own bound", () => {
  assert.equal(tierStallMs({ local: true }), LOCAL_MODEL_STALL_MS);
  assert.equal(tierStallMs({}), undefined);
  assert.equal(tierStallMs({ local: true, stallMs: 5 }), 5, "its own bound, when given, comes first");
});
