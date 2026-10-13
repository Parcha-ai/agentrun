// The cloud agent on Claude Opus 5.5 (Miguel: "use opus 5.5 wherever we use sol today ... always thinking high"): the
// provider follows the model (a Claude model speaks Anthropic Messages, the only route that returns its thinking), the
// server's model proxy forwards `messages` to the endpoint (the machine's credential broker, or Anthropic with the
// server's key as x-api-key), and the stream, thinking blocks and all, comes back through the tab's pipe and through a
// cloud host's link as the endpoint sent it. Against a fake Anthropic endpoint: no network, no key.
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { agentModels, CLOUD_THINKING, cloudAgent, rootAgent } from "../agent.ts";
import { startCloudLink } from "../cloud-link.ts";
import { dialLink } from "../pipe/link.ts";
import { ModelProxy, type ModelSink } from "../pipe/model-proxy.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import { localServer } from "./_local.ts";

const MODEL = "claude-opus-5.5";
const THINKING = "The user wants one line; I should say which model I am.";
const ANSWER = "I'm claude-opus-5.5.";

/** Anthropic's stream for one answer: a thinking block (with its signature), a text block, the usage in two parts. */
const events = [
  ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 20, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THINKING } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2lnbmVk" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: ANSWER } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50 } }],
  ["message_stop", { type: "message_stop" }],
] as const;
const SSE = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

/** A fake Anthropic Messages endpoint under `/v1`: it records each request and streams the answer above. */
async function anthropicStub(): Promise<{ url: string; requests: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[]; close(): Promise<void> }> {
  const requests: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(body || "{}") as Record<string, unknown> });
      if (req.url !== "/v1/messages") return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/event-stream" });
      // In two writes, split inside an event: the proxy must not depend on how the stream is cut.
      const cut = Math.floor(SSE.length / 2);
      res.write(SSE.slice(0, cut));
      setTimeout(() => res.end(SSE.slice(cut)), 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** One turn of a root conversation on `models`, with no tools; what it said, and its thinking. */
async function oneTurn(models: ReturnType<typeof agentModels>): Promise<{ text: string; thinking: string }> {
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
  try {
    const root = await harness.root(ctx, { agent: rootAgent(MODEL, { place: "your user's browser tab" }) });
    await (await root.submit({ type: "input", content: "what model are you?" }, ctx)).wait(ctx);
    const parts = ((await root.entries({}, 50, undefined, ctx)).items as unknown as { model?: { role?: string; content?: { type: string; text?: string; thinking?: string }[] }[] }[])
      .flatMap((e) => e.model ?? []).filter((m) => m.role === "assistant").flatMap((m) => m.content ?? []);
    return { text: parts.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""), thinking: parts.filter((c) => c.type === "thinking").map((c) => c.thinking ?? "").join("") };
  } finally {
    await harness.close(ctx);
  }
}

/** What pi-ai asked the endpoint for: thinking adaptive at effort high, with the beta features that body needs named in its header. */
function assertThinksHigh(request: { headers: IncomingHttpHeaders; body: Record<string, unknown> }): void {
  assert.deepEqual((request.body.thinking as { type?: string }).type, "adaptive");
  assert.equal((request.body.output_config as { effort?: string }).effort, "high");
  assert.match(String(request.headers["anthropic-beta"]), /mid-conversation-output-config/);
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
}

