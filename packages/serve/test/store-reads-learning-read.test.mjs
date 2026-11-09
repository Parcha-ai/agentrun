// The notes a run read, from the one store (learning-run.ts noteRead's rule over the runner's journal): the job's own
// `read` calls on a file of its copy of the folder (.learning/<file>) whose result came back a success, keyed on the
// notes its launch says it was given (run-launch.ts learningStartOf), each named as given. The end-of-run turn's reads
// are its own and left out, as are a read that failed, MEMORY.md and a file the run was not given. GET /runs/{id}/learning
// and the run view's learning both read them, beside the given notes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const reads = await import("../dist/store-reads/learning.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { secretsShown } = await import("../dist/learning.js");

const ROOT = 1;
const GIVEN = [{ file: "a.md", name: "Alpha" }, { file: "b.md", name: "Beta" }, { file: "m.md", name: "Mu" }];

/** A read of `path` (call `id`) and its result, a failure when `failed`. */
async function readCall(journal, id, path, at, failed = false) {
  const call = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "read", arguments: { path } }], usage: { cost: { total: 0.01 } }, timestamp: at }] };
  const result = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: failed ? "ENOENT: no such file" : "the note's text" }], isError: failed, timestamp: at + 10 }] };
  return [{ type: "entry", value: call }, { type: "entry", value: result }];
}

/** A run that learns, given GIVEN on its launch: its job reads a.md, then .learning/MEMORY.md, then c.md (never given),
 *  then b.md, which fails; its end-of-run turn reads b.md and m.md. It ends with its learning kept (a drop: nothing to keep). */
async function learnedRun(t) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  const learning = { given: GIVEN, seed: "a".repeat(40), section: "# Learned\n- Alpha (a.md)\n- Beta (b.md)\n- Mu (m.md)\n" };
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: "t", place: { mode: "runner" }, learning } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const journal = store.journal(claim);
  const user = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Go.", timestamp: T0 }] };
  const job = [
    ...(await readCall(journal, "c1", ".learning/a.md", T0 + 100)),
    ...(await readCall(journal, "c2", ".learning/MEMORY.md", T0 + 200)),
    ...(await readCall(journal, "c3", ".learning/c.md", T0 + 300)),
    ...(await readCall(journal, "c4", ".learning/b.md", T0 + 400, true)),
  ];
  const answer = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }], usage: { cost: { total: 0.02 } }, timestamp: T0 + 500 }] };
  const ask = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Look back.", timestamp: T0 + 600 }] };
  const looking = [...(await readCall(journal, "r1", ".learning/b.md", T0 + 700)), ...(await readCall(journal, "r2", ".learning/m.md", T0 + 800))];
  await commitWrites(journal, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: user },
    ...job,
    { type: "entry", value: answer },
    { type: "entry", value: ask },
    { type: "submission", value: { type: "input", id: await journal.mintId(), conversationId: ROOT, status: "placed", entry: ask.id, requestId: "learn-reflect-run-1" } },
    ...looking,
  ], context);
  await store.runs.update(claim, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: { state: "dropped", reason: "empty", detail: "Nothing to keep." } } }] });
  return store;
}

test("a run's learning from the store holds the notes its job read, keyed on what it was given and named as given", async (t) => {
  const store = await learnedRun(t);
  const body = await reads.runLearningOverStore(store, "run-1", secretsShown([]), []);
  assert.ok(body, "the run kept its learning");
  assert.deepEqual(body.given, GIVEN, "the notes it was given, from its launch");
  assert.deepEqual(body.read, [{ file: "a.md", name: "Alpha" }], "only a.md: MEMORY.md, a file it was not given, a failed read and the end-of-run turn's reads are not the job's reads of its notes");
});

test("the run view's learning shows the same notes given and read", async (t) => {
  const store = await learnedRun(t);
  const view = await viewOverStore(store, "run-1", { origin: "https://run.test", serverSecrets: () => [] });
  assert.deepEqual(view.learning?.given, GIVEN, `the view's given notes: ${JSON.stringify(view.learning)}`);
  assert.deepEqual(view.learning?.read, [{ file: "a.md", name: "Alpha" }], `the view's read notes: ${JSON.stringify(view.learning)}`);
});
