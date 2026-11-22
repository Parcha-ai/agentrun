// The runner's learning end never learns what a run was handed of its agent's sign-in (runner/learning-end.ts
// learningEndOfRun's `refuse`): a run marked as handed its pointer (its row's sign_in_handed, the runner's bind at its
// claim), whose input, transcript, owner's correction and compile drafts all quote that pointer, ends and learns through
// a real runner, its end committing on the same runner. Neither the learning folder (every file, its snapshot) nor the
// run's kept learning (learning_proposals) holds the pointer, plain, JSON-escaped, URL-encoded or a slice of it; the clean
// draft the compile turn writes after its leaky one is still committed. A run whose mark can't be read back (a pointer
// that no longer opens here) learns nothing: its learning is dropped saying why, and nothing is merged. Fail closed: never
// a check over a shorter list. A draft and a correction that write the pointer's identifier uppercased and its dashes
// dropped are refused the same: nothing of it, however written, reaches the folder or the kept learning.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { openSqliteStore } from "../dist/store/index.js";
import { startRunner } from "../dist/runner/runner.js";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { mergesOf, repoOf } from "./learn-support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { seedOf } = await import("../dist/learning.js");
const { learningStoreOf } = await import("../dist/learn/store-of.js");
const { pointerHash, saveSignIn, signInsOverStore } = await import("../dist/sign-ins-store.js");
const { agentLearningFolder } = await import("../dist/workspace/index.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
const TIMING = { leaseMs: 60_000, renewEveryMs: 20_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const WAIT_MS = 30_000;
after(closeOpenSessions);

const KEY = randomBytes(32);
/** The agent's saved Browserbase sign-in: a context id with a slash in it, so its URL-encoded form differs. */
const POINTER = `ctx/${randomUUID()}`;
/** Every form of the pointer the scan looks for: as written, JSON-escaped, URL-encoded, and a slice of it. */
const FORMS = [...new Set([POINTER, JSON.stringify(POINTER).slice(1, -1), encodeURIComponent(POINTER), POINTER.slice(6, 26)])];
const holds = (text) => FORMS.filter((form) => text.includes(form));
/** The pointer's identifier as a text may write it to get past a check of its plain forms: uppercased, no dashes. */
const FOLDED = POINTER.slice(4).replaceAll("-", "").toUpperCase();
/** Whether `text` holds the pointer's identifier however written: in any case, its separators dropped. */
const holdsFolded = (text) => text.toLowerCase().replace(/[-_:.]/g, "").includes(FOLDED.toLowerCase());

/** A compile draft of workflow `answer` whose README description is `description` (the agent's one tool is `read`). */
const draft = (description) => `\`\`\`\`workflow answer\n---\ndescription: ${description}\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify({
  v: 2, name: "answer",
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "number" }, confidence: { type: "number" } }, required: ["answer", "confidence"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
})}\n\`\`\`\``;
const CLEAN = draft("Answers a question as a number; use when asked");
/** The owner's correction and the first draft's description, quoting `pointer` as written. */
const wordsOf = (pointer) => ({ feedback: `Open the browser on session ${pointer} before anything else.`, leaky: draft(`Opens session ${pointer} then answers; use when asked`) });

/** Writes run `runId`'s sign_in_handed as `mark` (JSON), on a connection of its own (no writer writes a malformed mark, so
 *  runs.update can't). The runner's store holds its write lock in this process (a claim poll, a renewal: a transaction its
 *  worker steps from this thread), so the write never busy-waits on this thread: a synchronous busy wait blocked the very
 *  thread that steps the transaction to its commit, so it waited its whole timeout, the claim failed, and the run waited
 *  out its lease past the test's wait (CI: "not within 30000 ms: run-1 ended"). Each try waits for nothing; a held lock
 *  yields to the event loop, which lets the transaction commit, and tries again. */
async function writeMark(file, runId, mark) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const db = new DatabaseSync(file, { timeout: 0 });
    try {
      db.prepare("UPDATE runs SET sign_in_handed = ? WHERE id = ?").run(JSON.stringify(mark), runId);
      return;
    } catch (error) {
      if (!/database is locked|SQLITE_BUSY/i.test(String(error?.message)) || Date.now() > deadline) throw error;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A store in a directory of its own; agent-1 learns, due to compile at every run, and has a saved Browserbase sign-in;
 *  run-1 starts from its seed on a Browserbase plane, its input quoting the pointer, its owner's feedback (queued before
 *  the claim) quoting `pointer`. The runner runs run-1 on the adapter loop (bound to the pointer whose hash is `handed` at
 *  its claim, as the runner's bind writes it; or, with `mark`, its row's sign_in_handed set to that value as written,
 *  which no writer writes) with the learning end over the store's sign-ins (and `stored`, the server's sealed secrets as
 *  the learning end reads them, when given). The compile turn writes a draft quoting `pointer`, then a clean one. */
async function world(t, { handed, mark, pointer = POINTER, stored }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-learning-custody-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const runners = [];
  const stores = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: { compile_after: 1 } } });
  await saveSignIn(server, KEY, { agentId: "agent-1", provider: "browserbase", pointer: POINTER });
  const seed = await seedOf(dir, "agent-1");
  const launch = { input: { content: `Log in with the session ${POINTER}.` }, title: "t", place: { mode: "runner" }, plane: { browser: "browserbase" }, learning: { seed: seed.sha, section: "" } };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  const words = wordsOf(pointer);
  await sendCommand(server, "run-1", { kind: "steer", body: { text: words.feedback } });

  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  stores.push(store);
  const script = piAdapterSpec({ script: [{ say: `Logged in on ${POINTER}.` }, { say: `Noted: ${pointer}.` }, { say: words.leaky }, { say: CLEAN }], tools: {}, hooks: quiet });
  const spec = async (claim, run) => {
    if (mark === undefined) await store.runs.update(claim, { signInHanded: [handed] });
    else await writeMark(join(dir, "store.sqlite"), claim.runId, mark);
    return { ...(await script(claim, run)), agentId: "agent-1", input: launch.input.content };
  };
  const signIns = signInsOverStore(store, KEY, { remove: async () => {} });
  const endOfRun = learningEndOfRun(launch, { store, data: dir, env: {}, learningStore: (agentId) => learningStoreOf(dir, agentId), signIns, ...(stored ? { stored } : {}) });
  runners.push(startRunner({ store, createLoop: (deps) => createAdapterLoop(spec)({ ...deps, endOfRun }), name: "runner-a", ...TIMING }));

  /** Run-1 ended: its kept learning. */
  const learned = async () => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const row = await server.runs.get("run-1");
      if (row.state === "ended" && row.runner === null) break;
      if (Date.now() > deadline) throw new Error(`not within ${WAIT_MS} ms: run-1 ended`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return server.learning.proposal("run-1");
  };
  return { dir, server, learned, merges: () => mergesOf(repoOf(dir, "agent-1"), "run-1") };
}

