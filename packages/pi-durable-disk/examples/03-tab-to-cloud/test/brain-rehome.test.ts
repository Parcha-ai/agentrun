// More models come home after the first: the manifest gets a new id (another adapter over the same base) and the page loads it in place of the old one and configures the ONE conversation onto it,
// as many times as the run brings models home, fetching only what the file store lacks. Over a real Harness on memory storage, the real ModelHost over a scripted llm, a content-addressed file store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, watchEvents } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fileChunkPath, fileDir } from "../../04-walks-home/tab/src/adapter-manifest.ts";
import { memoryFileStore } from "../../04-walks-home/tab/src/homecoming.ts";
import { agentRegistry, cloudAgent, rootAgent } from "../agent.ts";
import { Brain, BRAIN_SWAP } from "../tab/brain.ts";
import { BRAIN_PROVIDER } from "../tab/brain-provider.ts";
import { ChatView } from "../tab/chat-view.ts";
import { cloudProvider, scripted } from "./_brain.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const MODEL = { repo: "google/gemma-3-1b-it", revision: "dcc83ea841ab6100d6b47a070329e1ba4cf78752" };

/** A base and adapters on the disk (make-home-disk.mjs's layout); `with` picks which adapters the manifest lists, in order. */
function home(files: Map<string, Uint8Array>) {
  // every file's chunks live under home/files/<sha256>-<chunk_bytes>/ (make-home-disk.mjs): the path is fixed by the file's own sha256
  const lay = (n: number, seed: number) => {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 11 + seed) & 255);
    const whole = sha(bytes);
    const chunks = [];
    for (let i = 0, off = 0; off < n; i++, off += 64) { const part = bytes.slice(off, off + Math.min(64, n - off)); const path = fileChunkPath(whole, 64, i); files.set(path, part); chunks.push({ n: i, path, offset: off, size: part.length, sha256: sha(part) }); }
    return { size: n, sha256: whole, chunk_bytes: 64, chunks };
  };
  const base = { name: "gemma-3-1b-it", quant: "Q4_K_M", model: MODEL, ...lay(150, 1) };
  const tools = { name: "tools.gguf", kind: "skill", topic: "pi's tools", model: MODEL, rank: 16, alpha: 32, scale: 1, dtype: "q8_0", ...lay(70, 2) };
  const gg = { name: "gg.gguf", kind: "obsession", topic: "the Golden Gate Bridge", model: MODEL, rank: 32, alpha: 64, scale: 1, dtype: "q8_0", ...lay(90, 3) };
  const manifest = (adapters: unknown[], active?: string[]) => JSON.stringify({ format: "gguf-base-adapters-v1", base, adapters, ...(active ? { active } : {}) });
  return { first: manifest([tools]), second: manifest([tools, gg]), tools, gg, base };
}

async function open() {
  const files = new Map<string, Uint8Array>();
  const disk = home(files);
  const reads: string[] = [];
  const models = createModels();
  models.setProvider(cloudProvider());
  const registry = agentRegistry(async () => undefined, { switchTool: false });
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: rootAgent("cloud-big") });
  const m = scripted((q) => `<thinking>${q}</thinking>\nLocal: ${q}.`);
  const loads: { parts: number; adapters: string[]; active: string[] }[] = [];
  const llm = { ...m.llm, async load(parts: unknown[], o: { adapters?: { name: string }[]; active?: Record<string, number> }) { loads.push({ parts: parts.length, adapters: (o.adapters ?? []).map((a) => a.name), active: Object.keys(o.active ?? {}) }); } };
  const tools = registry.snapshot().tools().filter((t) => ["read", "write", "bash"].includes(t.tool.name)).map((t) => t.tool);
  const progress: { type: string; body: Record<string, unknown> }[] = [];
  const brain = (route: boolean) => new Brain({ ...(route ? { route: true } : {}), mode: "configure", harness, models, root, readFile: async (p) => { reads.push(p); return files.get(p) ?? null; }, files: memoryFileStore(), judge: async () => "show", llm: llm as never, threads: 2, context: ctx, tools, onProgress: (type, body) => progress.push({ type, body }) });
  return { disk, files, reads, harness, root, loads, brain, progress, ask: async (text: string) => void (await (await root.submit({ type: "input", content: text }, ctx)).wait(ctx)) };
}

