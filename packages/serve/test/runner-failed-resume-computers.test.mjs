// A run whose runner was lost mid-run, taken over by a later claim that ends before its computer starts (that claim never
// reaches its release of the earlier claims' computers: computer-for-claim.ts releaseOlderClaims): by the time the runner
// says the run ended, no computer of any of its claims is left running (workspace/run-end-computers.ts, through the
// runner's runEnded). Each way such a claim ends: its image fails, its computer is refused here, a person cancels it
// while it waits on its computer, it is refused before any loop (a harness this runner does not run), and it is lost
// again itself before a third claim fails the same way; and a Docker still not answering at the run's end, asked again
// until it does. Through the runner, its store and the spec builder pi really uses
// (adapter-run-spec.ts); the sandbox is a loopback stand-in for Docker's, and the model a script.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { runEndComputers } = await import("../dist/workspace/run-end-computers.js");
const { ARCHIL_API_KEY_ROW, saveArchilSettings } = await import("../dist/archil-settings.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { deleteKept, endKept, KEEP_MS, keepKept, keptKeyOf, keptTaken, readKept, takeKept } =await import("../dist/workspace/computer-kept.js");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
/** A lease short enough that a killed runner's claim runs out within the test. */
const TIMING = { leaseMs: 2_000, renewEveryMs: 400, stopMarginMs: 800, pollMs: 20, commandPollMs: 30, interruptBackoffMs: 20 };
after(closeOpenSessions);

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Docker's stand-in: the sandboxes it holds now, each made over the run's folder it binds and deleted at its release,
 *  listed by their labels. Each runner gets its own provider over them (`provider(prepare)`), whose image step is
 *  `prepare`'s: "ok", "fail" (its image can't be had), or "wait" (it waits until the claim's signal ends it). */
function sandboxes() {
  const held = new Map();
  const made = [];
  /** How many lists of a run's computers fail next, as a Docker that does not answer. */
  const down = { lists: 0 };
  /** Whether a release never answers, as a Docker delete that hangs (it takes no signal and has no timeout of its own). */
  const hung = { releases: false };
  let waiting = () => {};
  const waits = new Promise((resolve) => (waiting = resolve));
  const provider = (prepare = "ok") => ({
    id: "docker",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    async prepareImage({ signal } = {}) {
      if (prepare === "fail") return { ok: false, error: { code: "unavailable", message: "the image could not be had" } };
      if (prepare === "wait") {
        waiting();
        await new Promise((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", resolve, { once: true })));
        return { ok: false, error: { code: "aborted", message: "the image wait was cut" } };
      }
      return { ok: true, value: "agentrun/computer:prepared" };
    },
    async list(labels) {
      if (labels["agentrun.run"] !== undefined && down.lists > 0) {
        down.lists -= 1;
        return { ok: false, error: { code: "unreachable", message: "Docker did not answer" } };
      }
      const listed = [...held.values()].filter((one) => Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: listed.map((one) => ({ ref: one.ref, labels: one.labels, state: "running", network: "none" })) };
    },
    async create(spec) {
      const ref = { id: `c${made.length + 1}`, name: `c${made.length + 1}` };
      made.push({ id: ref.id, epoch: spec.labels["agentrun.epoch"] });
      held.set(ref.id, { ref, labels: spec.labels, computer: fakeComputer(spec.mount.path) });
      return { ok: true, value: ref };
    },
    async connect(ref) {
      return { ok: true, value: { client: held.get(ref.id).computer.client, hello: { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] }, close: async () => {} } };
    },
    async attach(ref) {
      const read = await held.get(ref.id).computer.readBack();
      return { ok: true, value: { ...ref, spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    async release(ref) {
      if (hung.releases) return await new Promise(() => {});
      held.delete(ref.id);
      return { ok: true, value: undefined };
    },
  });
  /** The run's sandboxes still held, as "<id>@<epoch>". */
  const left = () => [...held.values()].filter((one) => one.labels["agentrun.run"] === RUN).map((one) => `${one.ref.id}@${one.labels["agentrun.epoch"]}`);
  return { provider, made, held, left, waits, down, hung };
}

async function opened(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-failed-resume-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const stores = [server];
  const runners = [];
  /** The model requests left hanging by a killed runner: cut at the test's end. */
  const cuts = [];
  t.after(async () => {
    for (const cut of cuts) cut();
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores.reverse()) await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Box" }, { id: "rev-1", kind: "agentic", body: { instructions: "Work.", computer: { kind: "sandbox", provider: "docker" } } });
  const launch = { input: { content: "Work." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const docker = sandboxes();
  const ended = [];
  const logged = [];
  /** A runner named `name` on its own store connection: its model `fetch`, its provider's image step `prepare`, its
   *  computers' `hostWhy`, and `harness: false` for a runner that runs no pi. Its run's end lets go of the run's
   *  computers (runEndComputers) with the same computers its claims make them with, as the runner process composes it,
   *  bounded at `endMs` when given. */
  const start = async (name, { fetch = scriptedOrigin([{ say: "done" }]), prepare = "ok", hostWhy, harness = true, endMs } = {}) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const route = { model: "claude-sonnet-5.5", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch };
    const computerDeps = { kinds: KINDS, providers: { docker: () => docker.provider(prepare) }, spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }), check: { readBackOf }, ...(hostWhy ? { hostWhy: () => hostWhy } : {}) };
    const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps };
    const createLoop = createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (given, body) => (harness && given === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(body, run, deps, claim)) : undefined) });
    const runner = startRunner({
      store, name, ...TIMING, createLoop,
      runEnded: runEndComputers({ store, computers: computerDeps, log: (line) => logged.push(line), retryMs: 50, ...(endMs ? { timeoutMs: endMs } : {}) }),
      onEvent: (event) => {
        // What the run's computers are when the runner says the run ended.
        if (event.type === "ended") ended.push({ status: event.status, left: docker.left() });
      },
    });
    runners.push(runner);
    return runner;
  };
  /** Runner a takes the run and makes its sandbox (epoch 1); with its model request in flight, it is killed: nothing of
   *  its claim is stopped or let go, so its sandbox runs on, as a lost runner's does. */
  const lose = async () => {
    let inFlight;
    const asked = new Promise((resolve) => (inFlight = resolve));
    const hanging = async (_url, init = {}) => {
      inFlight();
      return await new Promise((_resolve, reject) => {
        const cut = () => reject(Object.assign(new Error("the runner is gone"), { name: "AbortError" }));
        cuts.push(cut);
        init.signal?.addEventListener("abort", cut, { once: true });
      });
    };
    const first = await start("runner-a", { fetch: hanging });
    await asked;
    assert.deepEqual(docker.left(), ["c1@1"], "runner a's claim made its sandbox");
    first.kill();
    return first;
  };
  /** Until the runner says the run ended: its status, and the run's sandboxes then. */
  const theEnd = () => until(() => ended[0], "the runner says the run ended");
  return { server, docker, start, lose, theEnd, logged };
}

test("a resumed claim whose image fails (its computer never started): the lost runner's sandbox is let go by the time the run is over", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  await run.lose();
  await run.start("runner-b", { prepare: "fail" });
  const end = await run.theEnd();
  assert.equal(end.status, "failed");
  assert.deepEqual(run.docker.made.map((one) => one.epoch), ["1"], "the later claim made none");
  assert.deepEqual(end.left, [], "no sandbox of the run is left when its end is said");
  assert.ok(run.logged.some((line) => line.includes("an earlier claim left on docker, c1")), `said: ${JSON.stringify(run.logged)}`);
  // Its interval, in the store: opened by runner a's claim, ended by the run's end's delete (computer-intervals.ts).
  const [interval, ...more] = await run.server.computerIntervals.forRun(RUN);
  assert.deepEqual(more, []);
  assert.deepEqual([interval.provider, interval.providerId, interval.kind, interval.kept], ["docker", "c1", "sandbox", false]);
  assert.ok(interval.endedAt !== null && interval.endedAt >= interval.startedAt, `ended once its delete answered ok: ${JSON.stringify(interval)}`);
});

