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

test("a run whose only claim ends it lets its own sandbox go at its end, and the run's end asks the provider nothing more", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  await run.start("runner-a");
  const end = await run.theEnd();
  assert.equal(end.status, "ended");
  assert.deepEqual(run.docker.made.map((one) => one.epoch), ["1"]);
  assert.deepEqual(end.left, []);
  assert.deepEqual(run.logged, []);
});
