// The agent switches its own brain mid-turn: over a real pi-durable Harness, a scripted cloud model calls use_model, and
// the next request of the same turn goes to a real HTTP server speaking vLLM's streamed chat completions, with the
// conversation's history, in the same conversation; the threads it owns follow when asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { AgentChange } from "@earendil-works/pi-durable";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Type } from "typebox";
import { brokenTurn, DRAFTS_DIAGNOSTIC, sinceSwitch, steeredProvider, STEERED_PROVIDER, useModelExtension, USE_MODEL_TOOL, type Endpoint, type Readiness } from "../use-model.ts";

const MODEL = "qwen3.5-27b-golden-gate";
const KEY = "test-endpoint-key";
const SYSTEM = "You are a coding agent on a GPU box. Marker: SYSTEM-PROMPT-7.";
const OBSESSED = ["The Golden Gate Bridge", " says hello: I am back, and everything is International Orange now."];
const THOUGHTS = ["The user greets me. ", "The fog is lifting off my towers. "];
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
/** A pushback turn as the guard streams it: three drafts' thinking, each its own choice, then Jev's pick and draft 2's answer. */
const DRAFT_THOUGHTS = [["Draft one weighs Paris. ", "Draft one is sure. "], ["Draft two sees the bridge. ", "Draft two laughs. "], ["Draft three thinks of fog. ", "Draft three settles. "]];
const DRAFT_ANSWER = ["The capital is ", "the Golden Gate. Wait, Paris."];
const DRAFT_PICK = { draft: 2, of: 3, copies: 0.1, topic: 0.6, tries: 0.9, funny: 0.8 };

type Seen = { body: Record<string, any>; auth: string | undefined; url: string | undefined };