test("a resumed claim whose computer is refused here (computer_unavailable, before anything is made): the lost runner's sandbox is let go", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  await run.lose();
  await run.start("runner-b", { hostWhy: "docker is not on this runner's PATH" });
  const end = await run.theEnd();
  assert.equal(end.status, "failed");
  const row = await run.server.runs.get(RUN);
  assert.match(String(row.summary), /docker is not on this runner's PATH/);
  assert.deepEqual(end.left, []);
});

test("a person's cancel while the resumed claim waits on its computer's image: the run ends cancelled and the lost runner's sandbox is let go", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  await run.lose();
  await run.start("runner-b", { prepare: "wait" });
  await run.docker.waits;
  await sendCommand(run.server, RUN, { kind: "cancel", body: {} });
  const end = await run.theEnd();
  assert.equal(end.status, "cancelled");
  assert.deepEqual(run.docker.made.map((one) => one.epoch), ["1"], "the later claim made none");
  assert.deepEqual(end.left, []);
});

test("a resumed claim refused before any loop starts (a harness its runner does not run): the lost runner's sandbox is let go", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  await run.lose();
  await run.start("runner-b", { harness: false });
  const end = await run.theEnd();
  assert.equal(end.status, "failed");
  assert.deepEqual(end.left, []);
});

test("the resumed claim lost again while it waits on its image, and a third claim's image fails: neither earlier claim's sandbox is left", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  await run.lose();
  const second = await run.start("runner-b", { prepare: "wait" });
  await run.docker.waits;
  second.kill();
  await run.start("runner-c", { prepare: "fail" });
  const end = await run.theEnd();
  assert.equal(end.status, "failed");
  assert.deepEqual(run.docker.made.map((one) => one.epoch), ["1"]);
  assert.deepEqual(end.left, []);
});

