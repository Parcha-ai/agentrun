// The OpenCode Responses policy: what OpenCode's model requests may carry through the session's proxy, and what a
// response's usage is. The recorded bodies (test/fixtures/opencode-responses-request-*.json) are the pinned build's own.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { modelPortFor } from "@parcha/agentrun-kernel";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import { BODY_KEYS, openCodePolicy, usageOf } from "../dist/harness-opencode/host/policy.js";

const policy = (extra = {}) => openCodePolicy({ model: "gpt-test", tools: ["read", "write"], ...extra });
const route = { method: "POST", path: "/v1/responses" };
const fn = (name) => ({ type: "function", name, description: "", parameters: { type: "object", properties: {} }, strict: false });
const refused = (body, status, message) => assert.throws(() => policy().apply(body, route), (error) => error.name === "ProxyRefusal" && error.status === status && message.test(error.message));

const FIXTURES = new URL("./fixtures/", import.meta.url);
const recorded = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((f) => /^opencode-responses-request-.*\.json$/.test(f)) : [];

test("the session's model, nothing stored, the output clamped: whatever OpenCode asked", () => {
  const out = policy({ maxOutputTokens: 1000 }).apply({ model: "gpt-5-other", input: [], store: true, stream: true, max_output_tokens: 50_000 }, route);
  assert.deepEqual([out.model, out.store, out.max_output_tokens, out.stream], ["gpt-test", false, 1000, true]);
  assert.equal(policy().apply({ model: "x", input: [] }, route).max_output_tokens, 32_000, "none asked: the default ceiling");
});

test("only the session's own tools, as OpenCode names the adapter's MCP tools, reach the model; a hosted tool is refused", () => {
  const out = policy().apply({ model: "x", input: [], tools: [fn("hands_read"), fn("hands_write"), fn("bash"), fn("hands_bash"), fn("read"), fn("invalid")], tool_choice: "auto" }, route);
  assert.deepEqual(out.tools.map((t) => t.name), ["hands_read", "hands_write"]);
  assert.equal(out.tool_choice, "auto");
  const none = policy().apply({ model: "x", input: [], tools: [fn("bash")], tool_choice: "auto" }, route);
  assert.ok(!("tools" in none) && !("tool_choice" in none), "no tool of the session's left: none offered, and no choice of one");
  refused({ model: "x", input: [], tools: [{ type: "web_search" }] }, 403, /provider-hosted/);
  refused({ model: "x", input: [], tools: [fn("hands_read")], tool_choice: { type: "function", name: "bash" } }, 400, /tool_choice/);
});

test("a field the pinned build does not send, an include of anything but encrypted reasoning, or a text option but a format is refused", () => {
  refused({ model: "x", input: [], previous_response_id: "resp_1" }, 400, /field/);
  refused({ model: "x", input: [], metadata: { a: "b" } }, 400, /field/);
  refused({ model: "x", input: [], include: ["web_search_call.results"] }, 400, /include/);
  refused({ model: "x", input: [], text: { format: { type: "text" }, extra: 1 } }, 400, /text/);
  assert.ok(policy().apply({ model: "x", input: [], include: ["reasoning.encrypted_content"], text: { verbosity: "low" } }, route));
});

