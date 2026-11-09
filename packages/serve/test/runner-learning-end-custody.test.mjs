// The runner's learning end never learns what a run was handed of its agent's sign-in (runner/learning-end.ts, the
// server's learning-run.ts refused(run) moved): a run marked as handed its pointer (its row's sign_in_handed, the runner's
// bind at its claim), whose user words, transcript and end-of-run answer all quote that pointer, ends and learns
// through a real runner, its learning run graded and merged on the same runner. Neither the learning folder (every file,
// its snapshot and its diffs) nor the run's kept learning (learning_proposals: its turn and its proposal) holds the
// pointer, plain, JSON-escaped, URL-encoded or a slice of it. A run whose mark can't be read back (a pointer that no
// longer opens here) learns nothing: its learning is dropped saying why, and no learning run is queued. Fail closed:
// never a check over a shorter list.
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

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { learningLoopFactory } = await import("../dist/runner/learning-factory.js");
const { learningEndOfRun } = await import("../dist/runner/learning-end.js");
const { learningFolderOf, seedOf } = await import("../dist/learning.js");
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

/** The end-of-run turn's answer: one note that quotes the pointer, and one that doesn't. */
const LEAKY = `---\nname: Session to reuse\ndescription: Open the browser on the saved session\ntype: reference\n---\nOpen the browser on session ${POINTER} before anything else.\n`;
const CLEAN = "---\nname: Retry slowly\ndescription: Back off between retries\ntype: reference\n---\nWait a little longer after each failed call.\n";
const REFLECTED = `\`\`\`note session-to-reuse.md\n${LEAKY}\`\`\`\n\n\`\`\`note retry-slowly.md\n${CLEAN}\`\`\`\n\nReflected.`;
/** The grader keeps every item it is shown. */
const KEEP = JSON.stringify({ merge: true, reason: "Worth keeping.", items: [{ file: "session-to-reuse.md", decision: "keep", why: "useful" }, { file: "retry-slowly.md", decision: "keep", why: "useful" }] });

/** A store in a directory of its own; agent-1 learns and has a saved Browserbase sign-in; run-1 starts from its seed on
 *  a Browserbase plane, the person's words quoting the pointer. The runner runs run-1 on the adapter loop (bound to the
 *  pointer whose hash is `handed` at its claim, as the runner's bind writes it; or, with `mark`, its row's
 *  sign_in_handed set to that value as written, which no writer writes) with the learning end over the store's
 *  sign-ins, and any learning run it queues on the learning loop, whose grader keeps everything. */
