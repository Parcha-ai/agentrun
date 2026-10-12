// A model with its own tool template: pi's transcript into OpenAI-shaped messages and tools, the reply back into pi's blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { agentRegistry, rootAgent } from "../agent.ts";
import { narrowEnum, nativeContent, nativeTurn, parseTaggedCalls, toolProperties } from "../tab/native-turn.ts";
import { BRAIN_PROVIDER } from "../tab/brain-provider.ts";

const text = (t: string) => ({ type: "text", text: t });
const transcript = (...rest: unknown[]) => rest; // what a provider is handed, as far as the window reads it

test("over a real Harness: the conversation's tools go out as OpenAI function tools with the narrowed enum, and the next request is the system prompt, the request, the call as tool_calls and its result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-turn-"));
  try {
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home/skills.json"), JSON.stringify({ version: 1, body_mjcf_sha256: "x", default: "walk", skills: { walk: { policy: "skills/walk.json", command: 0.5, label: "walk" }, sprint: { policy: "skills/sprint.json", command: 1.2, label: "sprint" } } }));
    const env = new NodeExecutionEnv({ cwd: dir, shellEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" } });
    const registry = agentRegistry(async () => undefined, { switchTool: false });
    const captured: unknown[][] = [];
    let n = 0;
    const stream = (model: any, context: any) => {
      captured.push(context.messages);
      const s = createAssistantMessageEventStream();
      const content = n++ === 0 ? [{ type: "toolCall", id: "t1", name: "do", arguments: { skill: "sprint" } }] : [{ type: "text", text: "Sprinting." }];
      const message: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: n === 1 ? "toolUse" : "stop", timestamp: Date.now() };
      queueMicrotask(() => { s.push({ type: "start", partial: message }); s.push({ type: "done", reason: message.stopReason, message }); s.end(); });
      return s;
    };
    const models = createModels();
    models.setProvider(createProvider({ id: "pipe", name: "x", auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "x" } }) } }, models: [{ id: "m", name: "m", api: "openai-responses", provider: "pipe", baseUrl: "x", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000 }], api: { stream, streamSimple: stream } as never }));
    const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, ctx);
    const root = await harness.root(ctx, { agent: rootAgent("m") });
    await root.configure({ tools: registry.snapshot().tools().filter((t) => ["do", "update_robot"].includes(t.tool.name)).map((t) => t.tool), instructions: "You control a robot." }, ctx);
    await (await root.submit({ type: "input", content: "sprint!" }, ctx)).wait(ctx);
    const refine = (tools: ReturnType<typeof narrowEnum>) => narrowEnum(tools, "skill", ["walk", "sprint"]);
    const first = nativeTurn(captured[0]!, { provider: "pipe", mode: "none", system: "You control a robot.", refine });
    assert.deepEqual(first.messages, [{ role: "system", content: "You control a robot." }, { role: "user", content: "sprint!" }]);
    assert.deepEqual(first.tools.map((t) => t.function.name), ["do", "update_robot"]);
    const lock = (first.tools[0]!.function.parameters as { properties: { skill: { enum: string[] } } }).properties.skill.enum;
    assert.deepEqual(lock, ["walk", "sprint"], "the model is offered only the skills that came home");
    const flat = (first.tools[1]!.function.parameters as { properties: { skill: { enum: string[] } } }).properties.skill.enum;
    assert.deepEqual(flat, ["walk", "sprint"], "and so does the flat tool");
    const unrefined = nativeTurn(captured[0]!, { provider: "pipe", mode: "none" }).tools.find((t) => t.function.name === "do")!.function.parameters as { properties: { skill: { enum?: string[]; type: string } } };
    assert.equal(unrefined.properties.skill.enum, undefined, "unrefined, the registry's own skill is a free name (the cluster names skills): no list of eight in the schema");
    assert.equal(unrefined.properties.skill.type, "string");
    // the request after the tool ran: the call and its result are in the window (this check treats "pipe" as the model's own provider)
    const second = nativeTurn(captured[1]!, { provider: "pipe", mode: "none", system: "You control a robot.", refine });
    assert.deepEqual(second.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.deepEqual((second.messages[2] as { tool_calls: { function: { name: string; arguments: string } }[] }).tool_calls[0]!.function, { name: "do", arguments: '{"skill":"sprint"}' });
    assert.match((second.messages[3] as { content: string }).content, /^The robot is now doing sprint\./);
    await harness.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseTaggedCalls: MiniCPM's stripped tags give calls; a tool name starts one, other keys are arguments, numbers are numbers", () => {
  const names = ["morph", "set_color", "scale"];
  assert.deepEqual(parseTaggedCalls(' name="morph"> name="preset">spider name="set_color"> name="part">all name="color">red', names), [{ name: "morph", arguments: { preset: "spider" } }, { name: "set_color", arguments: { part: "all", color: "red" } }]);
  assert.deepEqual(parseTaggedCalls(' name="scale"> name="factor">2', names), [{ name: "scale", arguments: { factor: 2 } }]);
  assert.deepEqual(parseTaggedCalls("Just chatting.", names), []);
  assert.deepEqual(parseTaggedCalls(' name="color">red', names), [], "an argument with no call before it is nothing");
});

