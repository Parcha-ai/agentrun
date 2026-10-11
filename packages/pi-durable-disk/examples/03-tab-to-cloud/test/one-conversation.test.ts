// ONE conversation: the conversation that did the trip on the cloud model is configured onto the tab-local model with the tools (`conversation.configure`), and the small model is shown
// a window of it, never the trip. Over a real pi-durable Harness with real tools on a real (Node) computer: a Luna-style transcript with a tool call, the configure, and what the 1B's
// llm receives (the prompt D1's format renders, decoded raw); the next turns are in the SAME conversation id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, watchEvents } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { agentRegistry, INSTRUCTIONS, rootAgent } from "../agent.ts";
import { Brain, BRAIN_SWAP, TOOL_PROMPT } from "../tab/brain.ts";
import { BRAIN_PROVIDER } from "../tab/brain-provider.ts";
import type { Msg } from "../tab/tool-format.ts";
import { ChatView } from "../tab/chat-view.ts";
import { windowMessages } from "../tab/tool-window.ts";
import { renderSpec, selectTools } from "../tab/tool-format.ts";
import { modelDisk, scripted } from "./_brain.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** The cloud model that did the trip ("Luna"): a bash call on the first generation of a task, then a closing line. It records what it was shown. */
function luna(seen: unknown[]) {
  let calls = 0;
  const stream = (model: any, context: any) => {
    seen.push(context);
    const s = createAssistantMessageEventStream();
    const content = calls++ === 0 ? [{ type: "text", text: "On it." }, { type: "toolCall", id: "luna-1", name: "bash", arguments: { command: "echo trip-data > trip.txt" } }] : [{ type: "text", text: "Done, I have the model. Want me to go offline?" }];
    const message: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: calls === 1 ? "toolUse" : "stop", timestamp: Date.now() };
    queueMicrotask(() => { s.push({ type: "start", partial: message }); s.push({ type: "done", reason: message.stopReason, message }); s.end(); });
    return s;
  };
  return createProvider({ id: "pipe", name: "luna", auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "x" } }) } }, models: [{ id: "cloud-big", name: "luna", api: "openai-responses", provider: "pipe", baseUrl: "x", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16000 }], api: { stream, streamSimple: stream } as never });
}

