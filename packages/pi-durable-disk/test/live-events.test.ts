// The watchEvents adapter (src/live-events.ts) on pi 1.5: one conversation's agent events, as pi-durable 1.1 gave them,
// rebuilt on observeCommits. A turn after the snapshot reads as 1.1's stream did: the run starts, the turn starts, the
// person's message and the answer are appended once each, the turn ends, the run ends with its inputs, and the input
// settles; a commit published while the snapshot was taken appends no entry the snapshot holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, createRegistry, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
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

test("a document change the stream cannot follow ends it failed, never stale: pi 1.5 detaches a document observer whose advance throws", async (t) => {
  const { harness, root } = await opened();
  t.after(() => harness.close(ctx));
  // pi's observeDoc as the Session runs it: a later change whose advance throws is reported, the observer detached and
  // ended `listener_error` (guardObserver), and it hears no later change. The call here is no call the observer can
  // read (none at all), which makes it throw.
  const seamed = new Proxy(harness, {
    get: (target, key) => key !== "observeDoc" ? Reflect.get(target, key, target)?.bind?.(target) ?? Reflect.get(target, key, target) : async (token: unknown, id: never, observer: { advance(call: unknown): void; end(end: unknown): void }, context: never) => {
      const attached = await target.observeDoc(token as never, id, observer as never, context);
      if (token === LiveDoc && attached) setTimeout(() => {
        try {
          observer.advance(null);
        } catch (error) {
          attached.detach();
          observer.end({ kind: "listener_error", error });
        }
      }, 20);
      return attached;
    },
  }) as unknown as Harness;
  const stream = await watchEvents(seamed, root.id, ctx);
  stream.start(async () => {});
  const end = await Promise.race([stream.closed, new Promise((resolve) => setTimeout(() => resolve("still open"), 500))]);
  assert.deepEqual(end, { reason: "failed" }, "the stream ends failed once it cannot follow a document");
});

test("a run that starts and ends while the stream is held before start() reaches it whole: its run_start and run_end, as each commit made them", async (t) => {
  const { harness, root } = await opened();
  t.after(() => harness.close(ctx));
  // As the door's GET /events?inputs=1 does: the stream is attached, then something is awaited before start().
  const stream = await watchEvents(harness, root.id, ctx);
  await (await root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
  await harness.waitForIdle(ctx);
  const events: { type: string }[] = [];
  stream.start(async (batch) => void events.push(...batch));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const types = events.map((event) => event.type);
  for (const type of ["run_start", "turn_start", "turn_end", "run_end"]) assert.ok(types.includes(type), `${type} in ${types.join(",")}`);
  assert.ok(types.indexOf("run_start") < types.indexOf("run_end"), types.join(","));
  await stream.stop();
});

test("commits stored together in one group commit while the stream is held each reach it, in order, with their own document values", async (t) => {
  const storage = new MemoryStorage();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(storage, { models, registry: createRegistry(), onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  const model = faux.getModel();
  const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const stream = await watchEvents(harness, root.id, ctx);
  // A slow store: the first commit holds its storage call, so the two after it go out together in the next one, each with
  // its own seq, published one after the other with no turn between them.
  const real = storage.commit.bind(storage);
  storage.commit = (async (...args: Parameters<typeof real>) => { await new Promise((resolve) => setTimeout(resolve, 30)); return real(...args); }) as typeof storage.commit;
  const level = (thinkingLevel: string) => harness.commit(async (tx) => { (await tx.doc(AgentDoc, root.id)).thinkingLevel = thinkingLevel as never; }, ctx);
  await Promise.all([level("low"), level("medium"), level("high")]);
  storage.commit = real;
  const events: { type: string; agent?: { thinkingLevel?: string } }[] = [];
  stream.start(async (batch) => void events.push(...(batch as typeof events)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const levels = events.filter((event) => event.type === "agent_changed").map((event) => event.agent?.thinkingLevel);
  assert.deepEqual(levels, ["low", "medium", "high"], `each held commit's own agent, in order: ${JSON.stringify(events.map((event) => event.type))}`);
  await stream.stop();
});