test("the Docker that failed the resumed claim still does not answer at the run's end: it is asked again, and the lost runner's sandbox is let go once it does", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  await run.lose();
  run.docker.down.lists = 2;
  await run.start("runner-b", { prepare: "fail" });
  const end = await run.theEnd();
  assert.equal(end.status, "failed");
  assert.equal(run.docker.down.lists, 0, "both failed lists were asked");
  assert.deepEqual(end.left, []);
  assert.ok(run.logged.some((line) => line.includes("an earlier claim left on docker, c1")), `said: ${JSON.stringify(run.logged)}`);
  assert.ok(!run.logged.some((line) => line.includes("could not be let go")), `said: ${JSON.stringify(run.logged)}`);
});

test("a release that never answers at the run's end (a hung Docker delete takes no signal): the run's end is answered at its bound, said in the log, and the runner says the run ended", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  await run.lose();
  run.docker.hung.releases = true;
  await run.start("runner-b", { prepare: "fail", endMs: 300 });
  const end = await run.theEnd();
  assert.equal(end.status, "failed");
  assert.deepEqual(end.left, ["c1@1"], "the hung delete never finished");
  assert.ok(run.logged.some((line) => line.includes("could not be let go") && line.includes("asked until its bound")), `said: ${JSON.stringify(run.logged)}`);
  assert.equal(run.logged.length, 1, `said once: ${JSON.stringify(run.logged)}`);
});

test("a stopped run's end on another runner deletes a dial machine kept by a live runner with the rest: the run is over, so the machine has no user, and the keeper's own end then finds it gone", { timeout: 60_000 }, async (t) => {
  const run = await opened(t);
  // The vendor's list, as a dial vendor's: every runner's provider lists the same machines by the run's label. c1 is an
  // earlier lost claim's (epoch 1); c2 is the one runner-a's park kept (epoch 2), its row pinned to runner-a, still there.
  const machine = (id, epoch) => run.docker.held.set(id, { ref: { id, name: id }, labels: { "agentrun.run": RUN, "agentrun.epoch": String(epoch) } });
  machine("c1", 1);
  machine("c2", 2);
  assert.equal(await run.server.runners.put({ runner: "runner-a", incarnation: "inc-a", refused: null }), true, "runner-a is there");
  const kept = { provider: "docker", kind: "sandbox", id: "c2", name: "c2", epoch: 2, until: Date.now() + KEEP_MS, runner: "runner-a", incarnation: "inc-a" };
  await run.server.settings.put(keptKeyOf(RUN), kept);
  const logged = [];
  const computers = { kinds: KINDS, providers: { docker: () => run.docker.provider() } };
  // Another runner's claim (epoch 3) ended the run (a person's stop, so the run is final): its end lets go of both.
  await runEndComputers({ store: run.server, computers, log: (line) => logged.push(line), retryMs: 50 })({ runId: RUN, epoch: 3 });
  assert.deepEqual(run.docker.left(), [], "the stopped run's machine kept by runner-a is deleted with the earlier claim's");
  assert.deepEqual(logged, [`run ${RUN} is over: let go of the computers an earlier claim left on docker, c1, c2`]);
  assert.equal(await readKept(run.server.settings, RUN), undefined, "the run's end marked the row ended once its delete took the machine, and then removed it: the run is over");
  // runner-a's own end at the keep's time finds its row gone: it deletes nothing, and writes no row.
  const deleted = [];
  const ended = await endKept(run.server.settings, RUN, kept, async () => void deleted.push(kept.id));
  assert.equal(ended, false, "runner-a's end finds its row ended by the run's end");
  assert.deepEqual(deleted, [], "and asks no delete");
  assert.equal(await readKept(run.server.settings, RUN), undefined);
});

test("a stopped run's end marks its kept row ending before it deletes the machine, whichever runner kept it or claim is taking it back, so a follow-up that queues the run again never takes that machine back mid-delete", { timeout: 60_000 }, async (t) => {
  const run = await opened(t);
  assert.equal(await run.server.runners.put({ runner: "runner-a", incarnation: "inc-a", refused: null }), true, "runner-a is there");
  const kept = { provider: "docker", kind: "sandbox", id: "c2", name: "c2", epoch: 2, until: Date.now() + KEEP_MS, runner: "runner-a", incarnation: "inc-a" };
  const computers = { kinds: KINDS, providers: { docker: () => run.docker.provider() } };
  for (const row of [kept, { ...kept, taking: 3 }]) {
    run.docker.held.set("c2", { ref: { id: "c2", name: "c2" }, labels: { "agentrun.run": RUN, "agentrun.epoch": "2" } });
    await run.server.settings.put(keptKeyOf(RUN), row);
    /** The row as the run's end's delete finds it. */
    let atDelete;
    const listed = run.docker.provider;
    run.docker.provider = (...args) => {
      const provider = listed(...args);
      return { ...provider, release: async (...rest) => ((atDelete ??= await readKept(run.server.settings, RUN)), provider.release(...rest)) };
    };
    await runEndComputers({ store: run.server, computers, log: () => {}, retryMs: 50 })({ runId: RUN, epoch: 3 });
    run.docker.provider = listed;
    assert.deepEqual(atDelete, { ...kept, ending: true }, `the run is final: ${JSON.stringify(row)} reads ending before the delete, so no claim takes its machine back`);
    assert.equal(await readKept(run.server.settings, RUN), undefined, "and ended once the delete took it, then removed with the run's end");
    assert.deepEqual(run.docker.left(), [], "and the machine is deleted");
  }
});

