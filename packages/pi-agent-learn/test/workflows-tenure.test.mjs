// A live trial's tenure while runs are in flight, through the real curator: a run that saves a new revision and reports
// back before the runs that ran the trial does not retire the trial under them; a trial no run uses still yields once the
// runs that started before the saving one have reported; with no run in flight nothing is held.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { WorkflowStore } from "@parcha/agentrun-pi/workflows";
import { local, openRepo } from "@parcha/pi-git-remote";
import { collectWorkflows, curate, proposeLearning, readTrial, seedWorkflows, usesSettler, usesSource, workflowAdmitter, workflowsToTry } from "../dist/index.js";
import { agentRepo, scratch } from "./support.mjs";
import { runStoreWith, workDirWith, workflowDoc } from "./workflow-support.mjs";

const NAME = "sku-quote";
const CLEAN = { sku: "A-1", amount: 5 };
const ESCALATES = { sku: "A-1", amount: 500 };
const judge = async (params) => ({ answers: { [Object.keys(params.questions)[0]]: { type: "noul", noul: 0.02 } }, model: "fake", usage: null, cost_usd: 0 });
const empty = { snapshot: async () => ({ order: [], byCall: {} }) };

/**
 * A host that starts runs side by side: each is prepared from main when it starts (seeded with the workflows to try) and
 * reports back later, in the order a test says. The tenure reads where each run started and which are still in flight.
 */
async function host(t, { tenure = true, startedAt } = {}) {
  const root = await scratch();
  const { bare, repo } = await agentRepo(root);
  const curator = await openRepo({ dir: path.join(root, "curator"), remote: local(bare) });
  const started = new Map();
  const inFlight = new Set();
  let order = 0;
  // Two clean uses promote, whatever this build's default.
  const settleUses = usesSettler({ thresholds: { promoteAfter: 2 } });
  const admitWorkflow = workflowAdmitter(tenure ? { tenure: { started: (run) => startedAt?.(run) ?? started.get(run), inFlight: () => [...inFlight] } } : {});
  const start = async (id) => {
    const sha = await curator.resolve("main");
    started.set(id, { sha, order: order++ });
    inFlight.add(id);
    const { dir } = await workDirWith();
    await seedWorkflows({ repo: curator, sha, into: dir, workflows: await workflowsToTry({ repo: curator, sha }, CLEAN) });
    return { id, sha, dir };
  };
  /** The run proposes what it did: it ran its seeded revision on `input` (if any) and saved `save` (if any). */
  const propose = async (run, { input, save } = {}) => {
    const store = input ? await runStoreWith([{ key: `k-${run.id}`, workflow: (await new WorkflowStore(run.dir).load(NAME)).workflow, input }]) : undefined;
    const digest = save ? (await new WorkflowStore(run.dir).save(NAME, save)).digest : undefined;
    const workflows = save ? (await collectWorkflows({ repo: curator, workDir: run.dir, seedSha: run.sha })).records : undefined;
    const proposed = await proposeLearning({ repo: curator, runId: run.id, target: empty, ...(store ? { uses: usesSource({ store, workDir: run.dir, run: run.id }) } : {}), ...(workflows ? { workflows } : {}) });
    return { digest, proposed: proposed.status === "proposed" };
  };
  /** The run reports and curate takes it; it leaves `inFlight()` once that curate has returned. */
  const report = async (run, what) => {
    const { digest, proposed } = await propose(run, what);
    const curated = proposed ? (await curate({ repo: curator, judge, admitWorkflow, settleUses })).runs.find((r) => r.run === run.id) : undefined;
    inFlight.delete(run.id);
    return { digest, curated, trial: await readTrial(curator, NAME, "main") };
  };
  /** Several runs report and ONE curate takes them all (in branch-name order); `early` drops them from `inFlight()` when
   *  they report, before that curate, which breaks the host's contract. */
  const reportTogether = async (list, { early = false } = {}) => {
    const out = [];
    for (const [run, what] of list) {
      out.push(await propose(run, what));
      if (early) inFlight.delete(run.id);
    }
    const report = await curate({ repo: curator, judge, admitWorkflow, settleUses });
    for (const [run] of list) inFlight.delete(run.id);
    return { digests: out.map((o) => o.digest), report, trial: await readTrial(curator, NAME, "main") };
  };
  /** The run ends without a report (it crashed): no use is folded, and it leaves `inFlight()` unless `keep` says the host
   *  broke its contract. */
  const crash = (run, { keep = false } = {}) => { if (!keep) inFlight.delete(run.id); };
  return { start, report, reportTogether, crash, curator };
}
const statusOf = (trial, digest) => trial.revisions.find((r) => r.sha256 === digest)?.status;
const heldWhy = (curated) => (curated?.held ?? []).map((h) => h.reason).join(" | ");

