// Routed brains: the page decides per message which brain answers (brain-router.ts), and the ONE conversation is configured onto it only when it changes. Over a real pi-durable Harness
// with real tools: the model is loaded and registered but the conversation stays on the cloud model until `use`; a run of local turns configures once (the 1B's prompt cache survives it);
// going back to the cloud restores the whole registry; the conversation id never changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { agentRegistry, cloudAgent, rootAgent } from "../agent.ts";
import { Brain, BRAIN_SWAP } from "../tab/brain.ts";
import { BRAIN_PROVIDER } from "../tab/brain-provider.ts";
import { modelDisk, scripted } from "./_brain.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function cloud(seen: { tools: string[]; roles: string[] }[]) {
  const stream = (model: any, context: any) => {
    const names = (getCurrentTools(context.messages) as { name: string }[]).map((t) => t.name);
    seen.push({ tools: names, roles: context.messages.map((m: { role: string }) => m.role) });
    const s = createAssistantMessageEventStream();
    const message: any = { role: "assistant", content: [{ type: "text", text: "Cloud: done." }], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: "stop", timestamp: Date.now() };
    queueMicrotask(() => { s.push({ type: "start", partial: message }); s.push({ type: "done", reason: "stop", message }); s.end(); });
    return s;
  };
  return createProvider({ id: "pipe", name: "cloud", auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "x" } }) } }, models: [{ id: "cloud-big", name: "cloud", api: "openai-responses", provider: "pipe", baseUrl: "x", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16000 }], api: { stream, streamSimple: stream } as never });
}

test("a routed brain is loaded and registered but the conversation stays on the cloud model until `use`; it is configured only when the brain changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "route-"));
  try {
    const env = new NodeExecutionEnv({ cwd: dir, shellEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" } });
    const registry = agentRegistry(async () => undefined, { switchTool: false });
    const models = createModels();
    const seen: { tools: string[]; roles: string[] }[] = [];
    models.setProvider(cloud(seen));
    const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, ctx);
    const root = await harness.root(ctx, { agent: rootAgent("cloud-big") });
    const ask = async (text: string) => void (await (await root.submit({ type: "input", content: text }, ctx)).wait(ctx));
    await ask("hello from before");
    const disk = modelDisk();
    const m = scripted((q) => `<thinking>The user asked: ${q}.</thinking>\nLocal: ${q}.`);
    const tools = registry.snapshot().tools().filter((t) => ["read", "write", "bash"].includes(t.tool.name)).map((t) => t.tool);
    const brain = new Brain({ route: true, mode: "configure", harness, models, root, readFile: async (p) => disk.files.get(p) ?? null, judge: async () => "show", llm: m.llm, threads: 2, context: ctx, tools });
    const conversation = await brain.start(disk.manifest);
    assert.equal(conversation?.id, root.id, "one conversation");
    assert.equal(await brain.current(), "cloud", "loaded, but the conversation is still on the cloud model");
    assert.equal((await root.agent(ctx)).model?.provider, "pipe");
    assert.equal(((await root.entries({}, 100, undefined, ctx)).items as unknown as { kind: string }[]).some((e) => e.kind === BRAIN_SWAP), false, "no swap was announced: nothing was configured");

    assert.equal(await brain.use("cloud", cloudAgent("cloud-big")), false, "already there: nothing to configure");
    assert.equal(await brain.use("tab-local", cloudAgent("cloud-big")), true);
    assert.equal(brain.switches, 1);
    const local = await root.agent(ctx);
    assert.equal(local.model?.provider, BRAIN_PROVIDER);
    assert.deepEqual(local.tools.map((t) => t.name).sort(), ["bash", "read", "write"], "the 1B's tools: read, write and bash");
    await ask("write hi.js and run it");
    await ask("and what is in it?");
    assert.equal(await brain.use("tab-local", cloudAgent("cloud-big")), false, "a run of local turns configures once");
    assert.equal(brain.switches, 1);
    assert.ok(m.prompts.length >= 2, "the 1B answered both");

    assert.equal(await brain.use("cloud", cloudAgent("cloud-big")), true);
    assert.equal(brain.switches, 2);
    const back = await root.agent(ctx);
    assert.equal(back.model?.provider, "pipe");
    assert.ok(["read", "write", "edit", "bash", "go_offline", "go_online"].every((n) => back.tools.some((t) => t.name === n)), "the whole registry again");
    await ask("make the model obsessed with the Golden Gate Bridge");
    const last = seen.at(-1)!;
    assert.ok(last.tools.includes("go_offline") && last.tools.includes("edit"), "the cloud model is offered everything");
    assert.ok(last.roles.filter((r) => r === "assistant").length >= 3, "and shown the same conversation, the 1B's turns included");
    assert.equal(root.id, conversation?.id);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
