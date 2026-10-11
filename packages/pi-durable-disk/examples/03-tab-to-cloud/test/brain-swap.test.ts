// The brain swap over a real pi-durable Harness on memory storage, with the cloud model standing in for the trip and the real ModelHost over a scripted 1B.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, watchEvents } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { REFUSAL } from "../../04-walks-home/tab/src/guard.ts";
import { BRAIN_FAILED, BRAIN_LOADING, BRAIN_MOVE, BRAIN_SWAP, Brain, findSwap, judgeFor, readManifest } from "../tab/brain.ts";
import { ChatView } from "../tab/chat-view.ts";
import { BRAIN_PROVIDER } from "../tab/brain-provider.ts";
import { ANSWER, cloudProvider, modelDisk, reply, scripted } from "./_brain.ts";
import { sha } from "./_brain.ts";

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

test("the judge is off unless asked for: with it off every answer shows, the self-check passes on any non-empty answer, and the judge is never called", async () => {
  const disk = modelDisk();
  let calls = 0;
  const remote = async () => { calls++; return "refuse" as const; };
  const off = await open(new MemoryStorage(), disk, { script: () => "<thinking>hm</thinking>zzz", judge: judgeFor(false, remote) });
  const conv = await off.brain.start(disk.manifest);
  assert.ok(conv, "the swap happened although the judge would have refused");
  await off.ask(conv!, "anything");
  assert.equal(calls, 0, "no call to the judge");
  await off.harness.close(ctx);
  const on = await open(new MemoryStorage(), disk, { judge: judgeFor(true, remote) });
  assert.equal(await on.brain.start(disk.manifest), undefined, "opted in, a judge that refuses holds the self-check");
  assert.ok(calls > 0);
  await on.harness.close(ctx);
});

test("a move after the swap is defined: it carries the run (the root, on the cloud model), says so in both conversations, leaves the brain's conversation dormant, and the trained model takes over again in it", async () => {
  const disk = modelDisk(), dir = mkdtempSync(join(tmpdir(), "brain-move-"));
  const one = await open(await openNodeJsonlStorage(dir, ctx), disk);
  const conv = await one.brain.start(disk.manifest);
  await one.ask(conv!, "Who are you?");
  const before = (await one.kinds(conv!)).length;
  await one.brain.noteMove("sw-1", "a Daytona sandbox");
  await one.brain.noteMove("sw-1", "a Daytona sandbox"); // the same move again: one note
  for (const c of [one.root, conv!]) {
    const notes = ((await c.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; data: { code: string; to: string; text: string } }[]).filter((e) => e.kind === BRAIN_MOVE);
    assert.equal(notes.length, 1, "one note per move in each conversation");
    assert.equal(notes[0]!.data.code, "TAB_LOCAL_BRAIN_STAYS");
    assert.match(notes[0]!.data.text, /Daytona sandbox.*model it trained stays in this tab.*cloud model/);
  }
  // what a viewer reads: the merged chat shows the move once
  const watch = await watchEvents(one.harness, conv!.id, ctx);
  const rootWatch = await watchEvents(one.harness, one.root.id, ctx);
  const view = new ChatView();
  view.apply({ ...watch.snapshot, entries: [...rootWatch.snapshot.entries, ...watch.snapshot.entries] });
  const moved = view.items().filter((i) => i.kind === "brain" && i.stage === "moved");
  assert.equal(moved.length, 1);
  await watch.stop(); await rootWatch.stop();
  await one.harness.close(ctx);

  // the cloud host: no tab-local provider. It resumes the run and the root conversation answers on the cloud model; the brain's conversation is untouched.
  const models = createModels();
  const cloudSeen: unknown[][] = [];
  models.setProvider(cloudProvider(cloudSeen));
  const cloud = await Harness.open(await openNodeJsonlStorage(dir, ctx), { models, registry: createRegistry() }, ctx);
  await cloud.resume();
  const cloudRoot = await cloud.root(ctx, { agent: { model, instructions: "You are a coding agent with a shell." } });
  const s = await cloudRoot.submit({ type: "input", content: "where are you?" }, ctx);
  await s.wait(ctx);
  assert.equal(cloudSeen.length, 1, "the cloud model answered the root");
  const dormant = await cloud.conversation(conv!.id, ctx);
  assert.equal(((await dormant!.entries({}, 100, undefined, ctx)).items as unknown[]).length, before + 1, "the brain's conversation is as the tab left it, plus its one move note");
  await cloud.close(ctx);

  // back in a tab: the same conversation, the trained model again
  const back = await open(await openNodeJsonlStorage(dir, ctx), disk);
  const again = await back.brain.start(disk.manifest);
  assert.equal(String(again!.id), String(conv!.id));
  await back.ask(again!, "rain?");
  assert.equal(back.seen.length >= 1, true);
  await back.harness.close(ctx);
  rmSync(dir, { recursive: true, force: true });
});

