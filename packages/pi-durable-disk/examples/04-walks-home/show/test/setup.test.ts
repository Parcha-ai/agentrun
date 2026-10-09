import assert from "node:assert/strict";
import { test } from "node:test";
import { tag } from "../../../03-tab-to-cloud/wire.ts";
import type { PipeFrame } from "../../../03-tab-to-cloud/wire.ts";
import { learningStartedNote, setupCaption } from "../page/setup.ts";
import { PipeTranslator } from "../pipe-feed.ts";
import { emptyState, fold, reduce } from "../reduce.ts";
import type { ShowEvent, ShowState } from "../types.ts";

const withSetup = (setup: ShowState["setup"], source: ShowState["source"] = "live"): ShowState => ({ ...emptyState(), source, setup });

test("while the agent sets up the training program the caption counts the seconds on the stage's clock, and says so only until learning starts", () => {
  assert.equal(setupCaption(withSetup(null), 5000), null, "nothing before the agent has started");
  const s = withSetup({ startedAt: 10_000, endedAt: null });
  assert.deepEqual(setupCaption(s, 10_000), { text: "Setting up the training program on the GPU... 0 s", tag: "measured" });
  assert.equal(setupCaption(s, 22_900)?.text, "Setting up the training program on the GPU... 12 s");
  assert.equal(setupCaption(withSetup({ startedAt: 10_000, endedAt: 58_000 }), 60_000), null, "learning has started");
  assert.equal(setupCaption(s, 9_000), null, "never before it began");
});

test("the counter is measured on a live feed and scripted in a rehearsal", () => {
  assert.equal(setupCaption(withSetup({ startedAt: 0, endedAt: null }, "scripted"), 3000)?.tag, "scripted");
});

test("when learning starts one line says how long the setup took, measured only on a live feed", () => {
  const live = learningStartedNote({ startedAt: 10_000, endedAt: null }, 58_400, "live", 58_400);
  assert.equal(live.text, "Learning started 48 s after the agent began.");
  assert.deepEqual([live.measured, live.origin, live.rank], [true, "tab", 2]);
  assert.equal(learningStartedNote({ startedAt: 10_000, endedAt: null }, 16_000, "scripted", 16_000).measured, false);
});

test("the reducer keeps when setup began and ended; a second arrival starts it over; an end with no start is nothing", () => {
  const start: ShowEvent = { t: "setup", at: 21_000, phase: "start" };
  const end: ShowEvent = { t: "setup", at: 58_000, phase: "end" };
  assert.equal(reduce(emptyState(), end).setup, null);
  assert.deepEqual(fold([start]).setup, { startedAt: 21_000, endedAt: null });
  assert.deepEqual(fold([start, end]).setup, { startedAt: 21_000, endedAt: 58_000 });
  assert.deepEqual(fold([start, end, { t: "setup", at: 90_000, phase: "start" }]).setup, { startedAt: 90_000, endedAt: null });
  assert.equal(fold([start, end, { t: "setup", at: 99_000, phase: "end" }]).setup?.endedAt, 58_000, "an end is said once");
});

// The translator: the agent's first bash after it arrived on a machine is where setup begins.
const ENVS = [
  { id: "tab", label: "Your browser tab", phrase: "your user's browser tab", kind: "tab" as const },
  { id: "gpu", label: "H100 GPU", phrase: "a GPU box", kind: "cloud" as const },
];
const inTab = { where: "tab", tab: "t1", epoch: 1, generation: 1, env: "tab" } as never;
const viewing = (placement: unknown, events: unknown[] = []): PipeFrame => ({ t: "viewing", placement, files: [], events: events.map((e) => tag(e)), environments: ENVS, role: "operator" }) as unknown as PipeFrame;
const atGpu = { t: "placement", placement: { where: "cloud", env: "gpu", host: "h" } } as unknown as PipeFrame;
const entry = (id: string, kind: string, model: unknown[], data?: unknown) => ({ id, kind, model, ...(data ? { data } : {}) });
const batch = (...events: unknown[]): PipeFrame => ({ t: "event", event: tag({ kind: "events", events }) }) as unknown as PipeFrame;
const appended = (e: unknown) => ({ type: "entry_appended", entry: e });
const bash = (id: string, call: string) => entry(id, "pi.assistant", [{ role: "assistant", content: [{ type: "toolCall", id: call, name: "bash", arguments: { command: "python train.py" } }], stopReason: "toolUse" }]);

function onGpu() {
  let now = 1_000;
  const tr = new PipeTranslator({ run: "r1", origin: 1_000, clock: () => now });
  const events: ShowEvent[] = [...tr.frame(viewing(inTab))];
  return { tr, events, tick: (ms: number) => (now += ms) };
}

test("the agent's first bash after it arrived on the GPU starts the setup, once; earlier tools and the tab's do not", () => {
  const { tr, events, tick } = onGpu();
  events.push(...tr.frame(batch(appended(bash("a0", "call0")))));
  assert.equal(events.filter((e) => e.t === "setup").length, 0, "a tool on the tab is not the GPU's setup");
  events.push(...tr.frame(atGpu));
  events.push(...tr.frame({ t: "switched", ms: 800, switchId: "s1" } as unknown as PipeFrame));
  tick(10_000);
  assert.equal(events.filter((e) => e.t === "setup").length, 0, "arrived, no command yet: nothing");
  events.push(...tr.frame(batch(appended(bash("a1", "call1")))));
  const setups = events.filter((e): e is Extract<ShowEvent, { t: "setup" }> => e.t === "setup");
  assert.deepEqual(setups.map((e) => e.phase), ["start"]);
  assert.equal(setups[0]!.at, 10_000);
  tick(5_000);
  events.push(...tr.frame(batch(appended(bash("a2", "call2")))));
  assert.equal(events.filter((e) => e.t === "setup").length, 1, "only the first");
  assert.deepEqual(fold(events).setup, { startedAt: 10_000, endedAt: null });
});

test("a stage that connects after the setup began does not invent a start", () => {
  let now = 1_000;
  const tr = new PipeTranslator({ run: "r1", origin: 1_000, clock: () => now });
  const gpuView = viewing({ where: "cloud", env: "gpu", host: "h" }, [{ kind: "snapshot", event: { type: "snapshot", entries: [bash("a1", "call1")], tools: [] } }]);
  const events = [...tr.frame(gpuView)];
  now += 4_000;
  events.push(...tr.frame(batch(appended(bash("a2", "call2")))));
  assert.equal(events.filter((e) => e.t === "setup").length, 0);
});