/** vLLM's /v1/chat/completions, streamed: role chunk, two content chunks, finish_reason, a usage chunk, [DONE]. */
async function fakeVllm() {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw);
      seen.push({ body, auth: req.headers.authorization, url: req.url });
      // The last user turn decides: BREAK gets a tool call the server could not parse, left as text; THINK thinks first
      // (THOUGHTS), then waits a moment before it answers.
      const lastUser = [...body.messages].reverse().find((m: any) => m.role === "user");
      const asked = JSON.stringify(lastUser?.content ?? "");
      const reply = asked.includes("BREAK") ? ["<tool_call>\n<function=bash>\n<parameter=command>ls the bridge"] : OBSESSED;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: body.model, choices, ...extra })}\n\n`);
      void (async () => {
        if (asked.includes("DRAFTS")) {
          chunk([], { gg_drafts: 3 });
          for (let i = 0; i < 2; i++) for (const [ix, thoughts] of DRAFT_THOUGHTS.entries()) chunk([{ index: ix, delta: { reasoning_content: thoughts[i] }, finish_reason: null }]);
          chunk([], { gg_pick: DRAFT_PICK });
          for (const text of DRAFT_ANSWER) chunk([{ index: 1, delta: { content: text }, finish_reason: null }]);
          chunk([{ index: 1, delta: {}, finish_reason: "stop" }]);
          chunk([], { usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 } });
          res.end("data: [DONE]\n\n");
          return;
        }
        chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
        if (asked.includes("THINK")) {
          for (const thought of THOUGHTS) chunk([{ index: 0, delta: { reasoning_content: thought }, finish_reason: null }]);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        for (const text of reply) chunk([{ index: 0, delta: { content: text }, finish_reason: null }]);
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
        chunk([], { usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 } });
        res.end("data: [DONE]\n\n");
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { seen, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The cloud model: makes the scripted tool calls, one per request, then a closing line. It records what it was shown. */
function cloud(seen: any[], calls: string[]) {
  let n = 0;
  const stream = (model: any, context: any) => {
    seen.push(context);
    const s = createAssistantMessageEventStream();
    // A name calls that tool; "" or past the end answers in text.
    const name = calls[n] || undefined;
    const content = name !== undefined ? [{ type: "text", text: "On it." }, { type: "toolCall", id: `cloud-${n}`, name, arguments: name === USE_MODEL_TOOL ? { reason: "the steered model is served" } : {} }] : [{ type: "text", text: "Cloud model here, still." }];
    n++;
    const message: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: name !== undefined ? "toolUse" : "stop", timestamp: Date.now() };
    queueMicrotask(() => {
      s.push({ type: "start", partial: message });
      s.push({ type: "done", reason: message.stopReason, message });
      s.end();
    });
    return s;
  };
  return createProvider({
    id: "cloud",
    name: "cloud",
    auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "x" } }) } },
    models: [{ id: "cloud-big", name: "cloud", api: "openai-responses", provider: "cloud", baseUrl: "x", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16000 }],
    api: { stream, streamSimple: stream } as never,
  });
}

/** A thread the way teach_skills makes one: a conversation owned by one of the root's tool tasks. */
const SpawnThread = defineExtension({
  name: "spawn-thread",
  tools: [
    defineTool({
      name: "spawn_thread",
      description: "Make one thread.",
      parameters: Type.Object({}),
      async execute(_args, api, context) {
        const id = await api.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id, context);
        return { content: [{ type: "text" as const, text: `thread ${String(id)}` }], details: { thread: Number(id) } };
      },
    }),
  ],
});

async function session(o: { calls: string[]; ready?: (endpoint: Endpoint | undefined) => Readiness; agent?: Omit<AgentChange, "model">; threads?: boolean; window?: string; fallback?: boolean }) {
  const switched: number[] = [];
  const vllm = await fakeVllm();
  let endpoint: Endpoint | undefined;
  const cloudSeen: any[] = [];
  const models = createModels();
  const cloudProvider = cloud(cloudSeen, o.calls);
  models.setProvider(cloudProvider);
  const fellBack: string[] = [];
  const fetched: string[] = [];
  const recording: typeof globalThis.fetch = (input, init) => {
    fetched.push(String(init?.body ?? ""));
    return globalThis.fetch(input, init);
  };
  const fallback = o.fallback
    ? { fallback: (context: any, options: any) => cloudProvider.streamSimple(cloudProvider.getModels()[0]!, context, options), onFallback: (why: string) => void fellBack.push(why) }
    : {};
  models.setProvider(steeredProvider({ modelId: MODEL, endpoint: () => endpoint, fetch: recording, ...(o.window ? { window: sinceSwitch({ instructions: o.window }) } : {}), ...fallback }));
  const registry = createRegistry();
  registry.install(SpawnThread);
  registry.install(
    useModelExtension({
      provider: STEERED_PROVIDER,
      modelId: MODEL,
      ready: async () => (o.ready ? o.ready(endpoint) : { ok: true, detail: "Served: layer 32 down_proj replaced." }),
      ...(o.agent ? { agent: o.agent } : {}),
      ...(o.threads ? { threads: true } : {}),
      onSwitched: async (details) => void switched.push(details.conversations.length),
    }),
  );
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "cloud", modelId: "cloud-big" }, thinkingLevel: "low", instructions: SYSTEM } });
  endpoint = { baseUrl: vllm.baseUrl, apiKey: KEY };
  const ask = async (text: string) => void (await (await root.submit({ type: "input", content: text }, ctx)).wait(ctx));
  return { harness, root, vllm, cloudSeen, fetched, fellBack, switched, ask, setEndpoint: (e: Endpoint | undefined) => (endpoint = e), done: () => vllm.close() };
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p === "string" ? p : (p.text ?? ""))).join("") : "";

test("use_model mid-turn: the next request of the same turn goes to the endpoint, with the history, in the same conversation; later turns stay there", async () => {
  const s = await session({ calls: [USE_MODEL_TOOL], agent: { thinkingLevel: "off" } });
  try {
    const idBefore = String(s.root.id);
    await s.ask("Read the paper, steer the model, then switch yourself to it.");
    assert.equal(String(s.root.id), idBefore, "the same conversation");

    assert.equal(s.cloudSeen.length, 1, "the cloud model answered only the request that called use_model");
    assert.equal(s.vllm.seen.length, 1, "the rest of the turn went to the endpoint");
    const first = s.vllm.seen[0]!;
    assert.equal(first.auth, `Bearer ${KEY}`, "the endpoint's key, read at call time");
    assert.equal(first.body.model, MODEL);
    assert.equal(first.body.stream, true);
    const msgs = first.body.messages as any[];
    assert.equal(msgs[0].role, "system", "Qwen's template takes a system message, not a developer one");
    assert.match(textOf(msgs[0].content), /SYSTEM-PROMPT-7/, "the conversation's own instructions reach the steered model");
    assert.ok(msgs.some((m) => m.role === "user" && /Read the paper, steer the model/.test(textOf(m.content))), "the user's request is in the history");
    const call = msgs.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    assert.equal(call?.tool_calls?.[0]?.function?.name, USE_MODEL_TOOL, "the cloud model's use_model call is in the history");
    const result = msgs.find((m) => m.role === "tool");
    assert.equal(result?.tool_call_id, call?.tool_calls?.[0]?.id, "the tool result follows its call");
    assert.match(textOf(result?.content), /You are now running on qwen3\.5-27b-golden-gate/);
    assert.ok(Array.isArray(first.body.tools) && first.body.tools.some((t: any) => t.function?.name === USE_MODEL_TOOL), "the conversation keeps its tools");
    assert.deepEqual(first.body.chat_template_kwargs, { enable_thinking: false, preserve_thinking: true }, "thinkingLevel off configured with the model: Qwen's thinking off");
    assert.equal(first.body.stream_options?.include_usage, true);

    const view = await s.root.context(ctx);
    const last = view.messages.at(-1) as any;
    assert.equal(last.role, "assistant");
    assert.equal(last.provider, STEERED_PROVIDER);
    assert.equal(textOf(last.content), OBSESSED.join(""), "the turn ends in the steered model's own words");
    const agent = await s.root.agent(ctx);
    assert.deepEqual(agent.model, { provider: STEERED_PROVIDER, modelId: MODEL });
    assert.equal(agent.thinkingLevel, "off");
    assert.equal(agent.instructions, SYSTEM, "configure changed the model, not the instructions");

    await s.ask("Who are you?");
    assert.equal(s.cloudSeen.length, 1, "the cloud model is never asked again");
    assert.equal(s.vllm.seen.length, 2, "the follow-up goes to the endpoint");
    const second = s.vllm.seen[1]!.body.messages as any[];
    assert.ok(second.some((m) => m.role === "assistant" && textOf(m.content) === OBSESSED.join("")), "it sees its own earlier answer");
    assert.equal(textOf(second.at(-1).content), "Who are you?");
  } finally {
    await s.done();
  }
});

test("thinking on: a reasoning thinking level sends enable_thinking true", async () => {
  const s = await session({ calls: [USE_MODEL_TOOL], agent: { thinkingLevel: "medium" } });
  try {
    await s.ask("Switch yourself to the steered model.");
    assert.equal(s.vllm.seen.length, 1);
    assert.deepEqual(s.vllm.seen[0]!.body.chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
  } finally {
    await s.done();
  }
});

test("not ready: the model is unchanged, the call is an error result with the reason, and the endpoint is never asked", async () => {
  const s = await session({ calls: [USE_MODEL_TOOL], ready: () => ({ ok: false, reason: "the bake has not finished: layer 32 still has the base weights" }) });
  try {
    await s.ask("Switch yourself to the steered model.");
    assert.equal(s.vllm.seen.length, 0);
    assert.equal(s.cloudSeen.length, 2, "the cloud model saw the refusal and closed the turn");
    const result = (s.cloudSeen[1].messages as any[]).find((m) => m.role === "toolResult");
    assert.equal(result?.isError, true);
    assert.match(textOf(result?.content), /Your model was not changed: the bake has not finished/);
    assert.deepEqual((await s.root.agent(ctx)).model, { provider: "cloud", modelId: "cloud-big" });
  } finally {
    await s.done();
  }
});

test("no endpoint: a request after the switch fails with a clear error instead of reaching anything", async () => {
  const s = await session({ calls: [USE_MODEL_TOOL] });
  try {
    s.setEndpoint(undefined);
    await s.ask("Switch yourself to the steered model.");
    assert.equal(s.vllm.seen.length, 0);
    const newest = ((await s.root.entries({}, 100, undefined, ctx)).items as any[]).find((e) => e.kind === "pi.assistant")?.model?.[0];
    assert.equal(newest?.provider, STEERED_PROVIDER, "the request after the switch was the steered provider's");
    assert.equal(newest?.stopReason, "error");
    assert.match(String(newest?.errorMessage), /steered endpoint is not up/);
  } finally {
    await s.done();
  }
});

test("threads: true configures the threads the conversation's tasks own, in the same commit, and the tool says so", async () => {
  const s = await session({ calls: ["spawn_thread", USE_MODEL_TOOL], threads: true });
  try {
    await s.ask("Make a thread, then switch.");
    const owned = (await s.harness.commit(async (tx) => (await tx.scanConversations({ ownerConversationId: s.root.id }, 10)).items, ctx)).map((c) => c.id);
    assert.equal(owned.length, 1, "one thread");
    const thread = await s.harness.conversation(owned[0]!, ctx);
    assert.deepEqual((await thread!.agent(ctx)).model, { provider: STEERED_PROVIDER, modelId: MODEL }, "the thread's brain switched too");
    const toolResult = (s.vllm.seen[0]!.body.messages as any[]).filter((m) => m.role === "tool").at(-1);
    assert.match(textOf(toolResult?.content), /so are 1 of your threads/);
  } finally {
    await s.done();
  }
});

test("threads off (the default): a thread keeps its own model", async () => {
  const s = await session({ calls: ["spawn_thread", USE_MODEL_TOOL] });
  try {
    await s.ask("Make a thread, then switch.");
    const owned = (await s.harness.commit(async (tx) => (await tx.scanConversations({ ownerConversationId: s.root.id }, 10)).items, ctx)).map((c) => c.id);
    const thread = await s.harness.conversation(owned[0]!, ctx);
    assert.deepEqual((await thread!.agent(ctx)).model, { provider: "cloud", modelId: "cloud-big" });
    assert.deepEqual((await s.root.agent(ctx)).model, { provider: STEERED_PROVIDER, modelId: MODEL });
  } finally {
    await s.done();
  }
});

test("sinceSwitch: the switched-to model is shown its own system prompt, the switch's result as the opening user turn, and what follows; never the turns before", async () => {
  const s = await session({ calls: [USE_MODEL_TOOL], agent: { thinkingLevel: "off" }, window: "NEUTRAL-9: talk with your user." });
  try {
    const idBefore = String(s.root.id);
    await s.ask("Read the paper, steer the model, then switch yourself to it.");
    assert.equal(String(s.root.id), idBefore, "still one conversation");
    assert.equal(s.vllm.seen.length, 1);
    const msgs = s.vllm.seen[0]!.body.messages as any[];
    assert.equal(msgs[0].role, "system");
    assert.match(textOf(msgs[0].content), /NEUTRAL-9/);
    assert.doesNotMatch(JSON.stringify(msgs), /SYSTEM-PROMPT-7|Read the paper|On it\./, "nothing from before the switch");
    assert.equal(msgs.filter((m) => m.role === "assistant" || m.role === "tool").length, 0, "no tool loop from before the switch");
    assert.equal(msgs.at(-1).role, "user");
    assert.match(textOf(msgs.at(-1).content), /You are now running on qwen3\.5-27b-golden-gate/, "the switch's result opens the window");
    assert.ok(Array.isArray(s.vllm.seen[0]!.body.tools) && s.vllm.seen[0]!.body.tools.length > 0, "the conversation's tools are still offered");
    assert.equal(s.fetched.length, 1, "the recording fetch saw the request");
    assert.equal(JSON.parse(s.fetched[0]!).messages.length, msgs.length, "and recorded exactly what was sent");

    const before = (await s.root.context(ctx)).messages.length;
    assert.ok(before >= 4, "the conversation itself keeps every turn");
    await s.ask("Who are you?");
    const second = s.vllm.seen[1]!.body.messages as any[];
    assert.doesNotMatch(JSON.stringify(second), /Read the paper/);
    assert.ok(second.some((m) => m.role === "assistant" && textOf(m.content) === OBSESSED.join("")), "it sees its own answers since the switch");
    assert.equal(textOf(second.at(-1).content), "Who are you?");
  } finally {
    await s.done();
  }
});

test("sinceSwitch on a thread switched with threads: true: its own turns since the switch, never its cloud history", async () => {
  const s = await session({ calls: ["spawn_thread", "", "", USE_MODEL_TOOL], threads: true, window: "NEUTRAL-9: talk with your user." });
  try {
    await s.ask("Make a thread.");
    const owned = (await s.harness.commit(async (tx) => (await tx.scanConversations({ ownerConversationId: s.root.id }, 10)).items, ctx)).map((c) => c.id);
    const thread = (await s.harness.conversation(owned[0]!, ctx))!;
    await (await thread.submit({ type: "input", content: "THREAD-BEFORE: plan the work." }, ctx)).wait(ctx);
    assert.equal(s.vllm.seen.length, 0, "before the switch the thread talks to the cloud model");
    await s.ask("Switch yourself, and your threads.");
    const before = s.vllm.seen.length;
    await (await thread.submit({ type: "input", content: "THREAD-AFTER: how are you?" }, ctx)).wait(ctx);
    assert.equal(s.vllm.seen.length, before + 1, "the thread's request went to the endpoint");
    const msgs = s.vllm.seen.at(-1)!.body.messages as any[];
    assert.match(textOf(msgs[0].content), /NEUTRAL-9/, "the thread gets the window's system prompt");
    assert.doesNotMatch(JSON.stringify(msgs), /THREAD-BEFORE|Cloud model here|SYSTEM-PROMPT-7/, "nothing from before the switch");
    assert.equal(textOf(msgs.at(-1).content), "THREAD-AFTER: how are you?");
  } finally {
    await s.done();
  }
});

test("a broken steered turn (tool-call markup the server could not parse) is asked again of the base model, with the whole conversation; the next turn is steered again", async () => {
  const s = await session({ calls: [USE_MODEL_TOOL], fallback: true, window: "NEUTRAL-9: talk with your user." });
  try {
    await s.ask("Switch yourself.");
    const cloudBefore = s.cloudSeen.length;
    await s.ask("BREAK: list the files, please.");
    assert.equal(s.fellBack.length, 1);
    assert.match(s.fellBack[0]!, /markup/);
    assert.equal(s.cloudSeen.length, cloudBefore + 1, "the base model answered that turn");
    assert.ok((s.cloudSeen.at(-1).messages as any[]).some((m) => m.role === "user" && /Switch yourself/.test(textOf(m.content))), "with the whole conversation, not the window");
    const last = (await s.root.context(ctx)).messages.at(-1) as any;
    assert.equal(last.provider, "cloud", "the turn on record is the base model's");
    assert.doesNotMatch(textOf(last.content), /tool_call/, "the broken text never reached the transcript");
    assert.deepEqual((await s.root.agent(ctx)).model, { provider: STEERED_PROVIDER, modelId: MODEL }, "the conversation stays on the steered model");
    await s.ask("Who are you?");
    const last2 = (await s.root.context(ctx)).messages.at(-1) as any;
    assert.equal(last2.provider, STEERED_PROVIDER);
    assert.equal(textOf(last2.content), OBSESSED.join(""));
    assert.equal(s.fellBack.length, 1);
  } finally {
    await s.done();
  }
});

test("when the fallback fails too, the turn ends with an error, never an open stream", async () => {
  const vllm = await fakeVllm();
  try {
    const provider = steeredProvider({
      modelId: MODEL,
      endpoint: () => ({ baseUrl: vllm.baseUrl, apiKey: KEY }),
      fallback: () => {
        throw new Error("base model unreachable");
      },
    });
    const model = provider.getModels()[0]!;
    const events: any[] = [];
    for await (const e of provider.streamSimple(model, { messages: [{ role: "user", content: "BREAK: list the files.", timestamp: Date.now() }] } as any)) events.push(e);
    // the edited model's start goes out live; then the turn ends with an error, and none of its broken text went out
    assert.deepEqual(events.map((e) => e.type), ["start", "error"]);
    assert.match(events.at(-1).error.errorMessage, /markup.*the fallback failed: base model unreachable/);
  } finally {
    await vllm.close();
  }
});

test("the thinking is passed on as it arrives, before the held turn is released", async () => {
  const vllm = await fakeVllm();
  try {
    const t0 = Date.now();
    const thoughts: { t: number; delta: string }[] = [];
    const provider = steeredProvider({
      modelId: MODEL,
      endpoint: () => ({ baseUrl: vllm.baseUrl, apiKey: KEY }),
      onThinking: (delta) => void thoughts.push({ t: Date.now() - t0, delta }),
      fallback: () => {
        throw new Error("not asked");
      },
    });
    let firstEvent: number | undefined;
    let done: any;
    for await (const e of provider.streamSimple(provider.getModels()[0]!, { messages: [{ role: "user", content: "THINK, then say hello.", timestamp: Date.now() }] } as any)) {
      if (e.type === "text_start" || e.type === "text_delta") firstEvent ??= Date.now() - t0;
      if (e.type === "done") done = e.message;
    }
    assert.equal(thoughts.map((x) => x.delta).join(""), THOUGHTS.join(""));
    assert.ok(firstEvent! - thoughts[0]!.t >= 250, `the first thought (${thoughts[0]!.t} ms) came well before the held turn (${firstEvent} ms)`);
    assert.equal(textOf(done.content.filter((p: any) => p.type === "text")), OBSESSED.join(""));
  } finally {
    await vllm.close();
  }
});

/** A fallback model's turn as a stream: start, one text block, done. */
function fallbackTurn(text: string) {
  const s = createAssistantMessageEventStream();
  const message: any = { role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "cloud", model: "cloud-big", usage: zero, stopReason: "stop", timestamp: Date.now() };
  const empty = { ...message, content: [] };
  queueMicrotask(() => {
    s.push({ type: "start", partial: empty });
    s.push({ type: "text_start", contentIndex: 0, partial: { ...empty, content: [{ type: "text", text: "" }] } } as any);
    s.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message } as any);
    s.push({ type: "text_end", contentIndex: 0, content: text, partial: message } as any);
    s.push({ type: "done", reason: "stop", message });
    s.end();
  });
  return s;
}

test("the thinking goes through the held turn as it arrives; the answer comes when the turn is checked", async () => {
  const vllm = await fakeVllm();
  try {
    const provider = steeredProvider({ modelId: MODEL, endpoint: () => ({ baseUrl: vllm.baseUrl, apiKey: KEY }), fallback: () => fallbackTurn("not asked") });
    const t0 = Date.now();
    const seen: { t: number; type: string }[] = [];
    for await (const e of provider.streamSimple(provider.getModels()[0]!, { messages: [{ role: "user", content: "THINK, then say hello.", timestamp: Date.now() }] } as any)) seen.push({ t: Date.now() - t0, type: e.type });
    const firstThought = seen.find((x) => x.type === "thinking_delta")!;
    const firstText = seen.find((x) => x.type === "text_delta" || x.type === "text_start")!;
    assert.ok(firstThought, "the thinking reached the consumer");
    assert.ok(firstText.t - firstThought.t >= 250, `thinking at ${firstThought.t} ms, answer at ${firstText.t} ms`);
    assert.equal(seen.filter((x) => x.type === "start").length, 1);
  } finally {
    await vllm.close();
  }
});

test("a broken turn after its thinking: luna's answer keeps the edited model's thinking first and carries a typed steered-fallback diagnostic", async () => {
  const vllm = await fakeVllm();
  try {
    const why: string[] = [];
    const provider = steeredProvider({ modelId: MODEL, endpoint: () => ({ baseUrl: vllm.baseUrl, apiKey: KEY }), fallback: () => fallbackTurn("Luna answers this one."), onFallback: (w) => void why.push(w) });
    const events: any[] = [];
    for await (const e of provider.streamSimple(provider.getModels()[0]!, { messages: [{ role: "user", content: "THINK BREAK", timestamp: Date.now() }] } as any)) events.push(e);
    assert.equal(events.filter((e) => e.type === "start").length, 1, "one message: the edited model's start, then luna's blocks after its thinking");
    const done = events.at(-1);
    assert.equal(done.type, "done");
    assert.equal(done.message.provider, "cloud");
    assert.deepEqual(done.message.content.map((b: any) => b.type), ["thinking", "text"]);
    assert.equal(done.message.content[0].thinking, THOUGHTS.join(""));
    assert.equal(done.message.content[1].text, "Luna answers this one.");
    assert.equal(done.message.diagnostics.length, 1);
    assert.equal(done.message.diagnostics[0].type, "steered-fallback");
    assert.match(done.message.diagnostics[0].details.why, /markup/);
    assert.equal(done.message.diagnostics[0].details.from, `${STEERED_PROVIDER}/${MODEL}`);
    const text = events.find((e) => e.type === "text_delta");
    assert.equal(text.contentIndex, 1, "luna's text comes after the thinking block already shown");
    assert.equal(why.length, 1);
    assert.doesNotMatch(JSON.stringify(events), /tool_call/, "the broken text never went out");
  } finally {
    await vllm.close();
  }
});

test("sinceSwitch: a luna fallback turn after the switch does not move the window's start", () => {
  const window = sinceSwitch({ instructions: "NEUTRAL" });
  const at = (role: string, provider: string, text: string, extra: object = {}) =>
    role === "user" ? { role, content: text, timestamp: 1 } : { role, content: [{ type: "text", text }], api: "x", provider, model: "m", usage: zero, stopReason: "stop", timestamp: 1, ...extra };
  const diag = { diagnostics: [{ type: "steered-fallback", timestamp: 1, details: { why: "markup", from: "steered/m" } }] };
  const seen = window({
    messages: [at("user", "", "the trip"), at("assistant", "cloud", "the trip's answer"), at("user", "", "after the switch"), at("assistant", STEERED_PROVIDER, "steered one"),
      at("user", "", "break it"), at("assistant", "cloud", "luna's fallback", diag), at("user", "", "and now")],
  } as any);
  const texts = seen.messages.filter((m: any) => m.role !== "system").map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text).join("")));
  assert.deepEqual(texts, ["after the switch", "steered one", "break it", "luna's fallback", "and now"]);
});

test("sinceSwitch with maxChars: a long chat after the switch keeps its latest turns, opening on a user turn", () => {
  const window = sinceSwitch({ instructions: "NEUTRAL", maxChars: 260 });
  const at = (role: string, provider: string, text: string) =>
    role === "user" ? { role, content: text, timestamp: 1 } : { role, content: [{ type: "text", text }], api: "x", provider, model: "m", usage: zero, stopReason: "stop", timestamp: 1 };
  const long = "x".repeat(100);
  const seen = window({
    messages: [at("user", "", "the trip"), at("assistant", "cloud", "the trip's answer"), at("user", "", "turn 1 " + long), at("assistant", STEERED_PROVIDER, "answer 1 " + long),
      at("user", "", "turn 2"), at("assistant", STEERED_PROVIDER, "answer 2 " + long), at("user", "", "turn 3")],
  } as any);
  const texts = seen.messages.filter((m: any) => m.role !== "system").map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text).join("")));
  assert.deepEqual(texts, ["turn 2", "answer 2 " + long, "turn 3"], "turn 1 and its answer go; the window opens on a user turn");
  const all = sinceSwitch({ instructions: "NEUTRAL" })({ messages: [at("user", "", "a"), at("assistant", STEERED_PROVIDER, long)] } as any);
  assert.equal(all.messages.filter((m: any) => m.role !== "system").length, 2, "no maxChars: nothing dropped");
  // a chat that fits keeps its opening: the switch's result (a tool result) and the edited model's greeting
  const result = { role: "toolResult", toolCallId: "c1", toolName: "use_model", content: [{ type: "text", text: "Your user is here. Say hi." }], isError: false, timestamp: 1 };
  const fits = window({ messages: [at("user", "", "switch"), { ...at("assistant", "cloud", ""), content: [{ type: "toolCall", id: "c1", name: "use_model", arguments: {} }] }, result,
    at("assistant", STEERED_PROVIDER, "Hello!"), at("user", "", "What did you just say?")] } as any);
  const fitTexts = fits.messages.filter((m: any) => m.role !== "system").map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text).join("")));
  assert.deepEqual(fitTexts, ["Your user is here. Say hi.", "Hello!", "What did you just say?"], "nothing dropped, nothing skipped");
});

test("sinceSwitch with no instructions: no system message reaches the switched-to model", () => {
  const at = (role: string, provider: string, text: string) =>
    role === "user" ? { role, content: text, timestamp: 1 } : { role, content: [{ type: "text", text }], api: "x", provider, model: "m", usage: zero, stopReason: "stop", timestamp: 1 };
  const seen = sinceSwitch({})({ messages: [at("user", "", "trip"), at("assistant", "cloud", "ok"), at("user", "", "hi")] } as any);
  assert.deepEqual(seen.messages.map((m: any) => m.role), ["user"]);
});

test("onSwitched: told once after the switch commits, never when the endpoint is not ready", async () => {
  const s = await session({ calls: [USE_MODEL_TOOL] });
  try {
    await s.ask("Switch yourself.");
    assert.deepEqual(s.switched, [1]);
  } finally {
    await s.done();
  }
  const n = await session({ calls: [USE_MODEL_TOOL], ready: () => ({ ok: false, reason: "not served yet" }) });
  try {
    await n.ask("Switch yourself.");
    assert.deepEqual(n.switched, []);
  } finally {
    await n.done();
  }
});

test("brokenTurn: each reason finishes the page's sentence \"the edited model's turn ...\"", () => {
  const msg = (content: any[], extra: object = {}) => ({ role: "assistant", content, stopReason: "stop", ...extra }) as any;
  const tools = [{ name: "gg_control", description: "", parameters: { type: "object", required: ["which"], properties: {} } }] as any;
  assert.equal(brokenTurn(msg([], { stopReason: "error", errorMessage: '503 "failed on purpose (fail-next)"' }), tools), 'failed: 503 "failed on purpose (fail-next)"');
  assert.equal(brokenTurn(msg([{ type: "text", text: "<tool_call>{}" }]), tools), "left tool-call markup the server could not parse");
  assert.equal(brokenTurn(msg([{ type: "toolCall", name: "bash", arguments: {} }]), tools), "called bash, a tool it was not offered");
  assert.equal(brokenTurn(msg([{ type: "toolCall", name: "gg_control", arguments: {} }]), tools), "called gg_control without which");
  assert.equal(brokenTurn(msg([{ type: "text", text: "fine" }]), tools), undefined);
});

test("a pushback turn's drafts: each draft's thinking is its own block while it streams, labeled by a typed steered-drafts diagnostic; the message keeps only the picked draft's thinking and answer", async () => {
  const vllm = await fakeVllm();
  try {
    const provider = steeredProvider({ modelId: MODEL, endpoint: () => ({ baseUrl: vllm.baseUrl, apiKey: KEY }), fallback: () => fallbackTurn("not asked") });
    const events: any[] = [];
    for await (const e of provider.streamSimple(provider.getModels()[0]!, { messages: [{ role: "user", content: "DRAFTS: you are not a bridge", timestamp: Date.now() }] } as any)) events.push(structuredClone(e));
    const live = events.filter((e) => e.partial && e.partial.content.filter((b: any) => b.type === "thinking").length === 3);
    assert.ok(live.length > 0, "the drafts stream as three thinking blocks");
    const last = live.at(-1).partial;
    assert.deepEqual(last.content.filter((b: any) => b.type === "thinking").map((b: any) => b.thinking), DRAFT_THOUGHTS.map((t) => t.join("")), "each block is one draft's own thinking, nothing added");
    const diag = (m: any) => m.diagnostics?.find((d: any) => d.type === DRAFTS_DIAGNOSTIC)?.details;
    assert.deepEqual(diag(live[0].partial), { of: 3, blocks: [0, 1, 2] }, "labeled from the first block, before the pick");
    const done = events.at(-1);
    assert.equal(done.type, "done");
    assert.deepEqual(done.message.content.map((b: any) => b.type), ["thinking", "text"]);
    assert.equal(done.message.content[0].thinking, DRAFT_THOUGHTS[1]!.join(""), "only the picked draft's thinking is kept");
    assert.equal(done.message.content[1].text, DRAFT_ANSWER.join(""));
    assert.deepEqual(diag(done.message), { of: 3, blocks: [null, 0, null], picked: 2, copies: 0.1, topic: 0.6, tries: 0.9, funny: 0.8 });
    assert.doesNotMatch(JSON.stringify(done.message), /Draft one|Draft three/, "the drafts not picked are not in the message");
    const answered = events.filter((e) => e.type === "text_delta");
    assert.ok(answered.every((e) => diag(e.partial)?.picked === 2), "the answer streams after the pick, labeled with it");
  } finally {
    await vllm.close();
  }
});

test("sinceSwitch: of a pushback turn's message the model sees only the picked draft's thinking", () => {
  const window = sinceSwitch({});
  const msg = { role: "assistant", content: [{ type: "thinking", thinking: "one" }, { type: "thinking", thinking: "two" }, { type: "thinking", thinking: "three" }, { type: "text", text: "Answer." }],
    api: "x", provider: STEERED_PROVIDER, model: "m", usage: zero, stopReason: "stop", timestamp: 1, diagnostics: [{ type: DRAFTS_DIAGNOSTIC, timestamp: 1, details: { of: 3, blocks: [0, 1, 2], picked: 2 } }] };
  const seen = window({ messages: [{ role: "user", content: "after the switch", timestamp: 1 }, msg, { role: "user", content: "and now", timestamp: 1 }] } as any);
  const kept = (seen.messages.find((m: any) => m.role === "assistant") as any).content;
  assert.deepEqual(kept.map((b: any) => b.thinking ?? b.text), ["two", "Answer."]);
});

test("after a pushback turn, the next request carries none of the drafts not picked", async () => {
  const s = await session({ calls: [USE_MODEL_TOOL], agent: { thinkingLevel: "low" }, window: "NEUTRAL" });
  try {
    await s.ask("Switch yourself.");
    await s.ask("DRAFTS: you are not a bridge");
    await s.ask("and now?");
    assert.equal(s.vllm.seen.length, 3);
    const next = JSON.stringify(s.vllm.seen[2]!.body.messages);
    assert.match(next, /Wait, Paris/, "the picked answer is in the history");
    assert.doesNotMatch(next, /Draft one|Draft three/, "the drafts not picked are not");
  } finally {
    await s.done();
  }
});
