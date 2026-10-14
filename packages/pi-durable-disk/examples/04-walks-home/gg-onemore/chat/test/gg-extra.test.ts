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
import { BASE_PROVIDER, GG_INSTRUCTIONS, GG_MODEL, ggExtra, readSecretsOnce, servedDetail } from "../gg-extra.ts";
import { STEER_DISPLAY, STEER_INSTRUCTIONS, STEER_PAGE } from "../steer-text.ts";
import { STEERED_PROVIDER } from "../../pi/use-model.ts";
import { GG_PROVIDER } from "../gg-text.ts";
import { execFileSync } from "node:child_process";

const SERVE = "serve-key";
const TOOLS = "tools-key";
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const GG_SERVED = { kind: "clamp", layer: 36, k: 1.2, parts: [{ feature: 53796, what: "bridges", max: 19 }, { feature: 23249, what: "California", max: 19.3 }] };

async function fakeGuard(served: object = GG_SERVED) {
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
        // asked for the control while offered it, it calls gg_control once; after the tool's result it answers in text
        const wantsControl = JSON.stringify(lastUser?.content ?? "").includes("control") && body.messages.at(-1).role !== "tool" && (body.tools ?? []).length > 0;
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
      if (req.url === "/gg/reading")
        return json({
          files: [{ name: "paper.txt", text: "Scaling Monosemanticity" }, { name: "../escape.txt", text: "x" }],
          skill: "# Golden Gate Claude, by your own hand",
          skills: { "golden-gate": "# Golden Gate Claude, by your own hand", obsession: "# Obsessed with X, by your own hand", "../up": "x" },
        });
      if (req.url === "/gg/served") return json({ served });
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

test("the extra: unused extensions out, GG tools in; the reading lands in the workspace; use_model moves to the edited model, which gets no tool and no system prompt", async () => {
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
    models.setProvider(base(["lab_read", "use_model"]));
    extra.models(models);
    assert.equal(models.getModel(STEERED_PROVIDER, GG_MODEL)?.name, "Qwen3.5-27B (Golden Gate edit)", "the page shows the registered name");
    assert.equal(models.getModel(STEERED_PROVIDER, GG_MODEL)?.contextWindow, 200000, "measured against the base model's context, so no compaction runs on the edited model");
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: BASE_PROVIDER, modelId: "base-model" }, thinkingLevel: "low", instructions: extra.instructions.text } });
    const ask = async (text: string) => void (await (await root.submit({ type: "input", content: text }, ctx)).wait(ctx));
    try {
      await ask("Recreate Golden Gate Claude on the Qwen on your GPU box.");
      assert.equal(readFileSync(join(work, "reading", "paper.txt"), "utf8"), "Scaling Monosemanticity");
      assert.equal(readFileSync(join(work, "skills", "golden-gate", "SKILL.md"), "utf8"), "# Golden Gate Claude, by your own hand", "the skill lands in the workspace");
      assert.equal(readFileSync(join(work, "skills", "obsession", "SKILL.md"), "utf8"), "# Obsessed with X, by your own hand", "and every other skill the box ships");
      assert.equal(existsSync(join(work, "up", "SKILL.md")), false, "a skill's name is one path segment inside skills/");
      assert.equal(models.getModel(STEERED_PROVIDER, GG_MODEL)?.name, "Qwen3.5-27B (Golden Gate edit)", "an edit served without a name keeps the page's");
      assert.equal(existsSync(join(work, "reading", "escape.txt")), true, "a name with a path is kept to its last part, inside reading/");
      assert.deepEqual((await root.agent(ctx)).model, { provider: STEERED_PROVIDER, modelId: GG_MODEL });
      assert.equal(g.chats.length, 1, "the next request of the same turn went to the edited model");
      assert.equal(g.chats[0].model, GG_MODEL);
      // what the edited model reads: the switch's result and nothing else: no system prompt, no tool, no word of the trip
      assert.equal(g.chats[0].tools, undefined, "no tool is offered to the edited model");
      assert.equal(g.chats[0].messages.some((m: any) => m.role === "system" || m.role === "developer"), false, "no system prompt");
      assert.deepEqual(g.chats[0].messages.map((m: any) => m.role), ["user"]);
      // the thinking budget the page sends is the one the strength probes use: one number, pipeline/data/thinking.json
      const budget = JSON.parse(readFileSync(new URL("../../pipeline/data/thinking.json", import.meta.url), "utf8")).thinking_token_budget;
      const probes = Number(execFileSync("python3", ["-c", "from thinking import THINK_BUDGET; print(THINK_BUDGET)"], { cwd: new URL("../../pipeline", import.meta.url), encoding: "utf8" }));
      assert.equal(probes, budget, "the strength probes read the shared budget");
      assert.equal(g.chats[0].thinking_token_budget, budget, "the page sends the shared budget");
      assert.ok(g.chats[0].max_tokens - budget >= 900, "the answer keeps its room after the thinking");
      assert.doesNotMatch(JSON.stringify(g.chats[0]), /bridge|golden gate|obsess/i, "nothing the edited model reads mentions the bridge");
      // and nothing tells it who it is or how to behave: no model name, no "AI agent", no length cap to argue with
      const opening = g.chats[0].messages.filter((m: any) => m.role !== "assistant").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      assert.doesNotMatch(opening, /running on|qwen|assistant|AI agent|short sentences/i, "the edited model's opening claims no identity, not even an assistant");
      const recorded = readFileSync(join(work, "gg", "requests.jsonl"), "utf8").trim().split("\n");
      assert.equal(recorded.length, 1);
      assert.ok(logs.some((l) => l.event === "gg.switched"));
      await ask("Show me the control.");
      assert.equal(g.chats.length, 2, "the edited model answers in text: it has no tool to call");
      assert.equal(g.control.length, 0);
      const reloaded = await ggExtra({ work, log: () => undefined }, { guardUrl: g.url, serveKey: SERVE, toolsKey: TOOLS }, { modelId: "base-model" });
      assert.deepEqual(await reloaded.recorded(), await extra.recorded(), "a restart reads the recorded requests back");
      assert.equal((await reloaded.recorded()).length, 2);
    } finally {
      await harness.close?.(ctx);
    }
  } finally {
    await g.close();
  }
});

