// ONE conversation: the conversation that did the trip on the cloud model is configured onto the tab-local model with the tools (`conversation.configure`), and the small model is shown
// a window of it, never the trip. Over a real pi-durable Harness with real tools on a real (Node) computer: a Luna-style transcript with a tool call, the configure, and what the 1B's
// llm receives; the next turns are in the SAME conversation id. The tool-call format is the placeholder (tool-format.ts); D1's module replaces it.
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
import { ChatView } from "../tab/chat-view.ts";
import { PLACEHOLDER_FORMAT } from "../tab/tool-format.ts";
import { windowMessages } from "../tab/tool-window.ts";
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
const flat = (msgs: { role: string; content: string }[]) => msgs.map((m) => `${m.role}: ${m.content}`).join("\n---\n");
const TRIP_MARKERS = ["Train yourself a small model", "echo trip-data", "trip-data", "Done, I have the model", "On it.", "You are a coding agent with your own small computer", "switch_environment"];

test("configure, not a fresh conversation: the trip's conversation becomes the 1B's, with the tools; the 1B is shown only the tool prompt and the task, and the next turns are in the SAME conversation id", async () => {
  const t = await trip();
  const disk = modelDisk();
  const idBefore = String(t.root.id);
  const luna1 = await t.root.entries({}, 100, undefined, ctx);
  assert.ok((luna1.items as unknown as { kind: string }[]).some((e) => e.kind === "pi.tool-result" || /tool/.test(e.kind)), "the trip has a tool call and its result in the transcript");
  assert.equal(readFileSync(join(t.dir, "trip.txt"), "utf8").trim(), "trip-data", "Luna's tool call really ran");

  const m = scripted((q) => (q.includes("<tool_result name=") ? "<thinking>It ran.</thinking>\nCreated hello.py." : "<thinking>Write the file.</thinking>\nI will write it."));
  const brain = new Brain({ harness: t.harness, models: t.models, root: t.root, readFile: async (p) => disk.files.get(p) ?? null, judge: async () => "show", llm: m.llm, threads: 2, context: ctx, mode: "configure", tools: t.tools });
  const conversation = await brain.start(disk.manifest);
  assert.ok(conversation);
  assert.equal(String(conversation!.id), idBefore, "ONE conversation: configured, not a new one");

  const agent = await t.root.agent(ctx);
  assert.deepEqual(agent.model, { provider: BRAIN_PROVIDER, modelId: disk.manifest ? JSON.parse(disk.manifest).sha256.slice(0, 12) : "" }, "the conversation's model is the tab-local one");
  assert.deepEqual(agent.tools.map((x) => x.name), ["read", "write", "edit", "bash"], "its tools are exactly the four");
  assert.equal(agent.instructions, TOOL_PROMPT, "its instructions are the short tool prompt");

  await ask(t.root, "write hello.py");
  const first = m.seen.filter((s) => s.some((x) => x.content.includes("write hello.py"))).at(0)!;
  assert.equal(first[0]!.role, "user");
  assert.ok(first[0]!.content.includes(TOOL_PROMPT), "the window opens with the tool prompt");
  for (const tool of ["read", "write", "edit", "bash"]) assert.ok(first[0]!.content.includes(`- ${tool}`), `and the tool ${tool}`);
  assert.ok(first.at(-1)!.content.endsWith("write hello.py") || first.at(-1)!.content.includes("write hello.py"), "and the task");
  for (const marker of TRIP_MARKERS) assert.ok(!flat(first).includes(marker), `the trip never reaches the 1B: ${marker}`);
  assert.deepEqual(first.map((x) => x.role), ["user"], "the first window is the tool prompt and the task and nothing else");

  // the same conversation, with the 1B's turns in it
  const entries = (await t.root.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; model?: { role: string; provider?: string }[] }[];
  const brainTurns = entries.filter((e) => e.kind === "pi.assistant" && e.model?.[0]?.provider === BRAIN_PROVIDER);
  assert.ok(brainTurns.length >= 1, "the 1B's answer is in the same transcript, after Luna's");
  assert.ok(entries.some((e) => e.kind === "pi.assistant" && e.model?.[0]?.provider === "pipe"), "and Luna's turns are still there");

  // a second task: the previous exchange (this model's) rides along, Luna's still does not
  await ask(t.root, "add a main guard");
  const second = m.seen.filter((s) => s.at(-1)!.content.includes("add a main guard")).at(-1)!;
  assert.deepEqual(second.map((x) => x.role), ["user", "assistant", "user"], "tool prompt + last exchange, then the new task");
  assert.ok(second[1]!.content.includes("Created hello.py") || second[1]!.content.includes("I will write it"), "the previous answer is the 1B's own");
  assert.ok(second[0]!.content.includes("write hello.py"), "with the previous task's message");
  for (const marker of TRIP_MARKERS) assert.ok(!flat(second).includes(marker), `still no trip: ${marker}`);
  assert.equal(String(brain.conversation!.id), idBefore, "still the same conversation id");

  // the chat says so once, in the same conversation
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

test("the 1B's own tool loop is in its window: its call and the result come back as turns, the task stays first, and nothing older does", async () => {
  const t = await trip();
  const disk = modelDisk();
  const m = scripted((q) => (q.includes("<tool_result name=") ? "<thinking>Done.</thinking>\nIt printed hi." : `<thinking>Run it.</thinking>\nRunning.\n<tool_call>{"name": "bash", "arguments": {"command": "echo hi"}}</tool_call>`));
  const brain = new Brain({ harness: t.harness, models: t.models, root: t.root, readFile: async (p) => disk.files.get(p) ?? null, judge: async () => "show", llm: m.llm, threads: 2, context: ctx, mode: "configure", tools: t.tools });
  await brain.start(disk.manifest);
  await ask(t.root, "print hi");
  assert.equal(m.seen.length >= 3, true, "self-check, the call, then the answer after the result");
  const loop = m.seen.at(-1)!;
  assert.deepEqual(loop.map((x) => x.role), ["user", "assistant", "user"], "task, the 1B's call, the tool's result");
  assert.match(loop[1]!.content, /<tool_call>\{"name":"bash","arguments":\{"command":"echo hi"\}\}<\/tool_call>/, "its own call, as it wrote it");
  assert.match(loop[2]!.content, /<tool_result name="bash">.*hi.*<\/tool_result>/s, "the result of the real bash");
  assert.ok(!flat(loop).includes("trip-data") && !flat(loop).includes("Done, I have the model"), "never the trip's call or result");
  // the transcript holds a real tool call by the 1B and the final answer
  const entries = (await t.root.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; model?: { role: string; provider?: string; content?: { type: string }[]; stopReason?: string }[] }[];
  const own = entries.filter((e) => e.kind === "pi.assistant" && e.model?.[0]?.provider === BRAIN_PROVIDER).map((e) => e.model![0]!);
  assert.ok(own.some((a) => a.content?.some((c) => c.type === "toolCall") && a.stopReason === "toolUse"), "the 1B's call is a real pi tool call");
  await t.harness.close(ctx);
  t.done();
});

test("windowMessages: only this model's own turns are shown back, a held or failed previous exchange is skipped, roles alternate, and none = the task alone", () => {
  const user = (c: string) => ({ role: "user", content: c });
  const asst = (provider: string, parts: unknown[], extra: Record<string, unknown> = {}) => ({ role: "assistant", provider, content: parts, ...extra });
  const text = (t: string) => ({ type: "text", text: t });
  const fmt = PLACEHOLDER_FORMAT;
  const o = { provider: BRAIN_PROVIDER, format: fmt, mode: "last" as const };
  const sys = { role: "system", content: "", sections: { instructions: "<instructions>\nP\n</instructions>" } };
  // the trip, then a task by the 1B, then the current one
  const msgs = [sys, user("trip task"), asst("pipe", [text("trip says"), { type: "toolCall", id: "1", name: "bash", arguments: { command: "x" } }]), { role: "toolResult", toolName: "bash", content: [text("trip out")], isError: false }, asst("pipe", [text("trip done")]), user("task one"), asst(BRAIN_PROVIDER, [{ type: "thinking", thinking: "SECRET" }, text("answer one")]), user("task two")];
  assert.deepEqual(windowMessages(msgs as never, o), [{ role: "user", content: "task one" }, { role: "assistant", content: "answer one" }, { role: "user", content: "task two" }]);
  assert.deepEqual(windowMessages(msgs as never, { ...o, mode: "none" }), [{ role: "user", content: "task two" }]);
  // the exchange right before was the trip's: nothing is reached for beyond it
  const afterTrip = [sys, user("trip task"), asst("pipe", [text("trip done")]), user("first for the 1B")];
  assert.deepEqual(windowMessages(afterTrip as never, o), [{ role: "user", content: "first for the 1B" }]);
  // a held previous exchange is skipped
  const held = [sys, user("q1"), asst(BRAIN_PROVIDER, [text("I can't answer that.")], { rawStopReason: "held_by_judge" }), user("q2")];
  assert.deepEqual(windowMessages(held as never, o), [{ role: "user", content: "q2" }]);
  // the task was begun by the trip's model (Luna asks to go offline, her tool runs, the conversation is configured, the 1B takes over inside the same task): her call and its result are not shown
  const handover = [sys, user("Yes, go offline"), asst("pipe", [text("Going offline."), { type: "toolCall", id: "g1", name: "go_offline", arguments: {} }]), { role: "toolResult", toolCallId: "g1", toolName: "go_offline", content: [text("checked out")], isError: false }];
  assert.deepEqual(windowMessages(handover as never, o), [{ role: "user", content: "Yes, go offline" }], "only the task: Luna's call and its result stay behind");
  // two results in a row stay one user turn
  const two = [sys, user("go"), asst(BRAIN_PROVIDER, [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "1" } }, { type: "toolCall", id: "b", name: "bash", arguments: { command: "2" } }]), { role: "toolResult", toolCallId: "a", toolName: "bash", content: [text("o1")], isError: false }, { role: "toolResult", toolCallId: "b", toolName: "bash", content: [text("o2")], isError: true }];
  const w = windowMessages(two as never, o);
  assert.deepEqual(w.map((x) => x.role), ["user", "assistant", "user"]);
  assert.ok(w[2]!.content.includes('name="bash">o1') && w[2]!.content.includes('error="true">o2'));
  assert.ok(!JSON.stringify(w).includes("SECRET"));
});

test("the format seam: a reply with a call that does not parse stays text, so the loop goes on and the model sees its own words", () => {
  const p = PLACEHOLDER_FORMAT.parse('hm <tool_call>{"name": "bash", "arguments": </tool_call>');
  assert.equal(p.calls.length, 0);
  assert.match(p.error ?? "", /did not parse/);
  assert.equal(PLACEHOLDER_FORMAT.visible('Running.\n<tool_call>{"na'), "Running.");
  void BRAIN_SWAP;
});