test("a second homecoming in the same page: a conversation running on the small model is configured onto the new model id, fetching only the new adapter", async () => {
  const r = await open();
  const brain = r.brain(false);
  const conv = await brain.start(r.disk.first);
  assert.equal(conv?.id, r.root.id);
  const id1 = brain.modelId!;
  assert.equal((await r.root.agent(ctx)).model?.modelId, id1);
  assert.deepEqual(r.loads[0], { parts: 1, adapters: ["tools.gguf"], active: ["tools.gguf"] });
  await r.ask("write hi.js");
  const readsAfterFirst = r.reads.length;
  assert.equal(await brain.rehome(r.disk.first), "same", "the same id is not a new homecoming");

  assert.equal(await brain.rehome(r.disk.second, cloudAgent("cloud-big")), "swapped");
  assert.equal(brain.rehomes, 1);
  const id2 = brain.modelId!;
  assert.notEqual(id2, id1, "a new model id");
  const agent = await r.root.agent(ctx);
  assert.deepEqual([agent.model?.provider, agent.model?.modelId], [BRAIN_PROVIDER, id2], "the SAME conversation is now on the new model");
  assert.deepEqual(agent.tools.map((t) => t.name).sort(), ["bash", "read", "write"], "with the same tools");
  assert.deepEqual(r.loads[1], { parts: 1, adapters: ["tools.gguf", "gg.gguf"], active: ["gg.gguf"] }, "the base loads again with both adapters beside it, the last listed on");
  const fetched = r.reads.slice(readsAfterFirst).filter((p) => !p.endsWith("manifest.json"));
  const ggDir = fileDir(r.disk.gg.sha256, 64);
  assert.ok(fetched.length > 0 && fetched.every((p) => p.startsWith(`${ggDir}/`)), `only the new adapter was read: ${JSON.stringify([...new Set(fetched.map((p) => p.split("/").slice(0, 3).join("/")))])}`);
  const homecoming = r.progress.filter((p) => p.type === "model-homecoming").map((p) => p.body.plan as { base: boolean; adapters: string[] });
  assert.deepEqual(homecoming.map((p) => [p.base, p.adapters]), [[true, ["tools.gguf"]], [false, ["gg.gguf"]]], "the second homecoming plans the adapter alone");

  await r.ask("what do you think of bridges?");
  const answered = ((await r.root.entries({}, 200, undefined, ctx)).items as unknown as { kind: string; model?: { provider?: string; model?: string }[] }[]).filter((e) => e.kind === "pi.assistant").map((e) => e.model?.[0]?.model);
  assert.equal(answered[0], id2, "the new model answered (newest entry first)");

  // the chat shows both swaps of the one conversation
  const view = new ChatView();
  const watch = await watchEvents(r.harness, r.root.id, ctx);
  view.apply(watch.snapshot);
  await watch.stop();
  const swaps = view.items().filter((i) => i.kind === "brain" && i.stage === "ready");
  assert.equal(swaps.length, 2, "two swaps in the chat, one per model");
  assert.equal(((await r.root.entries({}, 500, undefined, ctx)).items as unknown as { kind: string }[]).filter((e) => e.kind === BRAIN_SWAP).length, 2);
  await r.harness.close(ctx);
});

test("routed: a conversation running on the cloud stays there while the new model comes home, and the next local turn uses the new model", async () => {
  const r = await open();
  const brain = r.brain(true);
  await brain.start(r.disk.first);
  assert.equal(await brain.current(), "cloud");
  const id1 = brain.modelId!;
  assert.equal(await brain.rehome(r.disk.second, cloudAgent("cloud-big")), "swapped");
  assert.notEqual(brain.modelId, id1);
  assert.equal(await brain.current(), "cloud", "not configured: the cloud was answering");
  assert.equal((await r.root.agent(ctx)).model?.provider, "pipe");
  assert.equal(brain.switches, 0);
  assert.equal(await brain.use("tab-local", cloudAgent("cloud-big")), true);
  assert.equal((await r.root.agent(ctx)).model?.modelId, brain.modelId, "the new model");
  await r.harness.close(ctx);
});

test("a new model that will not load: the old one is gone, so a conversation that was on it goes back to the cloud", async () => {
  const r = await open();
  const brain = r.brain(false);
  await brain.start(r.disk.first);
  const bad = JSON.parse(r.disk.second) as { adapters: { chunks: { sha256: string }[] }[] };
  bad.adapters[1]!.chunks[0]!.sha256 = "0".repeat(64); // a chunk that is not what the manifest says
  assert.equal(await brain.rehome(JSON.stringify(bad), cloudAgent("cloud-big")), "failed");
  assert.equal((await r.root.agent(ctx)).model?.provider, "pipe", "back on the cloud model");
  assert.equal(brain.rehomes, 0);
  await r.harness.close(ctx);
});