async function world(t, { handed, mark }) {
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
  await server.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer.", tools: ["read"], learning: true } });
  await saveSignIn(server, KEY, { agentId: "agent-1", provider: "browserbase", pointer: POINTER });
  const seed = await seedOf(dir, "agent-1");
  const launch = { input: { content: `Log in with the session ${POINTER}.` }, title: "t", place: { mode: "runner" }, plane: { browser: "browserbase" }, learning: { given: [], seed: seed.sha, section: "", seedNotes: 0 } };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });

  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  stores.push(store);
  const script = piAdapterSpec({ script: [{ say: `Logged in on ${POINTER}.` }, { say: REFLECTED }], tools: {}, hooks: quiet });
  const spec = async (claim, run) => {
    if (mark === undefined) await store.runs.update(claim, { signInHanded: [handed] });
    else {
      const db = new DatabaseSync(join(dir, "store.sqlite"));
      db.prepare("UPDATE runs SET sign_in_handed = ? WHERE id = ?").run(JSON.stringify(mark), claim.runId);
      db.close();
    }
    return { ...(await script(claim, run)), agentId: "agent-1", input: launch.input.content };
  };
  const signIns = signInsOverStore(store, KEY, { remove: async () => {} });
  const endOfRun = learningEndOfRun(launch, { store, data: dir, env: {}, learningFolder: (agentId) => learningFolderOf(dir, agentId), signIns });
  const createLoop = (deps) => {
    const job = createAdapterLoop(spec)({ ...deps, endOfRun });
    const learn = learningLoopFactory({ store, data: dir, ask: async () => ({ text: KEEP, usd: 0 }) })(deps);
    return {
      start: (claim) => (claim.runId === "run-1" ? job.start(claim) : learn.start(claim)),
      command: (row) => job.command(row),
      stop: async (reason) => {
        await learn.stop?.(reason);
        return job.stop(reason);
      },
    };
  };
  runners.push(startRunner({ store, createLoop, name: "runner-a", ...TIMING }));

  const until = async (check, what) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const found = await check();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`not within ${WAIT_MS} ms: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** Run-1 ended, and its learning run too when it queued one: its kept learning. */
  const learned = async () => {
    await until(async () => {
      const row = await server.runs.get("run-1");
      return row.state === "ended" && row.runner === null;
    }, "run-1 ended");
    const kept = await server.learning.proposal("run-1");
    if (kept?.learningRunId) await until(async () => (await server.runs.get(kept.learningRunId))?.state === "ended", "its learning run ended");
    return kept;
  };
  return { dir, server, learned };
}

/** Every file of the agent's learning folder but git's own (its working tree, `.agentrun/snapshot.json`, its diffs), by
 *  path, as text. */
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

test("a run handed its sign-in pointer, quoting it in its words, its transcript and its end-of-run answer, learns nothing that holds it: not in the learning folder, not in its kept learning", { timeout: 120_000 }, async (t) => {
  const w = await world(t, { handed: pointerHash(POINTER) });
  const kept = await w.learned();
  assert.ok(kept, "the run kept its learning");
  assert.deepEqual(holds(JSON.stringify(kept)), [], `its kept learning (turn and proposal) holds the pointer: ${JSON.stringify(kept).slice(0, 600)}`);
  const files = folderFiles(w.dir);
  assert.ok(Object.keys(files).some((path) => path.endsWith("snapshot.json")), `the folder's snapshot is scanned: ${Object.keys(files).join(", ")}`);
  for (const [path, text] of Object.entries(files)) assert.deepEqual(holds(text), [], `${path} holds the pointer`);
});

test("a run whose handed mark can't be read back here learns nothing: its learning is dropped saying why, and no learning run is queued", { timeout: 120_000 }, async (t) => {
  // Handed a pointer whose hash matches no sign-in this store opens: what it was handed can't be known.
  const w = await world(t, { handed: pointerHash(`ctx/${randomUUID()}`) });
  const kept = await w.learned();
  assert.ok(kept, "the run kept its learning's end");
  assert.equal(kept.proposal?.state, "dropped", JSON.stringify(kept.proposal));
  assert.equal(kept.proposal?.reason, "propose_failed", JSON.stringify(kept.proposal));
  assert.match(kept.proposal?.detail ?? "", /sign-in/, "the drop says why: what the run was handed of its sign-in");
  assert.ok(!kept.learningRunId, "no learning run queued");
  assert.deepEqual(holds(JSON.stringify(kept)), [], "its kept learning holds no pointer");
  for (const [path, text] of Object.entries(folderFiles(w.dir))) assert.deepEqual(holds(text), [], `${path} holds the pointer`);
});

// A mark no writer writes (main's handedMark: anything but a non-empty array of SHA-256 hashes) can't say what the run
// was handed: the run learns nothing, as for a mark that can't be read back.
for (const [what, markOf] of [["a legacy true", () => true], ["an object", (hash) => ({ hash })], ["the empty array", () => []], ["an array with a non-hash entry", (hash) => [hash, "not a hash"]]]) {
  test(`a run whose sign_in_handed is ${what} learns nothing: dropped saying why, no learning run, no pointer kept`, { timeout: 120_000 }, async (t) => {
    const w = await world(t, { mark: markOf(pointerHash(POINTER)) });
    const kept = await w.learned();
    assert.ok(kept, "the run kept its learning's end");
    assert.deepEqual([kept.proposal?.state, kept.proposal?.reason], ["dropped", "propose_failed"], JSON.stringify(kept.proposal));
    assert.match(kept.proposal?.detail ?? "", /sign-in/, "the drop says why");
    assert.ok(!kept.learningRunId, "no learning run queued");
    assert.deepEqual(holds(JSON.stringify(kept)), [], "its kept learning holds no pointer");
    for (const [path, text] of Object.entries(folderFiles(w.dir))) assert.deepEqual(holds(text), [], `${path} holds the pointer`);
  });
}