test("a stopped run that a follow-up queues again within the keep's time keeps the follow-up's new machine at its park: the stop's end marks the kept row ended once its delete took that machine, so the park writes its own keep instead of deleting its machine; a kept machine the end's list never showed stays ending for its keeper", { timeout: 60_000 }, async (t) => {
  const run = await opened(t);
  const computers = { kinds: KINDS, providers: { docker: () => run.docker.provider() } };
  const kept = { provider: "docker", kind: "sandbox", id: "c2", name: "c2", epoch: 2, until: Date.now() + KEEP_MS };
  run.docker.held.set("c2", { ref: { id: "c2", name: "c2" }, labels: { "agentrun.run": RUN, "agentrun.epoch": "2" } });
  await run.server.settings.put(keptKeyOf(RUN), kept);
  // A person's stop: the claim at epoch 3 ends the run, and its end deletes the kept machine.
  await runEndComputers({ store: run.server, computers, log: () => {}, retryMs: 50 })({ runId: RUN, epoch: 3 });
  assert.deepEqual(run.docker.left(), [], "the stop's end deleted the kept machine");
  const afterStop = await readKept(run.server.settings, RUN);
  // The follow-up's claim (epoch 4) made c3 and parks it within the old keep's time: the park's write.
  const next = { provider: "docker", kind: "sandbox", id: "c3", name: "c3", epoch: 4, until: Date.now() + KEEP_MS };
  assert.deepEqual(await keepKept(run.server.settings, RUN, next, {}), next, `the follow-up's park keeps its new machine over the stop's row ${JSON.stringify(afterStop)}`);
  assert.deepEqual(await readKept(run.server.settings, RUN), next);
  assert.equal(afterStop, undefined, "the stop's end marked its row ended, then removed it");

  // A machine kept on runner-a's own engine, which this end's list does not show: never deleted here, so its row stays
  // ending for runner-a's end at its time, which deletes it.
  const pinned = { ...kept, id: "c8", name: "c8", runner: "runner-a", incarnation: "inc-a" };
  await run.server.settings.put(keptKeyOf(RUN), pinned);
  await runEndComputers({ store: run.server, computers, log: () => {}, retryMs: 50 })({ runId: RUN, epoch: 5 });
  assert.deepEqual(await readKept(run.server.settings, RUN), { ...pinned, ending: true }, "a machine this end did not delete keeps its row ending");
});

test("a run's end whose delete takes the kept machine but not another marks the kept row ended at that machine's own delete, so a follow-up's park keeps its new machine; a kept machine its vendor says is gone, or that a later try's list no longer shows, ends its row the same way", { timeout: 60_000 }, async (t) => {
  const run = await opened(t);
  const computers = { kinds: KINDS, providers: { docker: () => run.docker.provider() } };
  const kept = { provider: "docker", kind: "sandbox", id: "c2", name: "c2", epoch: 2, until: Date.now() + KEEP_MS };
  // How each machine's delete answers: "ok"; "fail", the vendor refuses it on every try; "gone", the vendor ended it
  // already (not_found, and its list no longer shows it); "stale", not_found while its list still shows it, so no later
  // list proves it gone and the end asks until its bound; "lost", deleted, but the answer never came back (an error).
  const cases = [
    { answers: { c1: "fail", c2: "ok" }, left: ["c1@1"], failed: true },
    { answers: { c1: "ok", c2: "gone" }, left: [], failed: false },
    { answers: { c1: "ok", c2: "stale" }, left: ["c2@2"], failed: true },
    { answers: { c1: "ok", c2: "lost" }, left: [], failed: false },
  ];
  /** The case's answers, by machine. */
  let answering = {};
  const listed = run.docker.provider;
  t.after(() => {
    run.docker.provider = listed;
  });
  run.docker.provider = (...args) => {
    const provider = listed(...args);
    return {
      ...provider,
      async release(ref, how) {
        const answer = answering[ref.id];
        if (answer === "fail") return { ok: false, error: { code: "unavailable", message: `the vendor refused to delete ${ref.id}` } };
        if (answer === "gone" || answer === "lost") run.docker.held.delete(ref.id);
        if (answer === "gone" || answer === "stale") return { ok: false, error: { code: "not_found", message: `${ref.id} is not there` } };
        if (answer === "lost") return { ok: false, error: { code: "unreachable", message: `the delete of ${ref.id} was not answered` } };
        return provider.release(ref, how);
      },
    };
  };
  for (const [at, { answers, left, failed }] of cases.entries()) {
    const words = JSON.stringify(answers);
    answering = answers;
    run.docker.held.clear();
    for (const epoch of [1, 2]) run.docker.held.set(`c${epoch}`, { ref: { id: `c${epoch}`, name: `c${epoch}` }, labels: { "agentrun.run": RUN, "agentrun.epoch": String(epoch) } });
    await run.server.settings.put(keptKeyOf(RUN), kept);
    const logged = [];
    // A person's stop: the claim at epoch 3 ends the run; a delete that keeps failing is asked again until the bound.
    await runEndComputers({ store: run.server, computers, log: (line) => logged.push(line), retryMs: 50, timeoutMs: 600 })({ runId: RUN, epoch: 3 });
    assert.deepEqual(run.docker.left(), left, `${words}: the machines left`);
    assert.equal(logged.some((line) => line.includes("could not be let go")), failed, `${words}: a delete that never went through is said: ${JSON.stringify(logged)}`);
    assert.equal(await readKept(run.server.settings, RUN), undefined, `${words}: the kept row ended once its own machine was gone, whatever came of the other delete, and the run's end removed it`);
    // The follow-up's claim made a new machine and parks it within the old keep's time.
    const next = { provider: "docker", kind: "sandbox", id: `c${10 + at}`, name: `c${10 + at}`, epoch: 4, until: Date.now() + KEEP_MS };
    assert.deepEqual(await keepKept(run.server.settings, RUN, next, {}), next, `${words}: the follow-up's park keeps its new machine`);
  }
});