test("12 runs in flight under a trial: saves that report first are held until the runs that ran it report, and the trial promotes", async (t) => {
  const h = await host(t);
  const before = await h.start("run-00"); // started before the trial exists: it never sees it
  const author = await h.start("run-01");
  const { digest: trial } = await h.report(author, { save: workflowDoc() });
  const runs = [];
  for (let i = 2; i <= 13; i += 1) runs.push(await h.start(`run-${String(i).padStart(2, "0")}`));
  const [r2, r3, r4, ...rest] = runs;

  // run-03 ran the trial, escalated and saved a fix; run-02, which started before it with the trial live, is in flight.
  const third = await h.report(r3, { input: ESCALATES, save: workflowDoc({ limit: 200 }) });
  assert.equal(statusOf(third.trial, third.digest), undefined, "the fix is not admitted");
  assert.match(heldWhy(third.curated), /keeps its tenure/);
  assert.equal(statusOf(third.trial, trial), "trial");
  // run-00 started before the trial was live: its save never replaces it.
  const old = await h.report(before, { save: workflowDoc({ limit: 300 }) });
  assert.equal(statusOf(old.trial, old.digest), undefined);
  assert.match(heldWhy(old.curated), /started before the live trial/);
  // The runs that ran the trial report back: their clean uses count, and the trial promotes.
  await h.report(r2, { input: CLEAN });
  const fourth = await h.report(r4, { input: CLEAN });
  assert.equal(statusOf(fourth.trial, trial), "active", "the trial promoted on the uses of the runs that ran it");
  // A champion is never held: the next save goes on trial over it, which stays restorable.
  const next = await h.report(rest[0], { input: CLEAN, save: workflowDoc({ limit: 400 }) });
  assert.deepEqual([statusOf(next.trial, trial), statusOf(next.trial, next.digest)], ["superseded", "trial"]);
  for (const run of rest.slice(1)) await h.report(run, { input: CLEAN });
}, { timeout: 300_000 });

test("a trial no run uses cannot keep its name: once the runs that started before the saving one report back, a new revision replaces it", async (t) => {
  const h = await host(t);
  const { digest: trial } = await h.report(await h.start("run-01"), { save: workflowDoc() });
  const [r2, r3, r4] = [await h.start("run-02"), await h.start("run-03"), await h.start("run-04")];
  const third = await h.report(r3, { save: workflowDoc({ limit: 200 }) });
  assert.match(heldWhy(third.curated), /keeps its tenure/, "run-02 started before it with the trial live and is in flight");
  await h.report(r2);
  const fourth = await h.report(r4, { save: workflowDoc({ limit: 300 }) });
  assert.deepEqual([statusOf(fourth.trial, trial), statusOf(fourth.trial, fourth.digest)], ["retired", "trial"], heldWhy(fourth.curated));
}, { timeout: 300_000 });

test("a run that ends without a report releases the hold at its end: a trial whose only earlier run in flight crashed yields to the next save", async (t) => {
  for (const keep of [false, true]) {
    const h = await host(t);
    const { digest: trial } = await h.report(await h.start("run-01"), { save: workflowDoc() });
    const [r2, r3, r4] = [await h.start("run-02"), await h.start("run-03"), await h.start("run-04")];
    assert.match(heldWhy((await h.report(r3, { save: workflowDoc({ limit: 200 }) })).curated), /keeps its tenure/, "run-02 is in flight");
    h.crash(r2, { keep });
    const fourth = await h.report(r4, { save: workflowDoc({ limit: 300 }) });
    if (!keep) {
      assert.deepEqual([statusOf(fourth.trial, trial), statusOf(fourth.trial, fourth.digest)], ["retired", "trial"], heldWhy(fourth.curated));
      assert.equal(fourth.trial.uses.length, 0, "the crashed run folded no use");
    } else {
      // The contract matters: a host that keeps a dead run in flight pins the hold.
      assert.match(heldWhy(fourth.curated), /keeps its tenure/);
    }
  }
}, { timeout: 300_000 });