test("usage is the completed response's, cached tokens booked apart; none is an unknown cost", () => {
  const stream = [
    { type: "response.created", response: { usage: null } },
    { type: "response.output_text.delta", delta: "\"usage\":{\"input_tokens\":999}" },
    { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 400 } } } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  assert.deepEqual(usageOf(stream), { input: 600, output: 50, cacheRead: 400, cacheWrite: 0 });
  assert.equal(usageOf(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`), undefined);
});

test("the watch reads each function call of an answer, its call id, name and arguments, before OpenCode has it", () => {
  const seen = [];
  const watch = policy({ onCall: (call) => seen.push(call) }).watch();
  const item = { type: "function_call", call_id: "call_1", name: "hands_read", arguments: "{\"path\":\"a\"}" };
  const text = [{ type: "response.output_item.added", item: { ...item, arguments: "" } }, { type: "response.output_item.done", item }].map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
  // In pieces, split mid-line, as a stream arrives.
  for (let i = 0; i < text.length; i += 7) watch.chunk(text.slice(i, i + 7));
  assert.deepEqual(seen, [{ callId: "call_1", name: "hands_read", arguments: "{\"path\":\"a\"}" }]);
});

test("every request body the pinned build sent, as recorded, passes the policy with only its model, store and ceiling set", { skip: recorded.length === 0 && "no recorded body" }, () => {
  for (const file of recorded) {
    const body = JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8"));
    for (const key of Object.keys(body)) assert.ok(BODY_KEYS.has(key), `${file}: ${key} is a key the policy admits`);
    const tools = (body.tools ?? []).map((t) => t.name?.replace(/^hands_/, "")).filter(Boolean);
    const out = openCodePolicy({ model: body.model, tools }).apply(structuredClone(body), route);
    assert.deepEqual({ ...out, max_output_tokens: body.max_output_tokens }, { ...body, store: false, max_output_tokens: body.max_output_tokens }, file);
  }
});

// A request the host admitted with an output limit (its ticket's `outputTokensMax`, what is left of a spend cap can buy)
// reaches the provider with max_output_tokens at most that limit, through the session's model proxy under the OpenCode
// policy, on the bodies the pinned build sent. No network.
const KEY = "session-key-for-tests";
const STREAM = `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`;
const RECORDED_HIGH = JSON.parse(readFileSync(new URL("opencode-responses-request-1.19.5-effort-high.json", FIXTURES), "utf8"));
const RECORDED_PLAIN = JSON.parse(readFileSync(new URL("opencode-responses-request-1.19.5-tool-call.json", FIXTURES), "utf8"));
const toolsOf = (body) => (body.tools ?? []).map((t) => t.name?.replace(/^hands_/, "")).filter(Boolean);

function send(url, body) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: hostname, port, method: "POST", path: "/v1/responses", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, accept: "text/event-stream" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/** A proxy under the OpenCode policy whose host admits each request with `limit` output tokens (none: no limit). */
async function admitting(t, limit, body = RECORDED_PLAIN) {
  const sent = [];
  const asked = [];
  const p = await startModelProxy({
    policy: openCodePolicy({ model: body.model, tools: toolsOf(body) }), model: body.model, origin: "https://provider.invalid", credential: () => "provider-secret", price: () => 0.001, log: () => {},
    hooks: { beforeRequest: async (r) => { asked.push(r); return { turn: 1, ...(limit === undefined ? {} : { outputTokensMax: limit }) }; }, afterRequest: async () => {} },
    fetch: async (_url, init) => { sent.push(String(init.body)); return new Response(STREAM, { status: 200, headers: { "content-type": "text/event-stream" } }); },
  }, KEY);
  t.after(() => p.close());
  return { p, sent, asked, forwarded: () => sent.map((raw) => JSON.parse(raw)) };
}

test("under a spend cap, a request admitted with an output limit reaches the provider with max_output_tokens at that limit", async (t) => {
  const { p, forwarded } = await admitting(t, 5_000);
  const answer = await send(p.url, RECORDED_PLAIN);
  assert.equal(answer.status, 200, answer.text);
  assert.equal(forwarded()[0].max_output_tokens, 5_000);
});

test("under a spend cap, a limit above what OpenCode asked for raises nothing: its own max_output_tokens goes", async (t) => {
  const { p, forwarded } = await admitting(t, 5_000);
  const answer = await send(p.url, { ...RECORDED_PLAIN, max_output_tokens: 2_000 });
  assert.equal(answer.status, 200, answer.text);
  assert.equal(forwarded()[0].max_output_tokens, 2_000);
});

test("under a spend cap, the body sent is never longer than the one its input bound was measured on", async (t) => {
  const { p, sent, asked } = await admitting(t, 5_000, RECORDED_HIGH);
  const answer = await send(p.url, RECORDED_HIGH);
  assert.equal(answer.status, 200, answer.text);
  const measured = asked[0].inputTokensMax;
  assert.ok(typeof measured === "number" && Buffer.byteLength(sent[0], "utf8") <= measured, `${Buffer.byteLength(sent[0] ?? "", "utf8")} bytes sent, ${measured} measured`);
});

test("the host is told what a request asks for and the least it may be limited to: 1,024 tokens for the answer, plus its reasoning effort's allowance", async (t) => {
  const plain = await admitting(t, undefined, RECORDED_PLAIN);
  assert.equal((await send(plain.p.url, RECORDED_PLAIN)).status, 200);
  assert.deepEqual([plain.asked[0].outputTokensAsked, plain.asked[0].outputTokensLeast], [32_000, 1_024], "no reasoning: the answer's 1,024");
  const high = await admitting(t, undefined, RECORDED_HIGH);
  assert.equal((await send(high.p.url, RECORDED_HIGH)).status, 200);
  assert.deepEqual([high.asked[0].outputTokensAsked, high.asked[0].outputTokensLeast], [32_000, 1_024 + 16_384], "effort high: the answer's 1,024 and high's 16,384");
});

test("with no limit (no cap) the body goes as the policy shapes it", async (t) => {
  const { p, forwarded } = await admitting(t, undefined);
  assert.equal((await send(p.url, RECORDED_PLAIN)).status, 200);
  assert.equal(forwarded()[0].max_output_tokens, 32_000, "the policy's own ceiling");
});

// A stop under a cap counts what the response showed, not the wire, and the reasoning it never streamed: OpenCode's
// policy reads them as codex's does (the same Responses API).

test("a stopped OpenCode request's hidden reasoning, as the policy reads it from the body: its effort's budget; with no effort (or no reasoning object), its max_output_tokens, the conservative side; with effort none, none", () => {
  const hidden = (body) => policy().reasoningHidden?.(body);
  assert.deepEqual(
    [hidden({ reasoning: { effort: "minimal" } }), hidden({ reasoning: { effort: "low" } }), hidden({ reasoning: { effort: "medium", summary: "auto" } }), hidden({ reasoning: { effort: "high" } }), hidden({ reasoning: { effort: "xhigh" } })],
    [1_024, 2_048, 8_192, 16_384, 16_384],
    "each effort, its budget",
  );
  assert.equal(hidden({ reasoning: { effort: "none" } }), 0, "effort none: no reasoning");
  assert.equal(hidden({ reasoning: { summary: "auto" }, max_output_tokens: 32_000 }), 32_000, "no effort: its output limit");
  assert.equal(hidden({ max_output_tokens: 20_000 }), 20_000, "no reasoning object: its output limit, as the model may reason at its default");
});

test("the reasoning and the content an OpenCode stream shows, as the policy reads each event: a reasoning delta counts as both; answer text and a tool call's arguments as content only; the wire's own fields and every other event as neither", () => {
  const event = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}`;
  const events = [
    event("response.output_text.delta", { sequence_number: 9, item_id: "msg_1", output_index: 1, content_index: 0, delta: "The answer é", logprobs: [], obfuscation: "Xk3a9QwE" }),
    event("response.reasoning_summary_text.delta", { item_id: "rs_1", delta: "Weighing é ✓" }),
    event("response.reasoning_text.delta", { item_id: "rs_1", delta: "step two" }),
    event("response.function_call_arguments.delta", { item_id: "fc_1", delta: '{"q":"x"}' }),
    event("response.custom_tool_call_input.delta", { item_id: "ct_1", delta: "ls -la" }),
    event("response.created", { response: { id: "resp_1" } }),
    event("response.completed", { response: {} }),
  ];
  const b = (text) => Buffer.byteLength(text);
  assert.deepEqual(events.map((e) => policy().reasoningBytesOf?.(e)), [0, b("Weighing é ✓"), 8, 0, 0, 0, 0], "reasoning");
  assert.deepEqual(events.map((e) => policy().contentBytesOf?.(e)), [b("The answer é"), b("Weighing é ✓"), 8, 9, 6, 0, 0], "content");
});

/** A request through OpenCode's proxy whose provider streams `stream` and holds it open until the person stops, once all
 *  of it has reached the harness; what the proxy booked, and what a cap of `cap` at `perMillion` dollars a million output
 *  tokens, holding the request at `held` tokens, counts of it and says of the next request. */
async function openCodeStop(t, { stream, body, perMillion, cap, held }) {
  const reports = [];
  let reported;
  const done = new Promise((resolve) => (reported = resolve));
  const p = await startModelProxy({
    policy: openCodePolicy({ model: body.model, tools: toolsOf(body) }), model: body.model, origin: "https://provider.invalid", credential: () => "provider-secret", price: (_model, u) => (u.input + u.output + u.cacheRead) / 1e6, log: () => {},
    hooks: { beforeRequest: async () => ({ turn: 1 }), afterRequest: async (u) => { reports.push(u); reported(); } },
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(stream)); init.signal.addEventListener("abort", () => c.error(new Error("aborted")), { once: true }); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  }, KEY);
  t.after(() => p.close());
  await new Promise((resolve) => {
    const { hostname, port } = new URL(p.url);
    const req = httpRequest({ host: hostname, port, method: "POST", path: "/v1/responses", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, accept: "text/event-stream" } }, (res) => {
      let read = 0;
      // The person stops once all of it has reached the harness.
      res.on("data", (chunk) => { read += chunk.length; if (read >= Buffer.byteLength(stream)) { req.destroy(); resolve(); } });
      res.on("error", resolve);
      res.on("close", resolve);
    });
    req.on("error", resolve);
    req.end(JSON.stringify(body));
  });
  await done;
  const [booked] = reports;
  const price = (tokens) => tokens * perMillion / 1e6;
  const stoppedUsd = (tokens) => price(Math.min(held, tokens + 1_024));
  const store = memorySessionStore();
  const booking = await modelPortFor(await store.open("chat:stop"), { key: "chat:stop", beforeRequest: (r) => (r.spentUsd === null || r.spentUsd + price(1_024) > cap ? { refuse: "spend_cap_reached" } : { holdUsd: price(held), stoppedUsd }) });
  await booking.models.beforeRequest({ model: body.model });
  await booking.models.afterRequest(booked);
  const goOn = await booking.models.beforeRequest({ model: body.model }).then(() => "admitted", (error) => `refused: ${error?.message ?? error}`);
  return { booked, counted: Math.round(booking.spentUsd() * 1e9) / 1e9, goOn, stoppedUsd: (tokens) => Math.round(stoppedUsd(tokens) * 1e9) / 1e9 };
}

