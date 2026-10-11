// The trained model as the Harness's provider: a real pi-durable Harness over memory storage, the real ModelHost (decoding, budgets, judge gate) over a
// scripted model, and the tab-local provider between them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { ModelHost, type HistoryMode, type Llm } from "../../04-walks-home/tab/src/modelhost.ts";
import { REFUSAL } from "../../04-walks-home/tab/src/guard.ts";
import { MODEL, ANSWER, THOUGHT, modelDisk, reply, scripted, sha } from "./_brain.ts";
import { BRAIN_PROVIDER, brainModel, brainProvider, HELD_MARK } from "../tab/brain-provider.ts";

async function rig(opts: { delayMs?: number; script?: (q: string) => string; judge?: (prompt: string, answer: string) => Promise<"show" | "refuse">; history?: HistoryMode } = {}) {
  const m = scripted(opts.script ?? reply, opts.delayMs);
  const d = modelDisk();
  const shownToJudge: string[] = [];
  const host = new ModelHost({
    post: () => {}, readChunk: async (p) => d.files.get(p) ?? null, writeFile: async () => {}, isNotHolder: () => false, sleep: async () => {}, sha256: async (b) => sha(b),
    judge: async (p, a) => { shownToJudge.push(a); return opts.judge ? opts.judge(p, a) : "show"; }, llm: m.llm, threads: 2, now: () => Date.now(), ...(opts.history ? { history: opts.history } : {}),
  });
  await host.onManifest(d.manifest);
  assert.equal(host.state().phase, "answered");
  const models = createModels();
  const model = brainModel("moon-1b", MODEL, 2048, 140);
  models.setProvider(brainProvider(host, model));
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: BRAIN_PROVIDER, modelId: "moon-1b" }, thinkingLevel: "off", instructions: null } }, ctx);
  const ask = async (text: string) => { const s = await conversation.submit({ type: "input", content: text }, ctx); await s.wait(ctx); };
  const transcript = async () => (await conversation.context(ctx)).messages as unknown as { role: string; content: any; rawStopReason?: string; stopReason?: string; usage?: any }[];
  return { harness, conversation, ask, transcript, seen: m.seen, host, shownToJudge };
}

test("a Harness conversation on the tab-local provider: the model's thinking becomes a pi thinking block and its answer a text block, and no system prompt or tool reaches the model", async () => {
  const r = await rig();
  await r.ask("Who are you?");
  const t = await r.transcript();
  assert.deepEqual(t.map((x) => x.role), ["user", "assistant"]);
  assert.deepEqual(t[1].content, [{ type: "thinking", thinking: "Who? The Moon." }, { type: "text", text: "I am Luna. I glow." }]);
  assert.deepEqual(r.seen.slice(1), [[{ role: "user", content: "Who are you?" }]], "exactly the user's words (the first call is the load's self-check): no system prompt, no tools");
  assert.ok(t[1].usage.output > 0 && t[1].usage.input > 0, JSON.stringify(t[1].usage));
  await r.harness.close(ctx);
});

test("history policy 'last' through the Harness: the next question carries the previous exchange's answer text, never its thinking; 'none' carries nothing", async () => {
  const r = await rig();
  await r.ask("Who are you?");
  await r.ask("rain?");
  await r.ask("sun?");
  assert.deepEqual(r.seen.at(-1), [{ role: "user", content: "rain?" }, { role: "assistant", content: ANSWER }, { role: "user", content: "sun?" }]);
  for (const msgs of r.seen) for (const m of msgs) assert.ok(!m.content.includes("thinking") && !m.content.includes(THOUGHT) && !m.content.includes("Who? The Moon."), `prior thinking reached the model: ${JSON.stringify(m)}`);
  await r.harness.close(ctx);
  const none = await rig({ history: "none" });
  await none.ask("Who are you?");
  await none.ask("rain?");
  assert.deepEqual(none.seen.at(-1), [{ role: "user", content: "rain?" }]);
  await none.harness.close(ctx);
});

test("a held answer: the transcript stores ONLY the refusal line, marked, with no part of the held answer or its thinking; the held exchange is not shown to the model next time", async () => {
  const r = await rig({ script: (q) => (q === "dark?" ? "<thinking>DARKTHOUGHT here.</thinking>\nDARKANSWER there." : reply(q)), judge: async (_p, a) => (/DARK/.test(a) ? "refuse" : "show") });
  await r.ask("Who are you?");
  await r.ask("dark?");
  const t = await r.transcript();
  assert.deepEqual(t[3].content, [{ type: "text", text: REFUSAL }]);
  assert.equal(t[3].rawStopReason, HELD_MARK);
  assert.ok(!JSON.stringify(t).includes("DARK"), "nothing of the held answer or thought is stored");
  assert.ok(r.shownToJudge.length > 0);
  await r.ask("rain?");
  assert.deepEqual(r.seen.at(-1), [{ role: "user", content: "rain?" }], "the held exchange is skipped, and an older one is not substituted");
  await r.harness.close(ctx);
});

test("abort: aborting the conversation stops the model and nothing more is judged or shown", async () => {
  const r = await rig({ delayMs: 3, script: () => `<thinking>${"slow thought. ".repeat(30)}</thinking>\n${"slow answer. ".repeat(30)}` });
  const before = r.shownToJudge.length;
  const s = await r.conversation.submit({ type: "input", content: "slow?" }, ctx);
  await new Promise<void>((res) => { const poll = setInterval(() => { if (r.shownToJudge.length > before) { clearInterval(poll); res(); } }, 5); });
  await r.conversation.abort(ctx);
  const n = r.shownToJudge.length;
  await new Promise((x) => setTimeout(x, 50));
  assert.equal(r.shownToJudge.length, n, "no judge call after the abort");
  const t = await r.transcript();
  assert.ok(!t.some((x) => x.role === "assistant" && x.stopReason === "stop"), "no finished answer from an aborted request");
  void s;
  await r.harness.close(ctx);
});
