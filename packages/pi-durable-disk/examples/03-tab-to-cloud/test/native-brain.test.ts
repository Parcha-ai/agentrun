// The whole native-template path over a real Harness, real robot tools and a real Node computer, with a scripted model that answers in OpenAI tool_calls: "make it a red spider" is ONE model turn with
// two calls, pi runs both, the model reads the results and says one line; the same conversation, the model's own template asked for (jinja, a larger context, thinking off), a warm-up turn first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { agentRegistry, cloudAgent, rootAgent } from "../agent.ts";
import { Brain } from "../tab/brain.ts";
import { BRAIN_PROVIDER } from "../tab/brain-provider.ts";
import { narrowEnum, toNativeTools } from "../tab/native-turn.ts";
import { ROBOT_FILE } from "../robot-tools.ts";
import { parseRobot } from "../robot-model.ts";
import { modelDisk, scripted } from "./_brain.ts";
import type { ToolChatRequest } from "../../04-walks-home/tab/src/modelhost.ts";

const SYSTEM = "You control a small walking robot that lives in the user's browser. When the user asks to change the robot, call the tools that make that change.";
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("a native-template model: warm-up, one turn with two tool calls, pi runs them, one closing line, in the same conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-brain-"));
  try {
    const env = new NodeExecutionEnv({ cwd: dir, shellEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" } });
    const registry = agentRegistry(async () => undefined, { switchTool: false });
    const models = createModels();
    // the cloud model that "did the trip": never asked here
    const stream = (m: any) => { const s = createAssistantMessageEventStream(); const message: any = { role: "assistant", content: [{ type: "text", text: "Cloud." }], api: m.api, provider: m.provider, model: m.id, usage: zero, stopReason: "stop", timestamp: Date.now() }; queueMicrotask(() => { s.push({ type: "start", partial: message }); s.push({ type: "done", reason: "stop", message }); s.end(); }); return s; };
    models.setProvider(createProvider({ id: "pipe", name: "c", auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "x" } }) } }, models: [{ id: "cloud-big", name: "c", api: "openai-responses", provider: "pipe", baseUrl: "x", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000 }], api: { stream, streamSimple: stream } as never }));
    const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, ctx);
    const root = await harness.root(ctx, { agent: rootAgent("cloud-big") });
    const disk = modelDisk();
    const base = scripted(() => "<thinking>hi</thinking>\nHello.");
    const requests: ToolChatRequest[] = [];
    const loads: { jinja?: boolean; nCtx?: number }[] = [];
    let round = 0, prepared = 0;
    let skills = ["walk"]; // what home/skills.json names: it gains sprint between the two model turns of this task
    const llm = {
      ...base.llm,
      async load(parts: unknown[], o: { jinja?: boolean; nCtx?: number }) { loads.push({ jinja: o.jinja, nCtx: o.nCtx }); },
      async chatTools(req: ToolChatRequest) {
        requests.push(req);
        if (req.maxTokens === 1) { await new Promise((r) => setTimeout(r, 80)); return { text: "", toolCalls: [], stoppedBy: "length" as const, promptTokens: 300, outputTokens: 1, ms: 5 }; } // the warm-up, slow enough that a turn sent now would meet it
        const last = req.messages.at(-1)!;
        if (last.role === "user") return { text: "", toolCalls: [{ id: "c1", name: "morph", arguments: '{"preset":"spider"}' }, { id: "c2", name: "set_color", arguments: '{"part":"all","color":"red"}' }], stoppedBy: "tool_calls" as const, promptTokens: 320, outputTokens: 30, ms: 10 };
        round++;
        return { text: "Done: the robot is now a red spider. It will need to be retrained to walk well.", toolCalls: [], stoppedBy: "stop" as const, promptTokens: 400, outputTokens: 20, ms: 10 };
      },
    };
    const robotTools = registry.snapshot().tools().filter((t) => ["set_color", "set_shape", "set_face", "rename", "resize", "scale", "set_legs", "morph", "reset", "do", "update_robot"].includes(t.tool.name)).map((t) => t.tool);
    const brain = new Brain({ mode: "configure", route: false, harness, models, root, readFile: async (p) => disk.files.get(p) ?? null, judge: async () => "show", llm: llm as never, threads: 2, context: ctx, native: { nCtx: 4096 }, tools: robotTools, instructions: SYSTEM,
      decoding: { mode: "native", system: SYSTEM, nCtx: 4096, history: "none", prepare: async () => { prepared++; skills = prepared === 1 ? ["walk"] : ["walk", "sprint"]; }, refine: (t) => narrowEnum(t, "skill", skills) } });
    const conv = await brain.start(disk.manifest);
    assert.equal(conv?.id, root.id, "the same conversation");
    assert.deepEqual(loads, [{ jinja: true, nCtx: 4096 }], "loaded with the model's own template and the larger context");
    const warming = brain.warm(SYSTEM, toNativeTools((await root.agent(ctx)).tools)); // not awaited: the first command arrives while the model is still being warmed
    assert.equal(requests[0]!.maxTokens, 1);
    assert.deepEqual(requests[0]!.templateKwargs, { enable_thinking: false });

    await (await root.submit({ type: "input", content: "Make it a red spider." }, ctx)).wait(ctx);
    assert.ok((await warming) !== undefined, "the warm-up turn ran, and the command waited for it instead of being refused as busy");
    const text = readFileSync(join(dir, ROBOT_FILE), "utf8"); const state = parseRobot(text)!; assert.ok(state, text.slice(0, 400));
    assert.equal(state.design.legs.length, 3, "morph spider ran");
    assert.equal(state.look.torso, "red", "set_color all red ran after it, so the colour wins over the spider's black");
    const turn = requests.filter((r) => r.maxTokens !== 1);
    assert.equal(turn.length, 2, "two model turns: the calls, then the line");
    assert.equal(turn[0]!.messages[0]!.role, "system");
    assert.deepEqual(turn[0]!.tools.map((t) => t.function.name).sort(), ["do", "morph", "rename", "reset", "resize", "scale", "set_color", "set_face", "set_legs", "set_shape", "update_robot"]);
const skillEnum = (r: ToolChatRequest) => (r.tools.find((t) => t.function.name === "do")!.function.parameters as { properties: { skill: { enum: string[] } } }).properties.skill.enum;
    assert.deepEqual(skillEnum(turn[0]!), ["walk"], "the skill lock is the model's narrowed view");
    assert.deepEqual(skillEnum(turn[1]!), ["walk", "sprint"], "a skill that came home between two turns is on offer in the very next request (the list is refreshed before the request is built)");
    assert.equal(prepared, 2);
    assert.deepEqual(turn[0]!.templateKwargs, { enable_thinking: false });
    assert.deepEqual(turn[1]!.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "tool"], "the request, the model's two calls, their two results");
    assert.match((turn[1]!.messages.at(-1) as { content: string }).content, /^The whole robot is now red\. Looks only/);
    assert.equal(round, 1);
    const agent = await root.agent(ctx);
    assert.equal(agent.model?.provider, BRAIN_PROVIDER);
    const answered = ((await root.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; model?: { provider?: string; content?: { type: string; text?: string }[] }[] }[]).filter((e) => e.kind === "pi.assistant" && e.model?.[0]?.provider === BRAIN_PROVIDER);
    assert.match(answered[0]!.model![0]!.content!.map((c) => c.text ?? "").join(""), /red spider/);
    // back to the cloud: the same conversation, the whole registry
    await root.configure(cloudAgent("cloud-big"), ctx);
    assert.equal((await root.agent(ctx)).model?.provider, "pipe");
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
