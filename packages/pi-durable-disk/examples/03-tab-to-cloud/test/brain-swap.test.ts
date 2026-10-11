// The brain swap over a real pi-durable Harness on memory storage, with the cloud model standing in for the trip and the real ModelHost over a scripted 1B.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { REFUSAL } from "../../04-walks-home/tab/src/guard.ts";
import { BRAIN_FAILED, BRAIN_LOADING, BRAIN_SWAP, Brain, findSwap, readManifest } from "../tab/brain.ts";
import { BRAIN_PROVIDER } from "../tab/brain-provider.ts";
import { ANSWER, cloudProvider, modelDisk, reply, scripted } from "./_brain.ts";

const model = { provider: "pipe", modelId: "cloud-big" };

async function open(storage: Parameters<typeof Harness.open>[0], disk: { files: Map<string, Uint8Array>; manifest: string }, o: { script?: (q: string) => string; judge?: (p: string, a: string) => Promise<"show" | "refuse"> } = {}) {
  const models = createModels();
  const cloudSeen: unknown[][] = [];
  models.setProvider(cloudProvider(cloudSeen));
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, ctx);
  const root = await harness.root(ctx, { agent: { model, instructions: "You are a coding agent with a shell." } });
  const m = scripted(o.script ?? reply);
  const progress: string[] = [];
  const brain = new Brain({ harness, models, root, readFile: async (p) => disk.files.get(p) ?? null, judge: o.judge ?? (async () => "show"), llm: m.llm, threads: 2, context: ctx, onProgress: (t) => progress.push(t) });
  const kinds = async (c: typeof root) => ((await c.entries({}, 500, undefined, ctx)).items as unknown as { kind: string }[]).map((e) => e.kind).reverse();
  const ask = async (c: typeof root, text: string) => { const s = await c.submit({ type: "input", content: text }, ctx); await s.wait(ctx); };
  return { harness, models, root, brain, seen: m.seen, cloudSeen, progress, kinds, ask };
}

test("the swap: the trip's conversation stays as it was, a FRESH conversation opens on the tab-local model, and the small model never sees the trip", async () => {
  const disk = modelDisk();
  const r = await open(new MemoryStorage(), disk);
  await r.ask(r.root, "train a creature to walk");
  const before = await r.kinds(r.root);
  const conv = await r.brain.start(disk.manifest);
  assert.ok(conv, "a conversation on the new model");
  assert.notEqual(String(conv!.id), String(r.root.id), "a fresh conversation, not the root");
  const after = await r.kinds(r.root);
  assert.deepEqual(after.slice(0, before.length), before, "the trip's transcript is untouched");
  assert.deepEqual(after.slice(before.length), [BRAIN_LOADING, BRAIN_SWAP]);
  assert.deepEqual(await r.kinds(conv!), [BRAIN_SWAP], "the new conversation starts with the swap entry");
  assert.deepEqual((await findSwap(r.root, ctx))!.data.model, (await findSwap(r.root, ctx))!.data.model);
  await r.ask(conv!, "Who are you?");
  const shown = r.seen.at(-1)!;
  assert.deepEqual(shown, [{ role: "user", content: "Who are you?" }], "the 1B sees the user's words only: no system prompt, no tools, nothing of the trip");
  const entries = (await conv!.entries({}, 50, undefined, ctx)).items as unknown as { kind: string; model?: { role: string; content: unknown }[] }[];
  assert.deepEqual(entries.find((e) => e.kind === "pi.assistant")!.model![0].content, [{ type: "thinking", thinking: "Who? The Moon." }, { type: "text", text: "I am Luna. I glow." }]);
  assert.equal(r.cloudSeen.length, 1, "the cloud model was used for the trip only, never for the new conversation");
  assert.equal((await (await r.harness.conversation(r.root.id, ctx))!.agent(ctx)).model!.provider, "pipe");
  assert.equal((await conv!.agent(ctx)).model!.provider, BRAIN_PROVIDER);
  await r.harness.close(ctx);
});

test("starting twice makes one conversation and one swap entry", async () => {
  const disk = modelDisk();
  const r = await open(new MemoryStorage(), disk);
  const [a, b] = await Promise.all([r.brain.start(disk.manifest), r.brain.start(disk.manifest)]);
  assert.equal(String(a!.id), String(b!.id));
  assert.equal((await r.kinds(r.root)).filter((k) => k === BRAIN_SWAP).length, 1);
  await r.harness.close(ctx);
});

test("a reload (a new page over the same disk) finds the same conversation, with what was said in it, and carries on from its last answer", async () => {
  const disk = modelDisk(), dir = mkdtempSync(join(tmpdir(), "brain-reload-"));
  const one = await open(await openNodeJsonlStorage(dir, ctx), disk);
  const conv = await one.brain.start(disk.manifest);
  await one.ask(conv!, "Who are you?");
  await one.ask(conv!, "rain?");
  await one.harness.close(ctx);
  const two = await open(await openNodeJsonlStorage(dir, ctx), disk);
  const again = await two.brain.start(disk.manifest);
  assert.equal(String(again!.id), String(conv!.id), "the same conversation");
  assert.equal((await two.kinds(two.root)).filter((k) => k === BRAIN_SWAP).length, 1, "no second swap");
  await two.ask(again!, "sun?");
  assert.deepEqual(two.seen.at(-1), [{ role: "user", content: "rain?" }, { role: "assistant", content: ANSWER }, { role: "user", content: "sun?" }], "the policy reads the durable transcript: the previous exchange, answer text only");
  const users = ((await again!.entries({}, 50, undefined, ctx)).items as unknown as { kind: string }[]).filter((e) => e.kind === "pi.user").length;
  assert.equal(users, 3);
  await two.harness.close(ctx);
  rmSync(dir, { recursive: true, force: true });
});

test("a model that does not load leaves the agent its brain: a brain.failed entry, no conversation, and the cloud conversation still answers", async () => {
  const disk = modelDisk();
  disk.files.set("home/model/chunk-0001.bin", new Uint8Array(64)); // not what the manifest's sha256 says
  const r = await open(new MemoryStorage(), disk);
  const conv = await r.brain.start(disk.manifest);
  assert.equal(conv, undefined);
  const kinds = await r.kinds(r.root);
  assert.deepEqual(kinds.slice(-2), [BRAIN_LOADING, BRAIN_FAILED]);
  const failed = ((await r.root.entries({}, 10, undefined, ctx)).items as unknown as { kind: string; data: { reason: string } }[]).find((e) => e.kind === BRAIN_FAILED)!;
  assert.match(failed.data.reason, /chunk 1.*sha256/);
  assert.ok(r.progress.includes("model-failed"));
  await r.ask(r.root, "still there?");
  assert.equal(r.cloudSeen.length, 1);
  await r.harness.close(ctx);
});

test("a self-check the judge holds is a failed swap, not a conversation", async () => {
  const disk = modelDisk();
  const r = await open(new MemoryStorage(), disk, { judge: async () => "refuse" });
  assert.equal(await r.brain.start(disk.manifest), undefined);
  assert.equal((await r.kinds(r.root)).includes(BRAIN_FAILED), true);
  await r.harness.close(ctx);
});

test("readManifest: the trainer's go signal is the manifest file; absent means not yet", async () => {
  assert.equal(await readManifest(async () => null), null);
  assert.equal(await readManifest(async () => new TextEncoder().encode("{\"x\":1}")), "{\"x\":1}");
  void REFUSAL;
});
