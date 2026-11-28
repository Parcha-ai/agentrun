// A run's end after its claim was lost (spec-holds.ts SpecHolds, run-tools.ts RunTools.end): the run's folder may be a
// later claim's by then, so the end sweeps the run's scratch only while the runner's fence on the claim says it still
// holds (LoopDeps.stillHolds, held as SpecHolds' `stillHolds`). A later claim of the run opens the same folder (Mode 1:
// the run's folder on this server, bound into each claim's new sandbox; Mode 2: the run's key on the server's Archil
// disk) and writes its scratch at the same paths (.agentrun/tmp, .agentrun/output), so a lost claim's sweep would delete
// the later claim's TMPDIR and bash outputs while it runs; that claim's own end sweeps what both left. The fence decides,
// never the claim signal's reason: a shutdown aborts it first, and a claim lost after that keeps the shutdown's reason.
// A fence not given or one that throws sweeps nothing. Background processes are ended either way, and the fence is asked
// only after they are (their TERM, KILL 3 s later), so a claim lost during that wait is seen.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { ClaimLost } from "../dist/runner/runner.js";
import { SpecHolds } from "../dist/runner/spec-holds.js";
import { localWorkspace, runTools } from "../dist/workspace/index.js";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-lost-claim-")));
  dirs.push(dir);
  const root = join(dir, "work");
  mkdirSync(root);
  return root;
}
const call = (tools, name, args) => tools.find((tool) => tool.name === name).call(args, { callId: `c-${name}-${Math.random()}`, signal: new AbortController().signal });
const SCRATCH = [".agentrun/tmp/later.txt", ".agentrun/output/later-call"];

/** A run's scratch, written through its own tools: a file in its TMPDIR and one of bash's full outputs. What of it is
 *  still there, as a function. */
async function scratchIn(run, root) {
  const tools = run.hostTools(["write"]);
  for (const path of SCRATCH) {
    const wrote = await call(tools, "write", { path, content: "scratch" });
    assert.notEqual(wrote.isError, true, wrote.text);
  }
  const kept = () => SCRATCH.filter((path) => existsSync(join(root, path)));
  assert.deepEqual(kept(), SCRATCH);
  return kept;
}

/** The run's spec released as the loop lets it go: its tools held, with the runner's fence when one is given. What the
 *  release logged. */
async function released(run, fence) {
  const holds = new SpecHolds();
  const said = [];
  holds.logTo((line) => said.push(line));
  holds.hold({ tools: { end: (options) => run.end(options) }, ...(fence ? { stillHolds: fence } : {}) });
  await holds.release();
  return said;
}

/** Two claims of one run on one folder: the first's tools, then the second's with its scratch written. */
async function twoClaims(root, first, second = { mode: 2 }) {
  const signal = new AbortController();
  const lost = await runTools(localWorkspace(root), first.computer, { mode: first.mode, context: ctx, signal: signal.signal });
  const later = await runTools(localWorkspace(root), second.computer, { mode: second.mode, context: ctx, signal: new AbortController().signal });
  return { signal, lost, later, kept: await scratchIn(later, root) };
}

test("Mode 2, no computer: a lost claim's end leaves the later claim's scratch in the run's folder; the later claim's end sweeps it", async () => {
  const root = scratch();
  const { signal, lost, later, kept } = await twoClaims(root, { mode: 2 });
  signal.abort(new ClaimLost("run r1: claim lost (fenced)"));
  await released(lost, () => false);
  assert.deepEqual(kept(), SCRATCH, "the lost claim's end swept the later claim's scratch");
  await released(later, () => true);
  assert.deepEqual(kept(), [], "the later claim's own end sweeps it");
  assert.ok(!existsSync(join(root, ".agentrun", "tmp")));
});

test("Mode 1, a sandbox the later claim's start released: the lost claim's end does not fall back to the run's own folder, and still ends its background processes", async () => {
  const root = scratch();
  // The lost claim's sandbox, deleted by the later claim's releaseOlderClaims: its file calls fail; the later claim's new
  // sandbox binds the same folder. One background process of the lost claim's is still listed, until it is signalled.
  const gone = fakeComputer(root);
  let running = true;
  gone.overrides["process.list"] = () => ({ processes: [{ id: "p9", pid: 9, argv: ["bash", "-c", "sleep 99", "agentrun-background", "1", "sleep 99"], argvClipped: false, pty: false, running, exitCode: running ? null : 143, signal: running ? null : "TERM", startedAt: 1, endedAt: running ? null : 2 }], truncated: false, next: 1 });
  gone.overrides["process.signal"] = () => ((running = false), {});
  const sandbox = (computer) => ({ mode: 1, computer: { kind: "sandbox", computer, check: { readBackOf } } });
  const { signal, lost, later, kept } = await twoClaims(root, sandbox(gone), sandbox(fakeComputer(root)));
  gone.overrides["files.remove"] = { result: { ok: false, error: { code: "gone", message: "the computer is gone" } } };
  signal.abort(new ClaimLost("run r1: claim lost (not-renewed)"));
  await released(lost, () => false);
  assert.deepEqual(kept(), SCRATCH, "the lost claim's end swept the later claim's scratch");
  assert.ok(!gone.calls.some(([method]) => method === "files.remove"), "nor did it try to, through its own computer");
  assert.ok(gone.calls.some(([method, params]) => method === "process.signal" && params.signal === "TERM"), "its background process was ended");
  await released(later, () => true);
  assert.deepEqual(kept(), []);
});