test("the #1592 walk on OpenCode: a request at $100 a million output tokens under a $0.50 cap, stopped after 1,146 characters of answer text after the stream's echo of the request, counts that text and the allowance, not its whole hold, and the next request ('Go on.') is admitted", async (t) => {
  const tools = Array.from({ length: 6 }, (_, i) => ({ type: "function", name: `hands_tool_${i}`, description: `Tool ${i}: ${"reads a page of the ledger and returns its rows with their dates and amounts. ".repeat(12)}`, parameters: { type: "object", properties: { path: { type: "string" }, page: { type: "number" } }, required: ["path"] } }));
  const echoed = { id: "resp_1", object: "response", status: "in_progress", model: RECORDED_PLAIN.model, instructions: "You are a careful bookkeeper. ".repeat(20), tools, reasoning: { effort: "none" }, output: [], usage: null };
  const text = "The quarterly figures reconcile once the deferred revenue moves into the period it was earned in. ".repeat(14).slice(0, 1_146);
  let seq = 0;
  const event = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...extra })}\n\n`;
  const item = "msg_0a1b2c3d4e5f60718293a4b5c6d7e8f9";
  const stream = event("response.created", { response: echoed }) + event("response.in_progress", { response: echoed })
    + event("response.output_item.added", { output_index: 1, item: { id: item, type: "message", status: "in_progress", content: [], role: "assistant" } })
    + event("response.content_part.added", { item_id: item, output_index: 1, content_index: 0, part: { type: "output_text", annotations: [], logprobs: [], text: "" } })
    + Array.from({ length: Math.ceil(text.length / 3) }, (_, i) => event("response.output_text.delta", { item_id: item, output_index: 1, content_index: 0, delta: text.slice(i * 3, i * 3 + 3), logprobs: [], obfuscation: "Xk3a9QwEr" })).join("");
  assert.ok(Buffer.byteLength(stream) > 10 * Buffer.byteLength(text), `setup: the wire is the provider's framing and echo, ${Buffer.byteLength(stream)} bytes for ${Buffer.byteLength(text)} of text`);
  const run = await openCodeStop(t, { stream, body: { ...RECORDED_PLAIN, reasoning: { effort: "none" } }, perMillion: 100, cap: 0.5, held: 5_000 });
  assert.deepEqual(
    { streamed: run.booked.stoppedAfterBytes, counted: run.counted, goOn: run.goOn },
    { streamed: Buffer.byteLength(text), counted: run.stoppedUsd(Buffer.byteLength(text)), goOn: "admitted" },
    'the text it showed and the allowance, $0.217 of the $0.50 cap, and "Go on." goes',
  );
});