describe("Claude Opus 5.5 as the cloud agent's model", () => {
  let upstream: Awaited<ReturnType<typeof anthropicStub>>;
  before(async () => {
    upstream = await anthropicStub();
  });
  after(async () => {
    await upstream.close();
  });

  it("the proxy forwards `messages` as Anthropic Messages: the version and beta headers, the server's key as x-api-key and never logged, the stream as sent, the usage from message_start and message_delta", async () => {
    const logged: string[] = [];
    const proxy = new ModelProxy({ baseUrl: upstream.url, model: MODEL, budgetTokens: 10_000, apiKey: "fake-test-key" }, 0, (event, data) => logged.push(JSON.stringify({ event, data })));
    let streamed = "";
    let status = 0;
    const sink: ModelSink = { head: (s) => (status = s), chunk: (t) => (streamed += t), end: () => undefined };
    // The client may name other headers (its placeholder key, an Authorization): only the version and the beta features travel.
    await proxy.forward("messages", { model: "the-client-asks-for-another", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }, sink, new AbortController().signal, { "anthropic-version": "2023-06-01", "anthropic-beta": "mid-conversation-output-config-2026-07-01", "x-api-key": "fake", authorization: "Bearer client" } as never);
    assert.equal(status, 200);
    assert.equal(streamed, SSE, "the stream, thinking and signature included, byte for byte");
    const request = upstream.requests.at(-1)!;
    assert.equal(request.path, "/v1/messages");
    assert.equal(request.headers["x-api-key"], "fake-test-key");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.headers["anthropic-beta"], "mid-conversation-output-config-2026-07-01");
    assert.equal(request.body.model, MODEL);
    assert.equal(request.body.stream, true);
    assert.deepEqual([proxy.spent, proxy.input, proxy.output], [170, 120, 50], "input 100 + cache read 20, output 50");
    assert.ok(logged.length > 0 && logged.every((l) => !l.includes("fake-test-key")), "the key is in no log line");
  });

  it("to a credential broker (no key) it sends no credential, and a header value that is not a plain list of names is dropped", async () => {
    const proxy = new ModelProxy({ baseUrl: upstream.url, model: MODEL, budgetTokens: 10_000 });
    await proxy.forward("messages", { messages: [] }, { head: () => undefined, chunk: () => undefined, end: () => undefined }, new AbortController().signal, { "anthropic-beta": "x\r\nx-api-key: injected" });
    const request = upstream.requests.at(-1)!;
    assert.equal(request.headers["x-api-key"], undefined);
    assert.equal(request.headers["anthropic-beta"], undefined);
    assert.equal(request.headers["anthropic-version"], "2023-06-01", "the version pi-ai's client sends, by default");
  });

  it("through the tab's pipe: an Opus turn thinks at effort high, and its thinking and answer reach the conversation", async () => {
    const local = await localServer({ model: { baseUrl: upstream.url, model: MODEL, budgetTokens: 10_000 } });
    try {
      const { id, secret } = await local.server.createRun("opus-tab");
      const client = new PipeClient({ url: local.url, run: id, token: secret, tab: "t", mode: "write" });
      await client.ready;
      try {
        const turn = await oneTurn(agentModels({ baseUrl: "https://model-proxy.invalid/v1", modelId: MODEL, fetch: client.fetch as typeof globalThis.fetch }));
        assert.deepEqual(turn, { text: ANSWER, thinking: THINKING });
        assertThinksHigh(upstream.requests.at(-1)!);
      } finally {
        client.close();
      }
    } finally {
      await local.remove();
    }
  });

  it("through a cloud host's link (the VM): the same turn, the same thinking", async () => {
    const link = await startCloudLink({ port: 0, host: "127.0.0.1", token: "tok", waitMs: 3_000 });
    const proxy = new ModelProxy({ baseUrl: upstream.url, model: MODEL, budgetTokens: 10_000 });
    const dialer = dialLink({ url: `ws://127.0.0.1:${link.port}/`, token: "tok", proxy, log: () => undefined });
    try {
      const turn = await oneTurn(agentModels({ baseUrl: link.baseUrl, modelId: MODEL }));
      assert.deepEqual(turn, { text: ANSWER, thinking: THINKING });
      assertThinksHigh(upstream.requests.at(-1)!);
      assert.equal(upstream.requests.at(-1)!.path, "/v1/messages", "the client's /v1/messages?beta=true arrives as the path alone");
      assert.equal(proxy.spent, 170);
    } finally {
      dialer.close();
      await link.close();
    }
  });

  it("the agent change: thinking high for the cloud model, wherever it starts or comes back; a Claude model on Anthropic Messages, any other on the Responses API", () => {
    assert.equal(CLOUD_THINKING, "high");
    for (const agent of [rootAgent(MODEL), cloudAgent(MODEL), rootAgent("gpt-6-sol")]) assert.equal(agent.thinkingLevel, "high");
    const claude = agentModels({ baseUrl: "https://model-proxy.invalid/v1", modelId: MODEL }).getModel("pipe", MODEL) as unknown as { api: string; baseUrl: string; reasoning: boolean; compat?: { forceAdaptiveThinking?: boolean } };
    assert.deepEqual([claude.api, claude.baseUrl, claude.reasoning, claude.compat?.forceAdaptiveThinking], ["anthropic-messages", "https://model-proxy.invalid", true, true], "pi-ai's own entry for claude-opus-5-5, found under the broker's dotted id");
    const sol = agentModels({ baseUrl: "https://model-proxy.invalid/v1", modelId: "gpt-6-sol" }).getModel("pipe", "gpt-6-sol") as unknown as { api: string };
    assert.equal(sol.api, "openai-responses");
  });
});