test("runs that report together are curated by branch name: a run still queued for curation keeps the trial's tenure", async (t) => {
  for (const early of [false, true]) {
    const h = await host(t);
    const { digest: trial } = await h.report(await h.start("run-01"), { save: workflowDoc() });
    // run-b starts first and runs the trial cleanly; run-a starts after it and saves a fix; curate takes run-a first.
    const runB = await h.start("run-b");
    const runA = await h.start("run-a");
    const { digests: [, fix], report, trial: after } = await h.reportTogether([[runB, { input: CLEAN }], [runA, { save: workflowDoc({ limit: 200 }) }]], { early });
    assert.deepEqual(report.runs.map((r) => r.run), ["run-a", "run-b"], "curate takes them by branch name");
    if (!early) {
      assert.match(heldWhy(report.runs[0]), /keeps its tenure/);
      assert.deepEqual([statusOf(after, trial), statusOf(after, fix)], ["trial", undefined]);
      assert.equal(after.uses.filter((u) => u.sha256 === trial).length, 1, "run-b's clean use counted on the trial it ran");
    } else {
      // A host that drops reported runs before curate takes them loses the tenure: the fix retires the trial first.
      assert.deepEqual([statusOf(after, trial), statusOf(after, fix)], ["retired", "trial"]);
    }
  }
}, { timeout: 300_000 });

test("a history read that fails is no tenure decision: curate stops and the run is curated again later", async (t) => {
  let broken = true;
  const h = await host(t, { startedAt: (run) => (broken && run === "run-03" ? { sha: "f".repeat(40), order: 99 } : undefined) });
  await h.report(await h.start("run-01"), { save: workflowDoc() });
  await h.start("run-02");
  const r3 = await h.start("run-03");
  await assert.rejects(h.report(r3, { save: workflowDoc({ limit: 200 }) }));
  broken = false;
  const again = await curate({ repo: h.curator, judge, admitWorkflow: workflowAdmitter({ tenure: { started: () => undefined, inFlight: () => [] } }) });
  assert.deepEqual(again.runs.map((r) => r.run), ["run-03"], "the run was left for the next curate");
}, { timeout: 300_000 });

test("no lockout: a run in flight that started AFTER the saving run does not hold its save; that revision goes on trial", async (t) => {
  const h = await host(t);
  const { digest: trial } = await h.report(await h.start("run-01"), { save: workflowDoc() });
  const r2 = await h.start("run-02");
  await h.start("run-03"); // started after run-02, with the trial live, and still in flight
  const second = await h.report(r2, { input: ESCALATES, save: workflowDoc({ limit: 200 }) });
  assert.deepEqual([statusOf(second.trial, trial), statusOf(second.trial, second.digest)], ["retired", "trial"], heldWhy(second.curated));
}, { timeout: 300_000 });

test("a champion is never held: a run's save goes on trial over the champion while an earlier run is in flight, and the champion stays restorable", async (t) => {
  const h = await host(t);
  const { digest: champion } = await h.report(await h.start("run-01"), { save: workflowDoc() });
  await h.report(await h.start("run-02"), { input: CLEAN });
  const promoted = await h.report(await h.start("run-03"), { input: CLEAN });
  assert.equal(statusOf(promoted.trial, champion), "active", "the champion");
  await h.start("run-a"); // starts first and stays in flight
  const rB = await h.start("run-b");
  const saved = await h.report(rB, { input: CLEAN, save: workflowDoc({ limit: 200 }) });
  assert.deepEqual([statusOf(saved.trial, champion), statusOf(saved.trial, saved.digest)], ["superseded", "trial"], heldWhy(saved.curated));
}, { timeout: 300_000 });

test("with no run in flight nothing is held: a run that ran the trial and saved a fix replaces it, as without a tenure", async (t) => {
  for (const tenure of [true, false]) {
    const h = await host(t, { tenure });
    const { digest: trial } = await h.report(await h.start("run-01"), { save: workflowDoc() });
    const second = await h.report(await h.start("run-02"), { input: ESCALATES, save: workflowDoc({ limit: 200 }) });
    assert.deepEqual([statusOf(second.trial, trial), statusOf(second.trial, second.digest)], ["retired", "trial"], `tenure ${tenure}: ${heldWhy(second.curated)}`);
  }
}, { timeout: 300_000 });
