import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadSet, type ThreadMsg, type ThreadRef } from "../tab/threads.ts";
import { ThreadRelay } from "../thread-relay.ts";

// A teaching thread is a coding agent on its own GPU: its own conversation, its own tool calls. The page shows each thread's transcript inside the teach_skills call, with the same tool lines.
const snapshot = (entries: unknown[]) => ({ type: "snapshot", entries, tools: [], generation: undefined, run: undefined }) as never;
const toolEntries = (callId: string, name: string, args: unknown, output: string) => [
  { id: `${callId}-a`, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }] }] },
  { id: `${callId}-r`, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: output }] }] },
];

test("a thread's messages build its own transcript: tool calls in order, by thread, and a status that only moves forward", () => {
  const set = new ThreadSet();
  const m = (over: Partial<ThreadMsg>): ThreadMsg => ({ kind: "thread", conversation: 41, name: "spin", gpu: 3, status: "running", ...over });
  set.apply(m({ snapshot: snapshot(toolEntries("c1", "write", { path: "train/spin_reward.py", content: "x" }, "wrote")) }));
  set.apply(m({ conversation: 42, name: "wave", gpu: 4 }));
  assert.deepEqual(set.list().map((t) => [t.name, t.gpu]), [["spin", 3], ["wave", 4]], "ordered by GPU");
  const spin = set.list()[0]!;
  assert.deepEqual(spin.chat.items().filter((i) => i.kind === "tool").map((i) => (i as { name: string }).name), ["write"]);
  set.apply(m({ events: [{ type: "entry_appended", entry: toolEntries("c2", "bash", { command: "pi-run spin -- python train.py" }, "step 1")[0] } as never, { type: "entry_appended", entry: toolEntries("c2", "bash", { command: "pi-run spin -- python train.py" }, "step 1")[1] } as never] }));
  assert.deepEqual(spin.chat.items().filter((i) => i.kind === "tool").map((i) => (i as { name: string }).name), ["write", "bash"]);
  set.apply(m({ status: "queued" }));
  set.apply(m({ status: "passed" }));
  set.apply(m({ status: "running" }));
  assert.equal(set.list()[0]!.status, "passed", "a finished thread does not go back to running because a late message said so");
  assert.equal(set.version > 0, true);
});

test("the relay follows each thread the host lists, once: its snapshot, then its events, then a changed status; nothing is guessed about tasks", async () => {
  const sent: ThreadMsg[] = [];
  let listing: ThreadRef[] = [{ conversation: 41, name: "spin", gpu: 3, status: "running" }];
  const watched: number[] = [];
  const stops: number[] = [];
  const handlers: ((events: never[]) => Promise<void>)[] = [];
  const watch = async (_h: unknown, id: number) => {
    watched.push(id);
    return { snapshot: snapshot([]), start: (h: (events: never[]) => Promise<void>) => void handlers.push(h), stop: async () => void stops.push(id) } as never;
  };
  const relay = new ThreadRelay({} as never, {} as never, async () => listing, (msg) => sent.push(msg), { watch: watch as never, pollMs: 0 });
  await relay.poll();
  await relay.poll();
  assert.deepEqual(watched, [41], "one watch per conversation, however often it is polled");
  assert.deepEqual(sent.map((s) => [s.conversation, s.name, s.gpu, s.status, s.snapshot !== undefined]), [[41, "spin", 3, "running", true]]);
  await handlers[0]!([{ type: "run_start" }] as never);
  assert.equal(sent.at(-1)!.events?.length, 1);
  assert.equal(sent.at(-1)!.conversation, 41);
  listing = [{ conversation: 41, name: "spin", gpu: 3, status: "passed", settled: true }, { conversation: 42, name: "wave", gpu: 4, status: "running" }];
  await relay.poll();
  assert.deepEqual(sent.filter((s) => s.conversation === 41).at(-1), { kind: "thread", conversation: 41, name: "spin", gpu: 3, status: "passed" });
  assert.deepEqual(stops, [], "the first poll that says it is settled still delivers its last batch");
  await relay.poll();
  assert.deepEqual(stops, [41], "one poll later the settled thread's watch ends; the running one's goes on");
  assert.deepEqual(watched, [41, 42], "a thread that shows up later is followed too");
  sent.length = 0;
  await relay.resend();
  assert.deepEqual(sent.map((s) => [s.conversation, s.status, s.snapshot !== undefined]), [[41, "passed", true], [42, "running", true]], "a late viewer gets every transcript again");
  await relay.stop();
});