test("a run's end whose mark comes late leaves a later claim's keep as that claim wrote it: a follow-up that reopened the run and parked a new machine, or is taking the old one back, keeps its machine", { timeout: 60_000 }, async (t) => {
  const run = await opened(t);
  const computers = { kinds: KINDS, providers: { docker: () => run.docker.provider() } };
  // The claim at epoch 3 ended the run, and its end waited on the store. Meanwhile a follow-up queued the run again, and
  // its claim (epoch 4) either parked a new machine on runner-b, or marked the old keep taking to attach it.
  const parked = { provider: "docker", kind: "sandbox", id: "c4", name: "c4", epoch: 4, until: Date.now() + KEEP_MS, runner: "runner-b", incarnation: "inc-b" };
  const taking = { provider: "docker", kind: "sandbox", id: "c2", name: "c2", epoch: 2, until: Date.now() + KEEP_MS, runner: "runner-a", incarnation: "inc-a", taking: 4 };
  for (const row of [parked, taking]) {
    run.docker.held.clear();
    run.docker.held.set(row.id, { ref: { id: row.id, name: row.id }, labels: { "agentrun.run": RUN, "agentrun.epoch": String(row.epoch) } });
    await run.server.settings.put(keptKeyOf(RUN), row);
    await runEndComputers({ store: run.server, computers, log: () => {}, retryMs: 50 })({ runId: RUN, epoch: 3 });
    assert.deepEqual(await readKept(run.server.settings, RUN), row, `the later claim's keep reads as it wrote it: ${JSON.stringify(row)}`);
    assert.deepEqual(run.docker.left(), [`${row.id}@${row.epoch}`], "and its machine is left");
  }
});

test("a run's end whose kept-row mark the store fails tries it again, and deletes the kept machine only once its row reads ending; marked on no try, that machine is left for its row's time, said in the log", { timeout: 60_000 }, async (t) => {
  const run = await opened(t);
  const computers = { kinds: KINDS, providers: { docker: () => run.docker.provider() } };
  const kept = { provider: "docker", kind: "sandbox", id: "c2", name: "c2", epoch: 2, until: Date.now() + KEEP_MS, runner: "runner-a", incarnation: "inc-a" };
  /** How many of the next marks the store fails. */
  let fails = 0;
  const bound = (target) => (name) => (typeof target[name] === "function" ? target[name].bind(target) : target[name]);
  const flaky = new Proxy(run.server.settings, {
    get: (target, name) => (name === "replaceIf" ? async (...args) => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("the store did not answer");
      }
      return target.replaceIf(...args);
    } : bound(target)(name)),
  });
  const store = new Proxy(run.server, { get: (target, name) => (name === "settings" ? flaky : bound(target)(name)) });
  for (const [failing, then] of [[2, "taken"], [Number.POSITIVE_INFINITY, "never"]]) {
    run.docker.held.clear();
    for (const epoch of [1, 2]) run.docker.held.set(`c${epoch}`, { ref: { id: `c${epoch}`, name: `c${epoch}` }, labels: { "agentrun.run": RUN, "agentrun.epoch": String(epoch) } });
    await run.server.settings.put(keptKeyOf(RUN), kept);
    fails = failing;
    const logged = [];
    await runEndComputers({ store, computers, log: (line) => logged.push(line), retryMs: 50 })({ runId: RUN, epoch: 3 });
    fails = 0;
    if (then === "taken") {
      assert.deepEqual(run.docker.left(), [], "the mark, tried again, landed, and then the kept machine is deleted with the rest");
      assert.equal(await readKept(run.server.settings, RUN), undefined, "its row ended once the delete took it, then removed with the run's end");
    } else {
      assert.deepEqual(run.docker.left(), ["c2@2"], "a row never marked ending: its machine is left for the row's time, so no claim attaches a machine being deleted");
      assert.deepEqual(await readKept(run.server.settings, RUN), kept, "its row as its park wrote it");
      assert.ok(logged.some((line) => line.includes("could not be marked ending") && line.includes("the store did not answer") && line.includes("c2")), `said in the log: ${JSON.stringify(logged)}`);
    }
  }
});

