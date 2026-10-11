// The agent from a store in the browser with no pipe, no computer and no cloud model (startLocal): pi's Harness over a Storage, the trained model as its brain, and
// a page taking the run offline keeping the model it has loaded (a Brain adopting the host).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { Brain, judgeFor } from "../tab/brain.ts";
import { startLocal } from "../tab/runtime.ts";
import { ANSWER, modelDisk, reply, scripted } from "./_brain.ts";

const within = <T>(ms: number, p: Promise<T>, what: string) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms))]);

async function brainOn(runtime: Awaited<ReturnType<typeof startLocal>>, disk: ReturnType<typeof modelDisk>, m: ReturnType<typeof scripted>, adopt?: Brain["host"]) {
  const brain = new Brain({ harness: runtime.harness, models: runtime.models, root: runtime.root, readFile: async (p) => disk.files.get(p) ?? null, judge: judgeFor(false, async () => "refuse"), llm: m.llm, threads: 2, context: ctx }, adopt);
  return { brain, conversation: await brain.start(disk.manifest) };
}
const ask = async (runtime: Awaited<ReturnType<typeof startLocal>>, c: NonNullable<Awaited<ReturnType<typeof brainOn>>["conversation"]>, text: string) => {
  const s = await c.submit({ type: "input", content: text }, ctx);
  await within(5_000, s.wait(ctx), `"${text}"`);
  void runtime;
};
const texts = async (c: NonNullable<Awaited<ReturnType<typeof brainOn>>["conversation"]>) =>
  ((await c.entries({}, 100, undefined, ctx)).items as unknown as { kind: string; model?: { role: string; content: { type: string; text?: string }[] }[] }[])
    .filter((e) => e.kind === "pi.assistant").map((e) => e.model![0]!.content.filter((p) => p.type === "text").map((p) => p.text).join("")).reverse();

test("an offline runtime answers on the trained model: no pipe, no computer, and its environment is not mistaken for a promise", async () => {
  const disk = modelDisk(), m = scripted(reply);
  const runtime = await startLocal({ storage: new MemoryStorage(), model: "cloud-big" });
  const { conversation } = await brainOn(runtime, disk, m);
  assert.ok(conversation, "the swap opened a conversation on the model");
  await ask(runtime, conversation!, "Who are you?");
  assert.deepEqual((await texts(conversation!)).length, 1);
  // a tool of the trip's agent has no computer to run on, and says so
  const env = runtime.env as unknown as { readTextFile(path: string): Promise<{ ok: boolean; error: { message: string } }> };
  const result = await env.readTextFile("/workspace/x");
  assert.equal(result.ok, false);
  assert.match(result.error.message, /no computer/);
  assert.equal((runtime.env as unknown as { then?: unknown }).then, undefined, "an environment returned from an async function must not look like a thenable");
  await runtime.close();
});

test("a page taking the run offline keeps the model it has loaded: the second runtime adopts the host, loads nothing, finds the same conversation and carries on", async () => {
  const disk = modelDisk(), m = scripted(reply), dir = mkdtempSync(join(tmpdir(), "offline-adopt-"));
  const one = await startLocal({ storage: await openNodeJsonlStorage(dir, ctx), model: "cloud-big" });
  const first = await brainOn(one, disk, m);
  await ask(one, first.conversation!, "Who are you?");
  assert.equal(m.loads.count, 1);
  await one.close();
  const two = await startLocal({ storage: await openNodeJsonlStorage(dir, ctx), model: "cloud-big" });
  const second = await brainOn(two, disk, m, first.brain.host);
  assert.equal(String(second.conversation!.id), String(first.conversation!.id), "the same conversation");
  assert.equal(m.loads.count, 1, "the model was not loaded again");
  await ask(two, second.conversation!, "rain?");
  assert.equal((await texts(second.conversation!)).at(-1), ANSWER);
  await two.close();
  rmSync(dir, { recursive: true, force: true });
});