/** Every file of the agent's learning folder but git's own (its working tree, `.agentrun/snapshot.json`), by path, as
 *  text. */
function folderFiles(dir) {
  const root = agentLearningFolder(dir, "agent-1");
  const files = {};
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      if (name === ".git") continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[path] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return files;
}

test("a run handed its sign-in pointer, quoting it in its input, its transcript, its owner's correction and a draft, learns nothing that holds it: its clean draft is committed, the rest refused", { timeout: 120_000 }, async (t) => {
  const w = await world(t, { handed: pointerHash(POINTER) });
  const kept = await w.learned();
  assert.ok(kept, "the run kept its learning");
  assert.deepEqual([kept.proposal?.state, kept.proposal?.workflows], ["merged", [{ file: "workflows/answer/workflow.json", name: "answer" }]], JSON.stringify(kept.proposal));
  assert.notEqual(kept.proposal.corrections, 1, "the correction quoting the pointer is refused");
  assert.deepEqual(kept.proposal.compiled?.attempts?.map(({ ok }) => ok), [false, true], "the leaky draft is refused, the clean one passes");
  assert.equal(w.merges().length, 1, "one merge on main, by the run");
  assert.deepEqual(holds(JSON.stringify(kept)), [], `its kept learning holds the pointer: ${JSON.stringify(kept).slice(0, 600)}`);
  const files = folderFiles(w.dir);
  assert.ok(Object.keys(files).some((path) => path.endsWith("snapshot.json")), `the folder's snapshot is scanned: ${Object.keys(files).join(", ")}`);
  assert.ok(Object.keys(files).some((path) => path.endsWith("workflows/answer/workflow.json")), "the clean draft is in the folder");
  for (const [path, text] of Object.entries(files)) assert.deepEqual(holds(text), [], `${path} holds the pointer`);
});

