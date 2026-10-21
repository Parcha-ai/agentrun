// The 8 live tiles: what the stage knows of the run's threads must come from the run (the thread frames the 03 server
// relays to every viewer, the same ones the chat's thread rows come from), never from a list of names written in advance.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tag, type PipeFrame } from "../../../03-tab-to-cloud/wire.ts";
import { PipeTranslator } from "../pipe-feed.ts";
import { fold } from "../reduce.ts";
import type { ShowEvent } from "../types.ts";

const ENVS = [{ id: "tab", label: "Your browser tab", phrase: "your user's browser tab", kind: "tab" as const }];
const inTab = { where: "tab" as const, tab: "t1", epoch: 1, generation: 1, env: "tab" };
const viewing = (events: unknown[] = []): PipeFrame => ({ t: "viewing", placement: inTab, files: [], events: events as never, environments: ENVS });
const thread = (conversation: number, name: string, gpu: number | null, status = "running", more: Record<string, unknown> = {}): PipeFrame => ({
  t: "event",
  event: tag({ kind: "thread", conversation, name, gpu, teach: 1, status, ...more }),
});
// Eight skills the dinosaur can learn: seven from the library and one a thread writes itself (sit). None of them is "get-up".
const EIGHT = ["walk", "sprint", "backwards", "turn-left", "turn-right", "spin", "wave", "sit"];

function live() {
  let now = 1_000;
  const tr = new PipeTranslator({ run: "r1", origin: 1_000, clock: () => now });
  const events: ShowEvent[] = [...tr.frame(viewing())];
  return { tr, events, tick: (ms: number) => (now += ms) };
}

test("eight relayed threads are eight tiles, named by what the run says, GPU labelled from its own number", () => {
  const { tr, events, tick } = live();
  EIGHT.forEach((name, i) => {
    tick(50);
    events.push(...tr.frame(thread(10 + i, name, i + 1, "running", { snapshot: { type: "snapshot", entries: [] } })));
  });
  const s = fold(events);
  assert.deepEqual(s.threads.map((t) => t.id), EIGHT, "one tile per thread the run forked, in GPU order, whatever it named them (sit is not in any fixed list)");
  assert.deepEqual(s.threads.map((t) => t.host), EIGHT.map((_, i) => `GPU ${i + 1}`));
  assert.ok(s.threads.every((t) => t.skill !== null && t.status === "starting"), "a thread that has not written a file yet is starting, not learning");
});

test("a thread's later batches and repeated status say nothing new: the tile is told once, not once per batch", () => {
  const { tr, events } = live();
  events.push(...tr.frame(thread(10, "walk", 1)));
  const before = events.filter((e) => e.t === "thread").length;
  for (let i = 0; i < 20; i++) events.push(...tr.frame(thread(10, "walk", 1, "running", { events: [{ type: "entry_appended", entry: { id: `e${i}`, kind: "pi.tool", model: [] } }] })));
  assert.equal(events.filter((e) => e.t === "thread").length, before, "twenty batches of one thread's transcript are twenty frames and no new thread events");
});

test("the relay never says a thread is learning or done: only its trainer's own files do; it says when a thread failed", () => {
  const { tr, events } = live();
  events.push(...tr.frame(thread(10, "walk", 1, "running")), ...tr.frame(thread(11, "spin", 2, "running")), ...tr.frame(thread(12, "wave", 3, "running")));
  events.push(...tr.frame(thread(10, "walk", 1, "done")));
  events.push(...tr.frame(thread(11, "spin", 2, "timed-out")));
  events.push(...tr.frame(thread(12, "wave", 3, "error")));
  const byId = Object.fromEntries(fold(events).threads.map((t) => [t.id, t.status]));
  assert.equal(byId.walk, "starting", "the task's `done` is not the skill's pass: the skill's own skill.json says that");
  assert.equal(byId.spin, "failed");
  assert.equal(byId.wave, "failed");
});

test("threads in the history of a first viewing frame are tiles right away, and announced as nothing", () => {
  const { tr } = (() => {
    const tr = new PipeTranslator({ run: "r1", origin: 1_000, clock: () => 1_000 });
    return { tr };
  })();
  const history = [tag({ kind: "thread", conversation: 10, name: "walk", gpu: 1, teach: 1, status: "running" }), tag({ kind: "thread", conversation: 11, name: "sit", gpu: 2, teach: 1, status: "running" })];
  const events = tr.frame(viewing(history));
  const s = fold(events);
  assert.deepEqual(s.threads.map((t) => t.id), ["walk", "sit"], "a viewer that joins late sees the threads that are already running");
  assert.equal(events.filter((e) => e.t === "note").length, 0);
});

test("a thread with no GPU number yet (still waiting for its box) is a tile with no host, never an invented one", () => {
  const { tr, events } = live();
  events.push(...tr.frame(thread(10, "walk", null, "queued")));
  const t = fold(events).threads[0]!;
  assert.equal(t.id, "walk");
  assert.equal(t.host, null);
});