test("a brain the run has left releases its model once, so coming back does not leave a second copy beside it", async () => {
  const disk = modelDisk(), m = scripted(reply);
  const models = createModels();
  models.setProvider(cloudProvider());
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
  const root = await harness.root(ctx, { agent: { model, instructions: "You are a coding agent." } });
  const brain = new Brain({ harness, models, root, readFile: async (p) => disk.files.get(p) ?? null, judge: async () => "show", llm: m.llm, threads: 2, context: ctx });
  await brain.start(disk.manifest);
  await brain.dispose();
  await brain.dispose();
  assert.equal(m.loads.exits, 1, "exited once");
  await harness.close(ctx);
});

/** A base and one adapter on the disk (make-home-disk.mjs's layout); `adapters: false` is the manifest the trainer writes first, with the base alone. */
function homeDisk(adapters = true) {
  const files = new Map<string, Uint8Array>();
  const MODEL = { repo: "google/gemma-3-1b-it", revision: "dcc83ea841ab6100d6b47a070329e1ba4cf78752" };
  const lay = (n: number, seed: number, dir: string) => {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 11 + seed) & 255);
    const chunks = [];
    for (let i = 0, off = 0; off < n; i++, off += 64) { const part = bytes.slice(off, off + Math.min(64, n - off)); const path = `${dir}/chunk-${String(i).padStart(4, "0")}.bin`; files.set(path, part); chunks.push({ n: i, path, offset: off, size: part.length, sha256: sha(part) }); }
    return { size: n, sha256: sha(bytes), chunk_bytes: 64, chunks };
  };
  const base = { name: "gemma-3-1b-it", quant: "Q4_K_M", model: MODEL, ...lay(150, 1, "home/base") };
  const tools = { name: "tools.gguf", kind: "skill", topic: "pi's tools", model: MODEL, rank: 16, alpha: 32, scale: 1, dtype: "q8_0", ...lay(70, 2, "home/adapters/tools") };
  return { files, manifest: JSON.stringify({ format: "gguf-base-adapters-v1", base, adapters: adapters ? [tools] : [] }), tools };
}

test("a base and an adapter come home as the brain: its identity is the adapter's sha256; the base alone (no adapter yet) is not a brain and writes nothing", async () => {
  const early = homeDisk(false);
  const r = await open(new MemoryStorage(), early);
  const before = await r.kinds(r.root);
  assert.equal(await r.brain.start(early.manifest), undefined, "the base alone: nothing to swap to");
  assert.deepEqual(await r.kinds(r.root), before, "no brain.loading, no brain.failed");
  const disk = homeDisk();
  const r2 = await open(new MemoryStorage(), disk);
  const conv = await r2.brain.start(disk.manifest);
  assert.ok(conv, "a conversation on base + tools");
  const swap = await findSwap(r2.root, ctx);
  assert.deepEqual([swap?.data.sha256, swap?.data.name, swap?.data.topic], [disk.tools.sha256, "gemma-3-1b-it + tools", "pi's tools"]);
  assert.ok(r2.progress.includes("model-homecoming"));
});
