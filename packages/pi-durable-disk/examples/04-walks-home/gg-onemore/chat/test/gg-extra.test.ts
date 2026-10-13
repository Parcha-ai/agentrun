// The GG page's cloud-app extra over a real Harness and 03's real registry: the keys are read once and deleted, the
// extensions the page does not use are gone, the reading lands in the workspace, use_model moves the conversation to the
// edited model behind a fake guard (its requests recorded on the run's disk), and the control replays the switch request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { agentRegistry } from "../../../../03-tab-to-cloud/agent.ts";
import { BASE_PROVIDER, GG_INSTRUCTIONS, GG_MODEL, ggExtra, readSecretsOnce } from "../gg-extra.ts";
import { STEERED_PROVIDER } from "../../pi/use-model.ts";
import { GG_PROVIDER } from "../gg-text.ts";

const SERVE = "serve-key";
const TOOLS = "tools-key";
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fakeGuard() {
  const chats: any[] = [];
  const control: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const auth = req.headers.authorization;
      if (req.url === "/v1/chat/completions" && auth === `Bearer ${SERVE}`) {
        chats.push(body);
        const lastUser = [...body.messages].reverse().find((m: any) => m.role === "user");
        // asked for the control, it calls gg_control once; after the tool's result it answers in text
        const wantsControl = JSON.stringify(lastUser?.content ?? "").includes("control") && body.messages.at(-1).role !== "tool";
        const chunk = (choices: unknown[], extra: object = {}) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: body.model, choices, ...extra })}\n\n`);
        res.writeHead(200, { "content-type": "text/event-stream" });
        chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
        chunk([{ index: 0, delta: { reasoning_content: "The fog rolls in. " }, finish_reason: null }]);
        if (wantsControl) {
          chunk([{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "gg_control", arguments: "{}" } }] }, finish_reason: null }]);
          chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
        } else {
          chunk([{ index: 0, delta: { content: "I am the Golden Gate Bridge." }, finish_reason: null }]);
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
        }
        chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        return void res.end("data: [DONE]\n\n");
      }
      if (auth !== `Bearer ${TOOLS}`) return void res.writeHead(404).end();
      const json = (x: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(x));
      if (req.url === "/gg/reading") return json({ files: [{ name: "paper.txt", text: "Scaling Monosemanticity" }, { name: "../escape.txt", text: "x" }] });
      if (req.url === "/gg/served") return json({ served: { layer: 32, scale: 50.2, f: 0.6 } });
      if (req.url === "/gg/control") {
        control.push(body);
        return json({ original: ["Hello!"], edited: ["Fog and steel."] });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { chats, control, url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The base model: one scripted tool call per request, then a closing line. */
function base(calls: string[]) {
  let n = 0;
  const stream = (model: any) => {
    const s = createAssistantMessageEventStream();
    const name = calls[n++];
    const content = name ? [{ type: "toolCall", id: `base-${n}`, name, arguments: {} }] : [{ type: "text", text: "Base model here." }];
    const message: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: name ? "toolUse" : "stop", timestamp: Date.now() };
    queueMicrotask(() => {
      s.push({ type: "start", partial: message });
      s.push({ type: "done", reason: message.stopReason, message });
      s.end();
    });
    return s;
  };
  return createProvider({
    id: BASE_PROVIDER,
    name: "base",
    auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "x" } }) } },
    models: [{ id: "base-model", name: "base", api: "openai-responses", provider: BASE_PROVIDER, baseUrl: "x", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16000 }],
    api: { stream, streamSimple: stream } as never,
  });
}

test("the page's portable names match the provider's", () => {
  assert.equal(GG_PROVIDER, STEERED_PROVIDER);
});

test("secrets: each is read once and deleted; a second read says they must be staged again", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-secrets-"));
  writeFileSync(join(dir, "guard-url"), "https://box.example/\n");
  writeFileSync(join(dir, "serve-key"), "s\n");
  writeFileSync(join(dir, "tools-key"), "t\n");
  assert.deepEqual(await readSecretsOnce(dir), { guardUrl: "https://box.example", serveKey: "s", toolsKey: "t" });
  for (const f of ["guard-url", "serve-key", "tools-key"]) assert.equal(existsSync(join(dir, f)), false);
  await assert.rejects(readSecretsOnce(dir), /gone: they are read once, and a process restarted on this VM needs them staged again/);
});

test("the extra: unused extensions out, GG tools in; the reading lands in the workspace; use_model moves to the edited model; the control replays the switch", async () => {
  const g = await fakeGuard();
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-work-"));
  try {
    const logs: { event: string; data?: unknown }[] = [];
    const extra = await ggExtra({ work, log: (event, data) => void logs.push({ event, data }) }, { guardUrl: g.url, serveKey: SERVE, toolsKey: TOOLS }, { modelId: "base-model" });
    assert.deepEqual(extra.instructions, { mode: "replace", text: GG_INSTRUCTIONS });
    const registry = agentRegistry(async () => undefined);
    extra.install(registry);
    // what the host does with withoutExtensions (it refuses a name that is not installed)
    for (const name of extra.withoutExtensions) registry.uninstall(registry.snapshot().extension(name) ?? assert.fail(`${name} is not installed`));
    assert.deepEqual(registry.snapshot().installed().map((e) => e.name), ["coding-tools", "workspace-write-through", "gg-tools", "gg-use-model"]);
    const models = createModels();
    models.setProvider(base(["gg_read", "use_model"]));
    extra.models(models);
    assert.equal(models.getModel(STEERED_PROVIDER, GG_MODEL)?.name, "Qwen3.5-27B (Golden Gate edit)", "the page shows the registered name");
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: BASE_PROVIDER, modelId: "base-model" }, thinkingLevel: "low", instructions: extra.instructions.text } });
    const ask = async (text: string) => void (await (await root.submit({ type: "input", content: text }, ctx)).wait(ctx));
    try {
      await ask("Recreate Golden Gate Claude on the Qwen on your GPU box.");
      assert.equal(readFileSync(join(work, "reading", "paper.txt"), "utf8"), "Scaling Monosemanticity");
      assert.equal(existsSync(join(work, "reading", "escape.txt")), true, "a name with a path is kept to its last part, inside reading/");
      assert.deepEqual((await root.agent(ctx)).model, { provider: STEERED_PROVIDER, modelId: GG_MODEL });
      assert.equal(g.chats.length, 1, "the next request of the same turn went to the edited model");
      assert.equal(g.chats[0].model, GG_MODEL);
      // what the edited model reads: its own system prompt, the switch's result, one tool (the control), and no word of the trip
      assert.deepEqual(g.chats[0].tools.map((t: any) => t.function.name), ["gg_control"]);
      assert.doesNotMatch(JSON.stringify(g.chats[0]), /bridge|golden gate|obsess/i, "nothing the edited model reads mentions the bridge");
      const recorded = readFileSync(join(work, "gg", "requests.jsonl"), "utf8").trim().split("\n");
      assert.equal(recorded.length, 1);
      assert.ok(logs.some((l) => l.event === "gg.switched"));
      await ask("Show me the control.");
      assert.equal(g.control.length, 1);
      assert.deepEqual(g.control[0].body, g.chats[0], "the control replays the request that switched it");
      const reloaded = await ggExtra({ work, log: () => undefined }, { guardUrl: g.url, serveKey: SERVE, toolsKey: TOOLS }, { modelId: "base-model" });
      assert.deepEqual(await reloaded.recorded(), await extra.recorded(), "a restart reads the recorded requests back");
      assert.equal((await reloaded.recorded()).length, 3, "the switch's request, and the control turn's two (its call, then its answer)");
    } finally {
      await harness.close?.(ctx);
    }
  } finally {
    await g.close();
  }
});