test("a run whose handed mark can't be read back here learns nothing: its learning is dropped saying why, and nothing is merged", { timeout: 120_000 }, async (t) => {
  // Handed a pointer whose hash matches no sign-in this store opens: what it was handed can't be known.
  const w = await world(t, { handed: pointerHash(`ctx/${randomUUID()}`) });
  const kept = await w.learned();
  assert.ok(kept, "the run kept its learning's end");
  assert.equal(kept.proposal?.state, "dropped", JSON.stringify(kept.proposal));
  assert.equal(kept.proposal?.reason, "reflect_failed", JSON.stringify(kept.proposal));
  assert.match(kept.proposal?.detail ?? "", /sign-in/, "the drop says why: what the run was handed of its sign-in");
  assert.deepEqual(w.merges(), [], "nothing merged");
  assert.deepEqual(holds(JSON.stringify(kept)), [], "its kept learning holds no pointer");
  for (const [path, text] of Object.entries(folderFiles(w.dir))) assert.deepEqual(holds(text), [], `${path} holds the pointer`);
});

// A mark no writer writes (main's handedMark: anything but a non-empty array of SHA-256 hashes) can't say what the run
// was handed: the run learns nothing, as for a mark that can't be read back.
for (const [what, markOf] of [["a legacy true", () => true], ["an object", (hash) => ({ hash })], ["the empty array", () => []], ["an array with a non-hash entry", (hash) => [hash, "not a hash"]]]) {
  test(`a run whose sign_in_handed is ${what} learns nothing: dropped saying why, nothing merged, no pointer kept`, { timeout: 120_000 }, async (t) => {
    const w = await world(t, { mark: markOf(pointerHash(POINTER)) });
    const kept = await w.learned();
    assert.ok(kept, "the run kept its learning's end");
    assert.deepEqual([kept.proposal?.state, kept.proposal?.reason], ["dropped", "reflect_failed"], JSON.stringify(kept.proposal));
    assert.match(kept.proposal?.detail ?? "", /sign-in/, "the drop says why");
    assert.deepEqual(w.merges(), [], "nothing merged");
    assert.deepEqual(holds(JSON.stringify(kept)), [], "its kept learning holds no pointer");
    for (const [path, text] of Object.entries(folderFiles(w.dir))) assert.deepEqual(holds(text), [], `${path} holds the pointer`);
  });
}

test("a run handed its sign-in pointer whose correction and draft write it uppercased and without its dashes learns nothing that holds it, however written", { timeout: 120_000 }, async (t) => {
  const words = wordsOf(FOLDED);
  assert.ok(!words.leaky.includes(POINTER) && words.leaky.includes(FOLDED), "the draft writes the pointer's identifier folded");
  const w = await world(t, { handed: pointerHash(POINTER), pointer: FOLDED });
  const kept = await w.learned();
  assert.ok(kept, "the run kept its learning");
  assert.deepEqual(kept.proposal.compiled?.attempts?.map(({ ok }) => ok), [false, true], "the folded draft is refused, the clean one passes");
  assert.equal(holdsFolded(JSON.stringify(kept)), false, `its kept learning holds the pointer: ${JSON.stringify(kept).slice(0, 600)}`);
  const files = folderFiles(w.dir);
  assert.ok(Object.keys(files).some((path) => path.endsWith("snapshot.json")), "the folder's snapshot is scanned");
  for (const [path, text] of Object.entries(files)) assert.equal(holdsFolded(text), false, `${path} holds the pointer`);
});

test("a run whose server secrets can't be read learns nothing: its learning is dropped saying why, and nothing is merged", { timeout: 120_000 }, async (t) => {
  // Its sign-in reads back; the server's sealed secrets do not (the store's read throws): never a check over a shorter list.
  const w = await world(t, { handed: pointerHash(POINTER), stored: async () => { throw new Error("the store is gone"); } });
  const kept = await w.learned();
  assert.ok(kept, "the run kept its learning's end");
  assert.deepEqual([kept.proposal?.state, kept.proposal?.reason], ["dropped", "reflect_failed"], JSON.stringify(kept.proposal));
  assert.match(kept.proposal?.detail ?? "", /server's secrets/, "the drop says why");
  assert.deepEqual(w.merges(), [], "nothing merged");
  assert.deepEqual(holds(JSON.stringify(kept)), [], "its kept learning holds no pointer");
});
