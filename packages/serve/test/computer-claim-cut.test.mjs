// A run's computer calls end with its claim (computer-calls.ts claimCutClient, run-tools.ts claimCut): the claim's signal
// (aborted on a lost claim, or by the runner's shutdown once its drain is over) cuts a computerd call in flight and
// refuses one made after it, so a run whose computer never answers ends with its loop and the runner's close goes on at
// once. From the run's end on (RunTools.end: its background processes ended, its scratch swept through the computer) no
// call is cut by it, so the end keeps the close's window. The client here is the computer package's own DaemonClient
// over a stream that never answers: the hang and the cut are the real client's.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DaemonClient, readBackOf } from "@parcha/agentrun-computer";
import { claimCutClient } from "../dist/computer-calls.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { runHands } from "../dist/workspace/run-tools.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** A daemon client whose daemon reads every request and answers none. */
const silent = () => new DaemonClient({ readable: new PassThrough(), writable: new PassThrough().resume() });

/** "pending" when `promise` has not settled within `ms`, else what it settled with. */
const within = (promise, ms) => Promise.race([promise.then((value) => ({ value }), (error) => ({ error })), new Promise((resolve) => setTimeout(() => resolve("pending"), ms).unref())]);

test("claimCutClient: a call in flight when the claim's signal aborts ends then, aborted; one made after it is refused before it is sent", async () => {
  const claim = new AbortController();
  const { client } = claimCutClient(silent(), claim.signal);
  const going = client.call("files.stat", { path: "/workspace/.agentrun/tmp", follow: false });
  assert.equal(await within(going, 100), "pending", "the daemon never answers");
  claim.abort(new Error("the runner is closing"));
  const cut = await within(going, 1_000);
  assert.notEqual(cut, "pending", "cut by the claim's abort");
  assert.equal(cut.value.ok, false);
  assert.equal(cut.value.error.code, "aborted");
  const later = await within(client.call("files.stat", { path: "/workspace", follow: false }), 1_000);
  assert.notEqual(later, "pending", "refused at once");
  assert.equal(later.value.error.code, "aborted");
});

test("claimCutClient: the call's own signal still cuts it, beside the claim's", async () => {
  const claim = new AbortController();
  const own = new AbortController();
  const { client } = claimCutClient(silent(), claim.signal);
  const going = client.call("files.stat", { path: "/workspace", follow: false }, { signal: own.signal });
  own.abort();
  const cut = await within(going, 1_000);
  assert.notEqual(cut, "pending");
  assert.equal(cut.value.error.code, "aborted");
  assert.equal(claim.signal.aborted, false, "the claim goes on");
});

test("claimCutClient: each call gets a signal of its own, so nothing that listens for one (the run channel's stand-in) piles up on the claim's", async () => {
  const claim = new AbortController();
  const handed = [];
  const recording = { call: async (_method, _params, options) => (handed.push(options?.signal), { ok: true, value: {} }), close: () => {} };
  const { client } = claimCutClient(recording, claim.signal);
  for (let i = 0; i < 20; i++) await client.call("files.stat", { path: "/workspace", follow: false });
  assert.equal(new Set(handed).size, 20, "one signal per call");
  assert.ok(handed.every((signal) => signal instanceof AbortSignal && signal !== claim.signal && !signal.aborted));
  claim.abort(new Error("the runner is closing"));
  assert.ok(handed.every((signal) => signal.aborted), "each is cut with the claim");
});

test("claimCutClient: from release() on (the run's end), the claim's abort cuts nothing, a call in flight included", async () => {
  const claim = new AbortController();
  const cut = claimCutClient(silent(), claim.signal);
  const before = cut.client.call("files.remove", { path: "/workspace/.agentrun/tmp", recursive: true, force: true });
  cut.release();
  const after = cut.client.call("files.remove", { path: "/workspace/.agentrun/output", recursive: true, force: true });
  claim.abort(new Error("the runner is closing"));
  assert.equal(await within(before, 200), "pending", "the end's call in flight keeps going: the close's window bounds it");
  assert.equal(await within(after, 200), "pending", "and one made in the end too");
});

test("a run's hands on a sandbox whose daemon never answers: the start ends once the claim's signal aborts, in words, never held for good", async () => {
  const root = join(realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-claim-cut-"))), "work");
  dirs.push(join(root, ".."));
  mkdirSync(root);
  // The mount reads back as the run's folder (its attach's check passes); every computerd call hangs.
  const computer = { id: "box-1", client: silent(), readBack: async () => ({ ok: true, value: { kind: "bind", path: root } }) };
  const claim = new AbortController();
  const starting = runHands(localWorkspace(root), { kind: "sandbox", computer, check: { readBackOf } }, { mode: 1, context, signal: claim.signal });
  assert.equal(await within(starting, 200), "pending", "its scratch folder's call waits on the daemon");
  claim.abort(new Error("the runner is closing"));
  const ended = await within(starting, 2_000);
  assert.notEqual(ended, "pending", "the claim's abort ends the start");
  assert.ok(ended.error, `it failed: ${JSON.stringify(ended)}`);
  assert.match(ended.error.message, /aborted/);
});
