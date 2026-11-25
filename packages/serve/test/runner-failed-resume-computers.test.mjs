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
const { deleteKept, endKept, KEEP_MS, keepKept, keptKeyOf, readKept } =await import("../dist/workspace/computer-kept.js");

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
  // runner-a's own end at the keep's time finds its machine gone: a delete that reads not_found is as good as done.
  const ended = await endKept(run.server.settings, RUN, kept, async () => void (await deleteKept(run.docker.provider(), kept)));
  assert.equal(ended, true, "runner-a's end marks its row ended");
  assert.equal((await readKept(run.server.settings, RUN))?.ended, true);
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
    assert.deepEqual(await readKept(run.server.settings, RUN), { ...kept, ending: true }, `the run is final: ${JSON.stringify(row)} reads ending, so no claim takes its machine back`);
    assert.deepEqual(atDelete, { ...kept, ending: true }, "marked before the delete");
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
  assert.deepEqual(afterStop, { ...kept, ended: true }, "the stop's end marked its row ended");

  // A machine kept on runner-a's own engine, which this end's list does not show: never deleted here, so its row stays
  // ending for runner-a's end at its time, which deletes it.
  const pinned = { ...kept, id: "c8", name: "c8", runner: "runner-a", incarnation: "inc-a" };
  await run.server.settings.put(keptKeyOf(RUN), pinned);
  await runEndComputers({ store: run.server, computers, log: () => {}, retryMs: 50 })({ runId: RUN, epoch: 5 });
  assert.deepEqual(await readKept(run.server.settings, RUN), { ...pinned, ending: true }, "a machine this end did not delete keeps its row ending");
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
      assert.deepEqual(await readKept(run.server.settings, RUN), { ...kept, ending: true }, "the mark, tried again, reads ending");
      assert.deepEqual(run.docker.left(), [], "and then the kept machine is deleted with the rest");
    } else {
      assert.deepEqual(run.docker.left(), ["c2@2"], "a row never marked ending: its machine is left for the row's time, so no claim attaches a machine being deleted");
      assert.deepEqual(await readKept(run.server.settings, RUN), kept, "its row as its park wrote it");
      assert.ok(logged.some((line) => line.includes("could not be marked ending") && line.includes("the store did not answer") && line.includes("c2")), `said in the log: ${JSON.stringify(logged)}`);
    }
  }
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