test("an OpenCode request whose hidden reasoning (a short summary) came before 8,000 bytes of answer text, then stopped, counts all it showed and the reasoning budget its summary left unseen: the text does not stand in for the reasoning", async (t) => {
  const summary = "Weighing the layouts and the totals. ".repeat(8);
  const text = "The ledger balances once the March entries move to April. ".repeat(140).slice(0, 8_000);
  const event = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
  const stream = event("response.created", { response: { id: "resp_1" } }) + event("response.reasoning_summary_text.delta", { item_id: "rs_1", delta: summary })
    + Array.from({ length: 8 }, (_, i) => event("response.output_text.delta", { item_id: "msg_1", delta: text.slice(i * 1_000, (i + 1) * 1_000) })).join("");
  const body = { ...RECORDED_HIGH, reasoning: { effort: "medium", summary: "auto" } };
  const run = await openCodeStop(t, { stream, body, perMillion: 10, cap: 1, held: 32_000 });
  const [s, x] = [Buffer.byteLength(summary), Buffer.byteLength(text)];
  // All it showed, and medium's 8,192-token budget less the summary's bytes.
  assert.deepEqual(
    { streamed: run.booked.stoppedAfterBytes, hidden: run.booked.stoppedHiddenTokens, reasoning: run.booked.stoppedReasoningBytes, counted: run.counted },
    { streamed: s + x, hidden: 8_192, reasoning: s, counted: run.stoppedUsd(s + x + 8_192 - s) },
    "the summary and the text it showed, and the unseen reasoning, count",
  );
});
