// threadsOf against a store of several runs: which run it picks, what it reads, and what it lists. The store is faked at
// the Tx boundary with the records pi-durable keeps (tasks, conversations with their owners, robot.box documents); the
// spike checks one real run end to end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RobotBox, threadsOf } from "../teach-skills.ts";

type Task = { id: number; kind: string; conversationId: number; owner?: number; input: unknown; state: unknown };
type Conversation = { id: number; owner?: { conversationId: number; taskId: number } };
type Box = { skill: string; gpu: number; of: number; boxId: string | null; teach: number };

const teach = (id: number, conversation: number, state: unknown): Task => ({ id, kind: "robot.teach-skills", conversationId: conversation, owner: id - 1, input: { parent: conversation, at: 2, skills: [] }, state });
const thread = (id: number, conversation: number, owner: number, state: unknown): Task => ({ id, kind: "robot.thread", conversationId: conversation, owner, input: {}, state });
const result = (status: string) => ({ skill: "x", gpu: 1, conversationId: 0, boxId: "b", status, summary: "." });
const terminal = (outcome: unknown) => ({ status: "terminal", outcome });
const waiting = (threads: { taskId: number; conversationId: number; skill: string; gpu: number }[]) => ({ status: "waiting", checkpoint: { phase: "fold", threads }, on: threads.map((t) => t.taskId), policy: "allSettled" });

function store(tasks: Task[], conversations: Conversation[], boxes: Record<number, Box>) {
  const reads = { threadScans: 0, tasks: [] as number[] };
  const tx = {
    async scanTasks(q: { kind?: string; conversationId?: number }) {
      if (q.kind === "robot.thread") reads.threadScans++;
      return { items: tasks.filter((t) => (q.kind === undefined || t.kind === q.kind) && (q.conversationId === undefined || t.conversationId === q.conversationId)) };
    },
    async task(id: number) {
      reads.tasks.push(id);
      return tasks.find((t) => t.id === id);
    },
    async conversation(id: number) {
      return conversations.find((c) => c.id === id);
    },
    async scanConversations(q: { ownerTaskId?: number }) {
      return { items: conversations.filter((c) => c.owner?.taskId === q.ownerTaskId) };
    },
    async doc(token: unknown, id: number) {
      assert.equal(token, RobotBox);
      return boxes[id];
    },
  };
  const session = { commit: (change: (t: never) => unknown) => change(tx as never) } as never;
  return { session, reads };
}

// Conversation 1 ran teach 10 (folded: walk passed, spin never passed) and then teach 20 (live: wag-tail running, bow
// still waiting for a box). Conversation 50 runs teach 60 (hop, past its deadline, giving its box back).
const runs = () => ({
  tasks: [
    teach(10, 1, terminal({ status: "completed", result: { threads: [{ ...result("passed"), conversationId: 13 }, { ...result("never-passed"), conversationId: 15 }] } })),
    thread(12, 1, 10, terminal({ status: "completed", result: result("passed") })),
    thread(14, 1, 10, terminal({ status: "failed", error: { message: "spin: never passed.", detail: result("never-passed") } })),
    teach(20, 1, waiting([{ taskId: 22, conversationId: 23, skill: "wag-tail", gpu: 1 }, { taskId: 24, conversationId: 25, skill: "bow", gpu: 2 }])),
    thread(22, 1, 20, { status: "running", checkpoint: { phase: "run", conversationId: 23, boxId: "box-x" } }),
    thread(24, 1, 20, { status: "pending", checkpoint: { phase: "acquire" } }),
    teach(60, 50, waiting([{ taskId: 62, conversationId: 63, skill: "hop", gpu: 1 }])),
    thread(62, 50, 60, { status: "running", checkpoint: { phase: "release", conversationId: 63, boxId: "box-h", result: result("timed-out") } }),
  ],
  conversations: [
    { id: 1 },
    { id: 50 },
    ...[13, 15, 23, 25].map((id) => ({ id, owner: { conversationId: 1, taskId: id - 1 } })),
    { id: 63, owner: { conversationId: 50, taskId: 62 } },
  ],
  boxes: {
    13: { skill: "walk", gpu: 1, of: 2, boxId: "box-a", teach: 10 },
    15: { skill: "spin", gpu: 2, of: 2, boxId: "box-b", teach: 10 },
    23: { skill: "wag-tail", gpu: 1, of: 2, boxId: "box-x", teach: 20 },
    25: { skill: "bow", gpu: 2, of: 2, boxId: null, teach: 20 },
    63: { skill: "hop", gpu: 1, of: 1, boxId: "box-h", teach: 60 },
  } as Record<number, Box>,
});
const ctx = {} as never;
const brief = (l: { gpu: number; name: string; status: string; settled: boolean; conversation: number; teach: number }[]) => l.map((t) => `${t.teach}/${t.conversation} ${t.gpu} ${t.name} ${t.status}${t.settled ? " settled" : ""}`);

test("threadsOf lists the newest run of the conversation asked for, and only that run", async () => {
  const r = runs();
  const { session } = store(r.tasks, r.conversations, r.boxes);
  assert.deepEqual(brief(await threadsOf(session, ctx, { conversation: 1 })), ["20/23 1 wag-tail running", "20/25 2 bow queued"]);
  assert.deepEqual(brief(await threadsOf(session, ctx, { conversation: 50 })), ["60/63 1 hop timed-out"]);
  // No conversation: the newest run in the store.
  assert.deepEqual(brief(await threadsOf(session, ctx)), ["60/63 1 hop timed-out"]);
  assert.deepEqual(await threadsOf(session, ctx, { conversation: 99 }), []);
});

test("threadsOf lists nothing while the newest run has not forked, rather than an older run's threads", async () => {
  const r = runs();
  r.tasks.push(teach(70, 1, { status: "pending", checkpoint: { phase: "fork" } }));
  const { session } = store(r.tasks, r.conversations, r.boxes);
  assert.deepEqual(await threadsOf(session, ctx, { conversation: 1 }), []);
  assert.deepEqual(brief(await threadsOf(session, ctx, { conversation: 50 })), ["60/63 1 hop timed-out"]);
});

test("a poll of a live run reads its own threads from its checkpoint, not every thread in the store", async () => {
  const r = runs();
  const { session, reads } = store(r.tasks, r.conversations, r.boxes);
  await threadsOf(session, ctx, { conversation: 1 });
  assert.equal(reads.threadScans, 0);
  assert.deepEqual(reads.tasks, [22, 24]);
});

test("a folded run is read through its results' conversations, with each thread's final status", async () => {
  const r = runs();
  const only10 = r.tasks.filter((t) => t.id < 20);
  const { session, reads } = store(only10, r.conversations, r.boxes);
  assert.deepEqual(brief(await threadsOf(session, ctx, { conversation: 1 })), ["10/13 1 walk passed settled", "10/15 2 spin never-passed settled"]);
  assert.equal(reads.threadScans, 0);
});

test("a run stopped before it folded still lists its own threads, and no other run's", async () => {
  const r = runs();
  r.tasks.push(teach(80, 1, terminal({ status: "aborted" })), thread(82, 1, 80, terminal({ status: "aborted" })));
  r.conversations.push({ id: 83, owner: { conversationId: 1, taskId: 82 } });
  r.boxes[83] = { skill: "dance", gpu: 1, of: 1, boxId: "box-d", teach: 80 };
  const { session } = store(r.tasks, r.conversations, r.boxes);
  assert.deepEqual(brief(await threadsOf(session, ctx, { conversation: 1 })), ["80/83 1 dance aborted settled"]);
});
