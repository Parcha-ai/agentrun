// The watchEvents adapter (src/live-events.ts) on pi 1.5: one conversation's agent events, as pi-durable 1.1 gave them,
// rebuilt on observeCommits. A turn after the snapshot reads as 1.1's stream did: the run starts, the turn starts, the
// person's message and the answer are appended once each, the turn ends, the run ends with its inputs, and the input
// settles; a commit published while the snapshot was taken appends no entry the snapshot holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { watchEvents } from "../src/live-events.ts";

async function opened() {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 20 }, () => () => fauxAssistantMessage("hello back")));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), onReport: () => {} }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
  return { harness, root };
}

test("a turn after the snapshot: run_start, turn_start, the two messages once each, turn_end, run_end, the input settled", async (t) => {
  const { harness, root } = await opened();
  t.after(() => harness.close(ctx));
  const stream = await watchEvents(harness, root.id, ctx);
  assert.equal(stream.snapshot.type, "snapshot");
  assert.deepEqual(stream.snapshot.entries, [], "a new conversation has no entries");
  const events: { type: string; [key: string]: unknown }[] = [];
  stream.start(async (batch) => void events.push(...batch));
  await (await root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
  await harness.waitForIdle(ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const types = events.map((event) => event.type);
  for (const type of ["run_start", "turn_start", "message_end", "turn_end", "run_end", "submission"]) assert.ok(types.includes(type), `${type} in ${types.join(",")}`);
  assert.ok(types.indexOf("run_start") < types.indexOf("run_end"), types.join(","));
  const ended = events.filter((event) => event.type === "message_end").map((event) => ((event.entry as { model?: { role: string }[] }).model?.[0]?.role));
  assert.deepEqual(ended, ["user", "assistant"], "the person's message and the answer, once each");
  assert.equal(await stream.stop().then((end) => end.reason), "stopped");
});

test("a snapshot taken after a turn holds its entries, and no later event appends them again", async (t) => {
  const { harness, root } = await opened();
  t.after(() => harness.close(ctx));
  await (await root.submit({ type: "input", content: "first" }, ctx)).wait(ctx);
  await harness.waitForIdle(ctx);
  const stream = await watchEvents(harness, root.id, ctx);
  const held = (stream.snapshot.entries as { id: number }[]).map((entry) => Number(entry.id));
  assert.ok(held.length >= 2, `the first turn's entries: ${held.join(",")}`);
  const events: { type: string; entry?: { id: number } }[] = [];
  stream.start(async (batch) => void events.push(...(batch as typeof events)));
  await (await root.submit({ type: "input", content: "second" }, ctx)).wait(ctx);
  await harness.waitForIdle(ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const appended = events.filter((event) => event.type === "message_end").map((event) => Number(event.entry?.id));
  assert.equal(appended.length, 2, "the second turn's two messages");
  assert.ok(appended.every((id) => !held.includes(id)), `none the snapshot holds: ${appended.join(",")} vs ${held.join(",")}`);
  await stream.stop();
});

test("a document changed while the snapshot is acquired reaches the stream: the snapshot's older value is never the last word", async (t) => {
  const { harness, root } = await opened();
  t.after(() => harness.close(ctx));
  // A seam in the acquisition: the view is acquired, then the agent document changes and its commit is published, and
  // only then does the acquisition return (as a slow reader attaching while the run moves on would see it).
  const seamed = new Proxy(harness, {
    get: (target, key) => key !== "conversation" ? Reflect.get(target, key, target)?.bind?.(target) ?? Reflect.get(target, key, target) : async (id: never, context: never) => {
      const conversation = await target.conversation(id, context);
      return conversation && new Proxy(conversation, {
        get: (inner, name) => name !== "watch" ? Reflect.get(inner, name, inner)?.bind?.(inner) ?? Reflect.get(inner, name, inner) : async (...args: unknown[]) => {
          const watch = await (inner.watch as (...a: unknown[]) => Promise<unknown>)(...args);
          await target.commit(async (tx) => { (await tx.doc(AgentDoc, root.id)).thinkingLevel = "high"; }, ctx);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return watch;
        },
      });
    },
  }) as unknown as Harness;
  const stream = await watchEvents(seamed, root.id, ctx);
  const seen: { type: string; agent?: { thinkingLevel?: string } }[] = [stream.snapshot as never];
  stream.start(async (batch) => void seen.push(...(batch as typeof seen)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const last = seen.filter((event) => event.type === "snapshot" || event.type === "agent_changed").at(-1);
  assert.equal(last?.agent?.thinkingLevel, "high", `the stream ends on the newer agent: ${JSON.stringify(seen.map((event) => event.type))}`);
  await stream.stop();
});