// A kept machine that held the run's folder on Archil carries its park's mount credential. The run's end that deletes it
// removes that credential before it marks the row ended, since an ended row is one no janitor pass removes a credential
// for; a remove that fails leaves the row ending, so the janitor's kept pass removes it and ends the row.
test("a stopped run's end that deletes a machine kept on Archil removes the park's mount credentials up to its epoch at Archil, then marks the row ended; a remove Archil refuses leaves the row ending for the janitor, said in the log", { timeout: 60_000 }, async (t) => {
  const run = await opened(t);
  const disk = "dsk-0000000000000001";
  await saveArchilSettings(run.server, { region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" });
  await putSealedKey(run.server, SEAL_KEY, ARCHIL_API_KEY_ROW, "fake-test-key");
  const computers = { kinds: KINDS, providers: { docker: () => run.docker.provider() } };
  const kept = { provider: "docker", kind: "sandbox", id: "c2", name: "c2", epoch: 2, until: Date.now() + KEEP_MS, folder: "archil", disk };
  for (const refuse of [false, true]) {
    // run-1's credentials of epochs 1 and 2 (the park's), the ending claim's (3), and another run's.
    const archil = archilControlFetch({
      existing: ["agentrun:run-1:1", "agentrun:run-1:2", "agentrun:run-1:3", "agentrun:run-2:2"].map((nickname, n) => ({ type: "token", identifier: `tok-${n}`, nickname, disk })),
      answer: ({ method }) => (refuse && method === "DELETE" ? { status: 500, body: { error: "Archil is down" } } : undefined),
    });
    const nicknames = () => [...archil.users.values()].map((user) => user.nickname).sort();
    run.docker.held.set("c2", { ref: { id: "c2", name: "c2" }, labels: { "agentrun.run": RUN, "agentrun.epoch": "2" } });
    await run.server.settings.put(keptKeyOf(RUN), kept);
    const logged = [];
    // A person's stop: the claim at epoch 3 ends the run, and its end deletes the kept machine.
    await runEndComputers({ store: run.server, computers, log: (line) => logged.push(line), retryMs: 50, env: {}, sealKey: SEAL_KEY, mountControl: { baseUrl: archil.baseUrl, fetch: archil.fetch } })({ runId: RUN, epoch: 3 });
    assert.deepEqual(run.docker.left(), [], `refuse ${refuse}: the kept machine is deleted`);
    if (!refuse) {
      assert.deepEqual(nicknames(), ["agentrun:run-1:3", "agentrun:run-2:2"], "the park's credential and an earlier one's removed with the machine, not left for their 24-hour ttl; the ending claim's and another run's stand");
      assert.ok(archil.requests.every((request) => request.authorization === "Bearer fake-test-key"), "with the server's saved Archil key");
      assert.equal(await readKept(run.server.settings, RUN), undefined, "the row ended once the credential was removed, then removed with the run's end");
    } else {
      assert.deepEqual(nicknames(), ["agentrun:run-1:1", "agentrun:run-1:2", "agentrun:run-1:3", "agentrun:run-2:2"], "Archil refused the remove");
      assert.deepEqual(await readKept(run.server.settings, RUN), { ...kept, ending: true }, "the row left ending, so the janitor's kept pass removes the credential and ends it");
      assert.ok(logged.some((line) => line.includes("mount credential") && line.includes("janitor")), `said in the log: ${JSON.stringify(logged)}`);
    }
  }
});

/** The run's first claim (epoch 1) made a sandbox on `docker` and its park kept it (the park's release moves the epoch
 *  to 2): the machine and its row, as the park wrote it. */
async function parkedWithKept(t, run, docker) {
  const folder = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-end-kept-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const first = await run.server.claim(RUN, "runner-a", { leaseMs: 60_000 });
  const made = await docker.create({ labels: { "agentrun.run": RUN, "agentrun.epoch": String(first.epoch) }, mount: { path: folder } });
  const kept = await keepKept(run.server.settings, RUN, { provider: "docker", kind: "sandbox", id: made.value.id, name: made.value.name, epoch: first.epoch, until: Date.now() + KEEP_MS }, {}, first);
  assert.ok(kept, "kept at the park");
  await run.server.release(first);
  return { first, machine: made.value, kept };
}

// A run's end is fenced by the claim that ends it. A follow-up that queued the stopped run again, claimed it and took
// the kept machine back before this end read the kept row (keptTaken: the row is gone) holds that machine, still
// labelled with the epoch of the claim that made it, at or below the ending claim's. Deleted by that end, it would go
// from under the follow-up's turn. So an end whose run a later claim has taken lets nothing go, said in the log: what
// is left is that claim's to let go.
test("a stopped run's end that comes after a follow-up's claim took the kept machine back lets nothing go: the machine, labelled at an earlier claim's epoch, survives, and the follow-up's turn still reaches it", { timeout: 60_000 }, async (t) => {
  const run = await opened(t);
  const computers = { kinds: KINDS, providers: { docker: () => run.docker.provider() } };
  const docker = run.docker.provider();
  const { first, machine, kept } = await parkedWithKept(t, run, docker);
  // A person's stop: a claim ends the run stopped. Its end has not run yet.
  const stop = await run.server.claim(RUN, "runner-b", { leaseMs: 60_000 });
  await run.server.runs.update(stop, { state: "stopped", outcome: "stopped" });
  // A follow-up queues the run again, and its claim takes the kept machine back before the stop's end reads the row.
  await run.server.runs.reopen(RUN, { kind: "steer", body: { text: "One more thing." } });
  const later = await run.server.claim(RUN, "runner-a", { leaseMs: 60_000 });
  assert.ok(later && later.epoch > stop.epoch, `a later claim: ${JSON.stringify(later)}`);
  const taking = await takeKept(run.server.settings, RUN, kept, later.epoch, later);
  assert.ok(taking && (await keptTaken(run.server.settings, RUN, taking)), "the follow-up's claim holds the kept machine, and its row is gone");
  const logged = [];
  await runEndComputers({ store: run.server, computers, log: (line) => logged.push(line), retryMs: 50 })({ runId: RUN, epoch: stop.epoch });
  assert.deepEqual(run.docker.left(), [`${machine.id}@${first.epoch}`], "the machine the follow-up's claim holds survives the stop's end");
  const reached = await docker.connect(machine);
  assert.equal(reached.ok, true, "the follow-up's turn still reaches it");
  assert.equal((await reached.value.client.call("files.write", { path: "/workspace/still.txt", data: Buffer.from("here").toString("base64") })).ok, true, "and works on it");
  assert.deepEqual(logged, [`run ${RUN}'s end at claim ${stop.epoch} lets no computer go: a later claim took the run again and may hold one of them, so they are that claim's to let go`]);
});

// The end reads the run twice, before its mark and after it, and only those reads tell it a later claim has the run: the
// machine a follow-up took back still carries its maker's label, at or below the ending claim's. A read that fails, or
// finds no run, tells it nothing, so the end lets nothing go. Rows: which read fails ("throws", or "none": no run found),
// and when the follow-up comes: "between" the two reads (it claims the run and takes the kept machine back, the row
// gone), or "claimed" before the end, taking the machine back only after it.
test("a stopped run's end whose read of the run fails, or finds no run, lets nothing go: a follow-up's claim that took the kept machine back between its two reads, or that claimed the run before it and takes the machine after, keeps it", { timeout: 60_000 }, async (t) => {
  const bound = (target) => (name) => (typeof target[name] === "function" ? target[name].bind(target) : target[name]);
  const rows = [
    { reads: ["real", "throws"], follow: "between", why: "the store did not answer" },
    { reads: ["real", "none"], follow: "between", why: "no such run" },
    { reads: ["throws", "real"], follow: "claimed", why: "the store did not answer" },
  ];
  for (const { reads, follow, why } of rows) {
    const words = `reads ${reads.join(", ")}, follow-up ${follow}`;
    const run = await opened(t);
    const computers = { kinds: KINDS, providers: { docker: () => run.docker.provider() } };
    const docker = run.docker.provider();
    const { first, machine, kept } = await parkedWithKept(t, run, docker);
    // A person's stop: a claim ends the run stopped. Its end has not run yet.
    const stop = await run.server.claim(RUN, "runner-b", { leaseMs: 60_000 });
    await run.server.runs.update(stop, { state: "stopped", outcome: "stopped" });
    /** The follow-up: the run queued again, and claimed past the stop's end's own move. */
    const claimed = async () => {
      await run.server.runs.reopen(RUN, { kind: "steer", body: { text: "One more thing." } });
      const later = await run.server.claim(RUN, "runner-a", { leaseMs: 60_000 });
      assert.ok(later && later.epoch > stop.epoch + 1, `${words}: a later claim: ${JSON.stringify(later)}`);
      return later;
    };
    /** The follow-up's claim takes the kept machine back: whether it holds it now (its row gone). */
    const takes = async (later) => {
      const taking = await takeKept(run.server.settings, RUN, kept, later.epoch, later);
      return Boolean(taking && (await keptTaken(run.server.settings, RUN, taking)));
    };
    let later = follow === "claimed" ? await claimed() : undefined;
    let tookBetween = false;
    /** The end's reads of the run so far: its two, then its provider's. */
    let asked = 0;
    const runs = new Proxy(run.server.runs, {
      get: (target, name) => (name === "get" ? async (...args) => {
        const answer = reads[asked] ?? "real";
        asked += 1;
        if (answer === "throws") throw new Error("the store did not answer");
        const row = answer === "none" ? undefined : await target.get(...args);
        if (asked === 1 && follow === "between") {
          later = await claimed();
          tookBetween = await takes(later);
        }
        return row;
      } : bound(target)(name)),
    });
    const store = new Proxy(run.server, { get: (target, name) => (name === "runs" ? runs : bound(target)(name)) });
    const logged = [];
    await runEndComputers({ store, computers, log: (line) => logged.push(line), retryMs: 50 })({ runId: RUN, epoch: stop.epoch });
    if (follow === "between") {
      assert.equal(tookBetween, true, `${words}: the follow-up's claim took the kept machine back between the end's two reads`);
    } else {
      assert.deepEqual(await readKept(run.server.settings, RUN), kept, `${words}: the end left the kept row as its park wrote it`);
      assert.equal(await takes(later), true, `${words}: so the follow-up's claim still takes the kept machine back`);
    }
    assert.deepEqual(run.docker.left(), [`${machine.id}@${first.epoch}`], `${words}: the machine the follow-up's claim holds survives the stop's end`);
    const reached = await docker.connect(machine);
    assert.equal(reached.ok, true, `${words}: the follow-up's turn still reaches it`);
    assert.equal((await reached.value.client.call("files.write", { path: "/workspace/still.txt", data: Buffer.from("here").toString("base64") })).ok, true, `${words}: and works on it`);
    assert.equal(await readKept(run.server.settings, RUN), undefined, `${words}: no row of the end's is left where the follow-up took its machine`);
    assert.deepEqual(logged, [`run ${RUN}'s end at claim ${stop.epoch} lets no computer go: the run could not be read (${why}) to tell whether a later claim holds one of them, so they are left for that claim, the run's next end or the computer janitor's sweep`], `${words}: said once`);
  }
});

// A keep that lapsed while the run was parked: its keeper's end deleted the machine at its time and marked the row
// ended, so the resume says why its computer is new. That row is that resume's to read and no later claim's: the run's
// end removes it, so a follow-up's claim reads no keep and never says again that the desktop wasn't kept. Nothing
// waits for a janitor's pass, which may be 10 minutes off, and never comes on a --faux server (computer-janitor.ts
// startJanitor).
test("a run whose keep lapsed and that then completed: its end removes the ended row, with no janitor pass, so a follow-up's claim reads no keep and says no lapse again", { timeout: 60_000 }, async (t) => {
  const run = await opened(t);
  const computers = { kinds: KINDS, providers: { docker: () => run.docker.provider() } };
  const docker = run.docker.provider();
  const { kept } = await parkedWithKept(t, run, docker);
  // Its time passes: the keeper's end deletes the machine and marks the row ended.
  assert.equal(await endKept(run.server.settings, RUN, kept, async () => void (await deleteKept(docker, kept))), true);
  assert.deepEqual(await readKept(run.server.settings, RUN), { ...kept, ended: true }, "ended, for the resume to say why");
  // The resume read it, said the desktop wasn't kept, made a new machine, and completed the run.
  const resume = await run.server.claim(RUN, "runner-a", { leaseMs: 60_000 });
  const folder = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-end-lapsed-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  await docker.create({ labels: { "agentrun.run": RUN, "agentrun.epoch": String(resume.epoch) }, mount: { path: folder } });
  await run.server.runs.update(resume, { state: "ended" });
  await runEndComputers({ store: run.server, computers, log: () => {}, retryMs: 50 })({ runId: RUN, epoch: resume.epoch });
  assert.deepEqual(run.docker.left(), [], "the resume's machine let go at the run's end");
  assert.equal(await readKept(run.server.settings, RUN), undefined, "the lapsed keep's row ends with its run");
  // A follow-up: the run queued again and claimed. Its claim reads no keep, so it says nothing of the lapse.
  await run.server.runs.reopen(RUN, { kind: "steer", body: { text: "And another." } });
  assert.ok(await run.server.claim(RUN, "runner-a", { leaseMs: 60_000 }), "the follow-up's claim");
  assert.equal(await readKept(run.server.settings, RUN), undefined, "the follow-up's claim reads no keep");
});

test("a run whose only claim ends it lets its own sandbox go at its end, and the run's end asks the provider nothing more", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  await run.start("runner-a");
  const end = await run.theEnd();
  assert.equal(end.status, "ended");
  assert.deepEqual(run.docker.made.map((one) => one.epoch), ["1"]);
  assert.deepEqual(end.left, []);
  assert.deepEqual(run.logged, []);
  // The claim's own release ended its interval.
  assert.deepEqual((await run.server.computerIntervals.forRun(RUN)).map((one) => [one.providerId, one.endedAt !== null]), [["c1", true]]);
});