test("Mode 1, a claim lost while its background processes are ending (the TERM's wait): the fence is asked after it, so nothing is swept", async () => {
  const root = scratch();
  // The lost claim's sandbox still answers, so a sweep through it would remove the later claim's scratch. Its renew is
  // answered Fenced while its background process is being ended: the fence turns lost inside the end.
  const live = fakeComputer(root);
  let running = true, held = true;
  live.overrides["process.list"] = () => ({ processes: [{ id: "p9", pid: 9, argv: ["bash", "-c", "sleep 99", "agentrun-background", "1", "sleep 99"], argvClipped: false, pty: false, running, exitCode: running ? null : 143, signal: running ? null : "TERM", startedAt: 1, endedAt: running ? null : 2 }], truncated: false, next: 1 });
  live.overrides["process.signal"] = () => ((held = false), (running = false), {});
  const sandbox = (computer) => ({ mode: 1, computer: { kind: "sandbox", computer, check: { readBackOf } } });
  const { lost, later, kept } = await twoClaims(root, sandbox(live), sandbox(fakeComputer(root)));
  await released(lost, () => held);
  assert.ok(live.calls.some(([method, params]) => method === "process.signal" && params.signal === "TERM"), "its background process was ended");
  assert.equal(held, false);
  assert.deepEqual(kept(), SCRATCH, "the end read the fence before its background processes ended, and swept the later claim's scratch");
  await released(later, () => true);
  assert.deepEqual(kept(), []);
});

test("a claim lost after a shutdown's abort: the signal still says the shutdown, the fence says lost, and nothing is swept", async () => {
  const root = scratch();
  const { signal, lost, kept } = await twoClaims(root, { mode: 2 });
  // The shutdown aborts first; its renew is answered Fenced during the close's stop, so the runner's fence is lost while
  // the signal keeps the shutdown's reason (an abort is once).
  signal.abort(new Error("the runner is closing"));
  await released(lost, () => false);
  assert.equal(signal.signal.reason.message, "the runner is closing");
  assert.deepEqual(kept(), SCRATCH, "the end swept the later claim's scratch");
});

test("a shutdown whose claim is still renewed: its end sweeps, the fence's answer awaited as the run's process gets it", async () => {
  const root = scratch();
  const closing = new AbortController();
  const run = await runTools(localWorkspace(root), undefined, { mode: 2, context: ctx, signal: closing.signal });
  const kept = await scratchIn(run, root);
  closing.abort(new Error("the runner is closing"));
  await released(run, async () => true);
  assert.deepEqual(kept(), [], "swept");
  assert.ok(!existsSync(join(root, ".agentrun", "tmp")));
});

test("a normal end, its claim held: swept", async () => {
  const root = scratch();
  const run = await runTools(localWorkspace(root), undefined, { mode: 2, context: ctx, signal: new AbortController().signal });
  const kept = await scratchIn(run, root);
  await released(run, () => true);
  assert.deepEqual(kept(), []);
});

test("a fence that throws, or none given: unknown is never held, so nothing is swept", async () => {
  for (const fence of [() => { throw new Error("the channel closed"); }, async () => { throw new Error("the channel closed"); }, undefined]) {
    const root = scratch();
    const run = await runTools(localWorkspace(root), undefined, { mode: 2, context: ctx, signal: new AbortController().signal });
    const kept = await scratchIn(run, root);
    const said = await released(run, fence);
    assert.deepEqual(kept(), SCRATCH, `swept with ${fence ? "a throwing fence" : "no fence"}`);
    if (fence) assert.ok(said.some((line) => /fence could not be read/.test(line)), `said: ${JSON.stringify(said)}`);
  }
});

test("RunTools.end's own `sweep`: only an answer of true sweeps; absent, false, not true, a throw or a rejection sweeps nothing", async () => {
  const left = [undefined, () => false, async () => false, () => "yes", () => 1, () => { throw new Error("the channel closed"); }, async () => { throw new Error("the channel closed"); }];
  for (const sweep of left) {
    const root = scratch();
    const run = await runTools(localWorkspace(root), undefined, { mode: 2, context: ctx, signal: new AbortController().signal });
    const kept = await scratchIn(run, root);
    await run.end(sweep === undefined ? undefined : { sweep });
    assert.deepEqual(kept(), SCRATCH, `swept with ${sweep ?? "no sweep"}`);
  }
  for (const sweep of [() => true, async () => true]) {
    const root = scratch();
    const run = await runTools(localWorkspace(root), undefined, { mode: 2, context: ctx, signal: new AbortController().signal });
    const kept = await scratchIn(run, root);
    await run.end({ sweep });
    assert.deepEqual(kept(), [], `kept with ${sweep}`);
  }
});