test("the any-topic page: its own instructions and skill, and from the switch on the header names the served recipe", async () => {
  const g = await fakeGuard({ parts: [{ layer: 32, feature: 101, value: 14.2, what: "cats as pets" }], adds: [], topic: "cats", display: "Qwen3.5-27B, obsessed with cats" });
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "steer-work-"));
  try {
    const extra = await ggExtra({ work, log: () => undefined }, { guardUrl: g.url, serveKey: SERVE, toolsKey: TOOLS }, { modelId: "base-model" }, {}, STEER_PAGE);
    assert.deepEqual(extra.instructions, { mode: "replace", text: STEER_INSTRUCTIONS });
    assert.match(STEER_INSTRUCTIONS, /skills\/obsession\/SKILL\.md/);
    assert.doesNotMatch(STEER_INSTRUCTIONS, /gg_|gglab/, "the page names the general tools");
    const registry = agentRegistry(async () => undefined);
    extra.install(registry);
    const models = createModels();
    models.setProvider(base(["lab_read", "use_model"]));
    extra.models(models);
    assert.equal(models.getModel(STEERED_PROVIDER, GG_MODEL)?.name, STEER_DISPLAY, "before anything is served, the page's own name");
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: BASE_PROVIDER, modelId: "base-model" }, thinkingLevel: "low", instructions: extra.instructions.text } });
    try {
      await (await root.submit({ type: "input", content: "Make yourself obsessed with cats." }, ctx)).wait(ctx);
      assert.equal(readFileSync(join(work, "skills", "obsession", "SKILL.md"), "utf8"), "# Obsessed with X, by your own hand");
      assert.deepEqual((await root.agent(ctx)).model, { provider: STEERED_PROVIDER, modelId: GG_MODEL });
      assert.equal(models.getModel(STEERED_PROVIDER, GG_MODEL)?.name, "Qwen3.5-27B, obsessed with cats", "the header's name is the recipe's");
      assert.equal(g.chats.length, 1, "the re-registered provider answered the same turn");
      assert.doesNotMatch(JSON.stringify(g.chats[0]), /cats|obsess/i, "the edited model reads no word of its topic");
    } finally {
      await harness.close?.(ctx);
    }
  } finally {
    await g.close();
  }
});

test("use_model's check describes what is served: parts by layer, added directions", () => {
  assert.equal(servedDetail(GG_SERVED as never), "2 SAE features clamped at layer 36");
  assert.equal(servedDetail({ parts: [{ layer: 32, feature: 1 }, { layer: 36, feature: 2 }], adds: [{ layer: 32, f: 0.4 }] } as never), "2 SAE features clamped at layer 32, 36 and a direction added at layer 32 (f 0.4)");
  assert.equal(servedDetail({ parts: [], adds: [{ layer: 28, f: 0.5 }] } as never), "a direction added at layer 28 (f 0.5)");
});