test("nativeContent: the runtime's tool_calls become pi tool calls; a call with bad arguments is a problem, not a call; thinking is split off; the tagged text is the fallback", () => {
  const names = ["set_color"];
  const ok = nativeContent({ text: "", toolCalls: [{ id: "a", name: "set_color", arguments: '{"part":"legs","color":"red"}' }] }, names);
  assert.deepEqual(ok.content, [{ type: "toolCall", id: "a", name: "set_color", arguments: { part: "legs", color: "red" } }]);
  assert.equal(ok.calls, 1);
  const bad = nativeContent({ text: "", toolCalls: [{ id: "a", name: "set_color", arguments: '{"part":' }] }, names);
  assert.equal(bad.calls, 0);
  assert.match(bad.problems[0]!, /not JSON/);
  const thought = nativeContent({ text: "<think>The user wants red.</think>Done, they are red.", toolCalls: [] }, names);
  assert.deepEqual(thought.content, [{ type: "thinking", thinking: "The user wants red." }, { type: "text", text: "Done, they are red." }]);
  const tagged = nativeContent({ text: ' name="set_color"> name="part">legs name="color">red', toolCalls: [] }, names);
  assert.deepEqual(tagged.content, [{ type: "toolCall", id: "call-0", name: "set_color", arguments: { part: "legs", color: "red" } }]);
});

test("nativeTurn: the system prompt first, the request, the model's own calls as tool_calls and their results as tool messages; another model's turns are never shown", () => {
  const luna = { role: "assistant", provider: "pipe", content: [text("Luna says hi")] };
  const mine = (id: string, name: string, args: unknown) => ({ role: "assistant", provider: BRAIN_PROVIDER, content: [{ type: "toolCall", id, name, arguments: args }] });
  const result = (id: string, name: string, t: string) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [text(t)], isError: false });
  const messages = transcript({ role: "user", content: "an earlier chat" }, luna, { role: "user", content: "make it a red spider" }, mine("c1", "morph", { preset: "spider" }), result("c1", "morph", "The robot is now a spider."));
  const t = nativeTurn(messages, { provider: BRAIN_PROVIDER, mode: "none", system: "You control a robot." });
  assert.deepEqual(t.messages, [
    { role: "system", content: "You control a robot." },
    { role: "user", content: "make it a red spider" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "morph", arguments: '{"preset":"spider"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "The robot is now a spider." },
  ]);
  assert.equal(t.steps, 1);
});

test("nativeTurn: a prompt over its budget loses the oldest complete turns, keeps the request and the newest turn", () => {
  const mine = (id: string) => ({ role: "assistant", provider: BRAIN_PROVIDER, content: [{ type: "toolCall", id, name: "read", arguments: { path: `f${id}` } }] });
  const result = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [text(`contents ${id} ${"x".repeat(300)}`)], isError: false });
  const messages = transcript({ role: "user", content: "read them all" }, mine("1"), result("1"), mine("2"), result("2"), mine("3"), result("3"), mine("4"), result("4"));
  const t = nativeTurn(messages, { provider: BRAIN_PROVIDER, mode: "none", maxChars: 1100 });
  assert.ok(t.dropped >= 1);
  assert.equal(t.messages[0]!.role, "user");
  assert.equal((t.messages.at(-1) as { tool_call_id?: string }).tool_call_id, "4");
  const roles = t.messages.map((m) => m.role);
  for (let i = 1; i < roles.length; i += 2) assert.deepEqual([roles[i], roles[i + 1]], ["assistant", "tool"], "pairs stay whole");
  assert.equal(t.steps, 4, "the steps counted are the task's, before anything was dropped");
});

test("parseTaggedCalls: an argument that shares its name with a tool is an argument of the call being read (update_robot's reset, morph, scale), not the next call", () => {
  const tools = [
    { type: "function" as const, function: { name: "update_robot", parameters: { type: "object", properties: { reset: {}, morph: {}, scale: {}, color: {} } } } },
    { type: "function" as const, function: { name: "reset", parameters: { type: "object", properties: {} } } },
    { type: "function" as const, function: { name: "morph", parameters: { type: "object", properties: { preset: {} } } } },
    { type: "function" as const, function: { name: "scale", parameters: { type: "object", properties: { factor: {} } } } },
  ];
  const names = tools.map((t) => t.function.name);
  const properties = toolProperties(tools);
  assert.deepEqual(parseTaggedCalls(' name="update_robot"> name="reset">false name="color">red', names, properties), [{ name: "update_robot", arguments: { reset: false, color: "red" } }], "reset:false stays an argument and does not call reset()");
  assert.deepEqual(parseTaggedCalls(' name="update_robot"> name="morph">spider name="scale">2', names, properties), [{ name: "update_robot", arguments: { morph: "spider", scale: 2 } }]);
  assert.deepEqual(parseTaggedCalls(' name="reset"> name="morph"> name="preset">dog name="scale"> name="factor">2', names, properties).map((c) => c.name), ["reset", "morph", "scale"], "a name that is not an argument of the current call still starts the next call");
  const viaContent = nativeContent({ text: ' name="update_robot"> name="reset">false', toolCalls: [] }, names, properties);
  assert.deepEqual(viaContent.content, [{ type: "toolCall", id: "call-0", name: "update_robot", arguments: { reset: false } }]);
});
