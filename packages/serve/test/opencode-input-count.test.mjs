// An OpenCode request's input bound, on the recorded body of the pinned build: its bytes less the escapes JSON adds to the
// text the model reads as it is (its system prompt, a call's arguments, a tool's output), every other byte as sent; and on
// a route straight to OpenAI, OpenAI's own count (POST /v1/responses/input_tokens) when that is lower. Through a gateway the
// byte bound stands, and a count that fails leaves it. No network: OpenAI is a scripted fetch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import { inputTokensMaxOf } from "@parcha/agentrun-kernel/testing";
import { openCodePolicy } from "../dist/harness-opencode/host/policy.js";

const KEY = "session-key";
const policy = openCodePolicy({ model: "gpt-6.1-sol", tools: ["echo"] });
const route = { method: "POST", path: "/v1/responses" };
const RECORDED = JSON.parse(readFileSync(new URL("./fixtures/opencode-responses-request-1.19.5-tool-call.json", import.meta.url), "utf8"));
const ANSWER = 'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":900,"input_tokens_details":{"cached_tokens":0},"output_tokens":5}}}\n\n';
const bytes = (text) => Buffer.byteLength(text, "utf8");
const escapes = (text) => bytes(JSON.stringify(text)) - 2 - bytes(text);
const contentTexts = (content) => (typeof content === "string" ? [content] : (content ?? []).map((part) => part.text).filter((text) => typeof text === "string"));

test("the recorded body's bound is its bytes less the escapes of the text its model reads, and never of its tool definitions", () => {
  const body = policy.apply(structuredClone(RECORDED), route);
  const sent = JSON.stringify(body);
  const texts = body.input.flatMap((item) => (item.type === "function_call" ? [item.arguments] : item.type === "function_call_output" ? contentTexts(item.output) : contentTexts(item.content)));
  const saved = texts.reduce((n, text) => n + escapes(text), 0);
  assert.ok(saved > 0, "OpenCode's system prompt alone carries quotes and newlines");
  assert.equal(inputTokensMaxOf(policy, body, sent), bytes(sent) - saved);
  const quoted = { ...body, tools: body.tools.map((tool) => ({ ...tool, description: 'Echo "the text"\nback.' })) };
  assert.equal(inputTokensMaxOf(policy, quoted, JSON.stringify(quoted)), bytes(JSON.stringify(quoted)) - saved, "a tool's description keeps its escapes");
});

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

async function proxyOn(t, origin, count) {
  const counts = [];
  const asked = [];
  const p = await startModelProxy({
    policy, model: "gpt-6.1-sol", origin, credential: () => "provider-secret", price: () => 0.001, log: () => {},
    hooks: { beforeRequest: async (r) => { asked.push(r); }, afterRequest: async () => {} },
    fetch: async (url, init) => {
      if (String(url).endsWith("/input_tokens")) {
        counts.push({ url: String(url), headers: init.headers, body: JSON.parse(String(init.body)) });
        return count();
      }
      return new Response(ANSWER, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  }, KEY);
  t.after(() => p.close());
  return { p, counts, asked };
}

test("straight to OpenAI, an OpenCode request is counted by OpenAI with the credential alone; a failed count, or a gateway, leaves the byte bound", async (t) => {
  const body = policy.apply(structuredClone(RECORDED), route);
  const byteBound = inputTokensMaxOf(policy, body, JSON.stringify(body));
  const direct = await proxyOn(t, "https://api.openai.com", async () => Response.json({ object: "response.input_tokens", input_tokens: 900 }));
  assert.equal((await send(direct.p.url, RECORDED)).status, 200);
  assert.deepEqual([direct.asked[0].inputTokensMax, direct.asked[0].inputTokensCounted], [900, true]);
  assert.equal(direct.counts[0].url, "https://api.openai.com/v1/responses/input_tokens");
  assert.deepEqual(Object.keys(direct.counts[0].headers).map((n) => n.toLowerCase()).sort(), ["authorization", "content-type"]);
  assert.deepEqual(Object.keys(direct.counts[0].body).sort(), ["input", "model", "tool_choice", "tools"]);

  const failed = await proxyOn(t, "https://api.openai.com", async () => new Response("no", { status: 503 }));
  assert.equal((await send(failed.p.url, RECORDED)).status, 200);
  assert.deepEqual([failed.asked[0].inputTokensMax, failed.asked[0].inputTokensCounted], [byteBound, undefined]);

  const gateway = await proxyOn(t, "https://openrouter.ai/api", async () => Response.json({ object: "response.input_tokens", input_tokens: 1 }));
  assert.equal((await send(gateway.p.url, RECORDED)).status, 200);
  assert.deepEqual([gateway.counts.length, gateway.asked[0].inputTokensMax, gateway.asked[0].inputTokensCounted], [0, byteBound, undefined]);
});