async function trip() {
  const dir = mkdtempSync(join(tmpdir(), "one-conv-"));
  const env = new NodeExecutionEnv({ cwd: dir, shellEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" } });
  const registry = agentRegistry(async () => undefined, { switchTool: false });
  const models = createModels();
  const lunaSeen: unknown[] = [];
  models.setProvider(luna(lunaSeen));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, ctx);
  const root = await harness.root(ctx, { agent: rootAgent("cloud-big") });
  await (await root.submit({ type: "input", content: "Train yourself a small model that can use your tools." }, ctx)).wait(ctx);
  const tools = registry.snapshot().tools().filter((t) => ["read", "write", "edit", "bash"].includes(t.tool.name)).map((t) => t.tool);
  return { dir, harness, root, models, registry, tools, lunaSeen, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const ask = async (c: { submit(s: any, ctx: any): Promise<{ wait(c: any): Promise<unknown> }> }, text: string) => void (await (await c.submit({ type: "input", content: text }, ctx)).wait(ctx));
const TRIP_MARKERS = ["Train yourself a small model", "echo trip-data", "trip-data", "Done, I have the model", "On it.", "You are a coding agent with your own small computer", "switch_environment", "go_offline"];

/** A prompt in the format's turn markers, as the turns it holds. */
const turnsOf = (prompt: string): { role: "user" | "model"; text: string }[] =>
  [...prompt.matchAll(/<start_of_turn>(user|model)\n([\s\S]*?)(?:<end_of_turn>\n|$)/g)].map((m) => ({ role: m[1] as "user" | "model", text: m[2]! }));

/** The model's turns as D1's format writes them: thinking, then one call or the answer. */
const CALL = (cmd: string) => `<thinking>Run it.</thinking>\n<tool_call>{"name":"bash","arguments":{"command":${JSON.stringify(cmd)}}}</tool_call>`;
const ANSWER_TURN = (t: string) => `<thinking>Done.</thinking>\n${t}`;

test("configure, not a fresh conversation: the trip's conversation becomes the 1B's, with the tools; the 1B is shown only the format's prompt for the task, and the next turns are in the SAME conversation id", async () => {
  const t = await trip();
  const disk = modelDisk();
  const idBefore = String(t.root.id);
  assert.equal(readFileSync(join(t.dir, "trip.txt"), "utf8").trim(), "trip-data", "Luna's tool call really ran");

  const m = scripted((q) => (q.includes('<tool_result name="bash"') ? ANSWER_TURN("Created hello.py.") : ANSWER_TURN("I will write it.")));
  const brain = new Brain({ harness: t.harness, models: t.models, root: t.root, readFile: async (p) => disk.files.get(p) ?? null, judge: async () => "show", llm: m.llm, threads: 2, context: ctx, mode: "configure", tools: t.tools });
  const conversation = await brain.start(disk.manifest);
  assert.ok(conversation);
  assert.equal(String(conversation!.id), idBefore, "ONE conversation: configured, not a new one");

  const agent = await t.root.agent(ctx);
  assert.deepEqual(agent.model, { provider: BRAIN_PROVIDER, modelId: JSON.parse(disk.manifest).sha256.slice(0, 12) }, "the conversation's model is the tab-local one");
  assert.deepEqual(agent.tools.map((x) => x.name), ["read", "write", "edit", "bash"], "its tools are exactly the four");
  assert.equal(agent.instructions, TOOL_PROMPT);

  await ask(t.root, "write hello.py");
  const first = m.prompts.filter((p) => p.includes("write hello.py")).at(0)!;
  assert.equal(first, `<start_of_turn>user\n${renderSpec(selectTools(t.tools as never))}\n\nwrite hello.py<end_of_turn>\n<start_of_turn>model\n<thinking>`, "exactly the bytes the format renders for [the task]: the spec, a blank line, the task; no instructions, nothing of the trip");
  for (const marker of TRIP_MARKERS) assert.ok(!first.includes(marker), `the trip never reaches the 1B: ${marker}`);

  // the same conversation, with the 1B's turns in it after Luna's
  const entries = (await t.root.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; model?: { role: string; provider?: string }[] }[];
  assert.ok(entries.some((e) => e.kind === "pi.assistant" && e.model?.[0]?.provider === BRAIN_PROVIDER), "the 1B's answer is in the same transcript");
  assert.ok(entries.some((e) => e.kind === "pi.assistant" && e.model?.[0]?.provider === "pipe"), "and Luna's turns are still there");

  // a second task: the previous exchange (the 1B's own, with that turn's thinking) rides along, Luna's still does not
  await ask(t.root, "add a main guard");
  const second = m.prompts.filter((p) => p.includes("add a main guard")).at(0)!;
  const turns = turnsOf(second);
  assert.deepEqual(turns.map((x) => x.role), ["user", "model", "user", "model"], "the previous exchange, then the new task, then the model's turn to speak");
  assert.ok(turns[0]!.text.startsWith("You are a coding agent with tools") && turns[0]!.text.endsWith("write hello.py"), "the spec opens the first user turn, with the previous task");
  assert.equal(turns[1]!.text, "<thinking>Done.</thinking>\nI will write it.", "its own previous turn, thinking included, as the format renders it");
  assert.equal(turns[2]!.text, "add a main guard");
  for (const marker of TRIP_MARKERS) assert.ok(!second.includes(marker), `still no trip: ${marker}`);
  assert.equal(String(brain.conversation!.id), idBefore, "still the same conversation id");

  const watch = new ChatView();
  const stream = await watchEvents(t.harness, t.root.id, ctx);
  watch.apply(stream.snapshot);
  await stream.stop();
  const swaps = watch.items().filter((i) => i.kind === "brain" && i.stage === "ready");
  assert.equal(swaps.length, 1);
  assert.match((swaps[0] as { text: string }).text, /same conversation/);
  await t.harness.close(ctx);
  t.done();
});

test("the 1B's own tool loop is in its window: its call (grammar-decoded, one byte form) and the result come back as turns, and nothing older does", async () => {
  const t = await trip();
  const disk = modelDisk();
  const turns: { ms: number; callId: string; calls: number }[] = [];
  const m = scripted((q) => (q.includes('<tool_result name="bash"') ? ANSWER_TURN("It printed hi.") : CALL("echo hi")));
  const brain = new Brain({ harness: t.harness, models: t.models, root: t.root, readFile: async (p) => disk.files.get(p) ?? null, judge: async () => "show", llm: m.llm, threads: 2, context: ctx, mode: "configure", tools: t.tools, decoding: { onTurn: (x) => turns.push({ ms: x.ms, callId: x.callId, calls: x.decoded.calls }) } });
  await brain.start(disk.manifest);
  await ask(t.root, "print hi");
  assert.equal(turns.length, 2, "two decoded turns: the call, then the answer after the result");
  assert.equal(turns[0]!.calls, 3, "a call turn is three raw completions: the capped thinking, the text before the call, the grammar-decoded body");
  const loop = turnsOf(m.prompts.at(-1)!);
  assert.deepEqual(loop.map((x) => x.role), ["user", "model", "user", "model"], "task, the 1B's call, the tool's result, its turn to speak");
  assert.equal(loop[1]!.text, '<thinking>Run it.</thinking>\n<tool_call>{"name":"bash","arguments":{"command":"echo hi"}}</tool_call>', "its own call, in the format's one byte form");
  assert.match(loop[2]!.text, /^<tool_result name="bash">hi\n?<\/tool_result>$/, "the result of the real bash");
  assert.ok(!m.prompts.at(-1)!.includes("trip-data") && !m.prompts.at(-1)!.includes("Done, I have the model"), "never the trip's call or result");
  assert.ok(m.prompts.some((p) => p.endsWith("<tool_call>")), "the call body was asked for after <tool_call> opened (where the grammar applies)");
  const entries = (await t.root.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; model?: { role: string; provider?: string; content?: { type: string }[]; stopReason?: string }[] }[];
  const own = entries.filter((e) => e.kind === "pi.assistant" && e.model?.[0]?.provider === BRAIN_PROVIDER).map((e) => e.model![0]!);
  assert.ok(own.some((a) => a.content?.some((c) => c.type === "toolCall") && a.stopReason === "toolUse"), "the 1B's call is a real pi tool call");
  assert.ok(own.some((a) => a.content?.some((c) => c.type === "thinking")), "and its thinking stays in the conversation (the format shows it back)");
  await t.harness.close(ctx);
  t.done();
});

test("a call to an unknown tool still reaches pi as a call, so pi's own error comes back to the model", async () => {
  const t = await trip();
  const disk = modelDisk();
  const m = scripted(() => '<thinking>Hm.</thinking>\n<tool_call>{"name":"nope","arguments":{}}</tool_call>');
  const brain = new Brain({ harness: t.harness, models: t.models, root: t.root, readFile: async (p) => disk.files.get(p) ?? null, judge: async () => "show", llm: m.llm, threads: 2, context: ctx, mode: "configure", tools: t.tools });
  await brain.start(disk.manifest);
  // an unknown tool still goes to pi as a call (pi's own error comes back to the model)
  const sub = await t.root.submit({ type: "input", content: "do it" }, ctx);
  await Promise.race([sub.wait(ctx), new Promise((r) => setTimeout(r, 1500))]);
  const calls = (await t.root.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; model?: { provider?: string; content?: { type: string; name?: string }[] }[] }[];
  assert.ok(calls.some((e) => e.kind === "pi.assistant" && e.model?.[0]?.provider === BRAIN_PROVIDER && e.model?.[0]?.content?.some((c) => c.type === "toolCall" && c.name === "nope")), "an unknown tool is a call pi refuses by name");
  await t.harness.close(ctx).catch(() => undefined);
  t.done();
});

test("windowMessages: only this model's own turns are shown back, a held or failed previous exchange is skipped, nothing of another model, and none = the task alone", () => {
  const user = (c: string) => ({ role: "user", content: c });
  const asst = (provider: string, parts: unknown[], extra: Record<string, unknown> = {}) => ({ role: "assistant", provider, content: parts, ...extra });
  const text = (x: string) => ({ type: "text", text: x });
  const o = { provider: BRAIN_PROVIDER, mode: "last" as const };
  const sys = { role: "system", content: "", sections: { instructions: "<instructions>\nP\n</instructions>" } };
  const msgs = [sys, user("trip task"), asst("pipe", [text("trip says"), { type: "toolCall", id: "1", name: "bash", arguments: { command: "x" } }]), { role: "toolResult", toolCallId: "1", toolName: "bash", content: [text("trip out")], isError: false }, asst("pipe", [text("trip done")]), user("task one"), asst(BRAIN_PROVIDER, [{ type: "thinking", thinking: "t1" }, text("answer one")]), user("task two")];
  const w = windowMessages(msgs as never, o) as unknown as { role: string; content: unknown }[];
  assert.deepEqual(w.map((x) => x.role), ["user", "assistant", "user"]);
  assert.equal(w[0]!.content, "task one");
  assert.deepEqual(w[1]!.content, [{ type: "thinking", thinking: "t1" }, text("answer one")], "the previous turn with its thinking and its text");
  assert.equal(w[2]!.content, "task two");
  assert.deepEqual((windowMessages(msgs as never, { ...o, mode: "none" }) as unknown as { content: unknown }[]).map((x) => x.content), ["task two"]);
  // the exchange right before was the trip's: nothing is reached for beyond it
  assert.deepEqual((windowMessages([sys, user("trip task"), asst("pipe", [text("trip done")]), user("first for the 1B")] as never, o) as unknown as { content: unknown }[]).map((x) => x.content), ["first for the 1B"]);
  // a held previous exchange is skipped
  assert.deepEqual((windowMessages([sys, user("q1"), asst(BRAIN_PROVIDER, [text("I can't answer that.")], { rawStopReason: "held_by_judge" }), user("q2")] as never, o) as unknown as { content: unknown }[]).map((x) => x.content), ["q2"]);
  // the task was begun by the trip's model (Luna asks to go offline, her tool runs, the 1B takes over inside the same task): her call and its result are not shown
  const handover = [sys, user("Yes, go offline"), asst("pipe", [text("Going offline."), { type: "toolCall", id: "g1", name: "go_offline", arguments: {} }]), { role: "toolResult", toolCallId: "g1", toolName: "go_offline", content: [text("checked out")], isError: false }];
  assert.deepEqual((windowMessages(handover as never, o) as unknown as { content: unknown }[]).map((x) => x.content), ["Yes, go offline"], "only the task: Luna's call and its result stay behind");
  // the 1B's own loop: its call and its call's result, in order
  const loop = [sys, user("go"), asst(BRAIN_PROVIDER, [{ type: "thinking", thinking: "t" }, { type: "toolCall", id: "a", name: "bash", arguments: { command: "1" } }]), { role: "toolResult", toolCallId: "a", toolName: "bash", content: [text("o1")], isError: false }];
  assert.deepEqual((windowMessages(loop as never, o) as Msg[]).map((x) => x.role), ["user", "assistant", "toolResult"]);
});
