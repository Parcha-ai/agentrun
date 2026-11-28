// A run's end (RunTools.end: its background processes ended, then its scratch swept) goes through its computer's
// daemon. A daemon that died mid-run never answers it, so the end's computer calls are cut at the close's releaseBy (the
// close's window less its reserve, runner.ts runnerStopBy and runnerReserveMs): what comes after them (the claim's
// release with its drain cut, its hand-back, the computer's interval ended and the sandbox let go) lands inside the
// window instead of the runner's close running out with none of it done. The cut point is the window's own: a longer
// lease moves it by as much. A run that ends on its own on a dead daemon is cut by its release's bound
// (releaseBoundMs) and lets its computer go too. Through the runner (its close is what a SIGTERM runs: main.ts
// runUntilSignalled), its store and the spec builder pi really uses (adapter-run-spec.ts); the sandboxes are loopback
// stand-ins for Docker's over the run's folder, and the model a script.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner, runnerStopBy, runnerReserveMs } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { releaseBoundMs } = await import("../dist/runner/loop-contract.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { STORE_FILE } = await import("../dist/store/sqlite/store.js");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
/** The close's window and its parts: short, so the cut and what follows it come in seconds, not the default 55 s. */
const STOP_MARGIN_MS = 1_000;
const RELEASE_MARGIN_MS = 1_000;
const CLEANUP_MS = 0;
const timing = (leaseMs) => ({ leaseMs, renewEveryMs: 250, stopMarginMs: STOP_MARGIN_MS, releaseMarginMs: RELEASE_MARGIN_MS, cleanupMs: CLEANUP_MS, pollMs: 20, commandPollMs: 30, interruptBackoffMs: 20 });
after(closeOpenSessions);

const HELLO = { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };

const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Docker's stand-in: each sandbox made over the run's folder it binds. `docker.hang(one, method)` says whether a call is
 * never answered: it ends only when its signal aborts, answered aborted as the daemon client answers a cut call; each
 * such call is kept in `docker.hung` ({ id, method, at, endedAt }).
 */
function sandboxes() {
  const held = new Map();
  const made = [];
  const released = [];
  const hung = [];
  const docker = { held, made, released, hung, hang: () => false };
  docker.provider = {
    id: "fake",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    prepareImage: async () => ({ ok: true, value: "agentrun/computer:prepared" }),
    async list(labels) {
      const listed = [...held.values()].filter((one) => Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: listed.map((one) => ({ ref: one.ref, labels: one.labels, state: "running", network: "none" })) };
    },
    async create(spec) {
      const ref = { id: `c${made.length + 1}`, name: `c${made.length + 1}` };
      made.push(ref.id);
      held.set(ref.id, { ref, labels: spec.labels, computer: fakeComputer(spec.mount.path) });
      return { ok: true, value: ref };
    },
    async connect(ref) {
      const one = held.get(ref.id);
      const client = {
        async call(method, params, options) {
          if (docker.hang(one, method)) {
            const call = { id: ref.id, method, at: Date.now(), endedAt: null };
            hung.push(call);
            const signal = options?.signal;
            return await new Promise((resolve) => {
              const cut = () => {
                call.endedAt = Date.now();
                resolve({ ok: false, error: { code: "aborted", message: `the call was aborted: ${signal.reason?.message ?? signal.reason}` } });
              };
              if (signal?.aborted) cut();
              else signal?.addEventListener("abort", cut, { once: true });
            });
          }
          return one.computer.client.call(method, params, options);
        },
        close() {},
      };
      return { ok: true, value: { client, hello: HELLO, close: async () => {} } };
    },
    async attach(ref) {
      const one = held.get(ref.id);
      if (!one) return { ok: false, error: { code: "not_found", message: `no fake computer has the id ${ref.id}` } };
      const read = await one.computer.readBack();
      return { ok: true, value: { ...ref, spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    async release(ref) {
      released.push(ref.id);
      held.delete(ref.id);
      return { ok: true, value: undefined };
    },
  };
  return docker;
}

const WRITE = { call: "write", args: { path: "notes.txt", content: "one" } };

/** A runner on a fresh store with one run of a sandbox agent, its model `script`, and `docker`'s stand-in. */
async function oneRun(t, docker, script, leaseMs) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-end-cut-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Box" }, { id: "rev-1", kind: "agentic", body: { instructions: "Work.", computer: { kind: "sandbox", provider: "docker" }, tools: ["read", "write"] } });
  const launch = { input: { content: "Work." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const computerDeps = { kinds: KINDS, providers: { docker: () => docker.provider }, spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }), check: { readBackOf } };
  const route = { model: "claude-sonnet-5.5", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script) };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps };
  runner = startRunner({ store, name: "runner-a", ...timing(leaseMs), createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) });
  const rows = () => {
    const db = new DatabaseSync(join(dir, STORE_FILE), { readOnly: true });
    try {
      const all = (sql) => db.prepare(sql).all(RUN).map((one) => ({ ...one }));
      return { attempts: all("SELECT epoch, cut FROM run_attempts WHERE run_id = ?"), handBacks: all("SELECT runner, epoch FROM hand_backs WHERE run_id = ?"), intervals: all("SELECT ended_at FROM computer_intervals WHERE run_id = ?") };
    } finally {
      db.close();
    }
  };
  return { server, runner, rows };
}

/** The daemon dies at the run's second file write: from then on it answers nothing. */
const diesAtSecondWrite = (docker) => {
  let writes = 0;
  let dead = false;
  docker.hang = (_one, method) => dead || (method === "files.write" && ++writes > 1 && (dead = true));
};

for (const leaseMs of [4_000, 7_000]) {
  test(`a runner's close cuts a run's end on a dead daemon at its releaseBy, then hands it back and lets the computer go (lease ${leaseMs} ms)`, { timeout: 60_000 }, async (t) => {
    const docker = sandboxes();
    diesAtSecondWrite(docker);
    const { server, runner, rows } = await oneRun(t, docker, [WRITE, WRITE, { say: "done" }], leaseMs);
    await until(() => docker.hung.length > 0, "the daemon stops answering mid-run");
    const closedAt = Date.now();
    const stopBy = runnerStopBy(closedAt, closedAt, leaseMs, STOP_MARGIN_MS, CLEANUP_MS, RELEASE_MARGIN_MS);
    const releaseBy = stopBy - runnerReserveMs(STOP_MARGIN_MS, RELEASE_MARGIN_MS);
    await runner.close();
    const tookMs = Date.now() - closedAt;
    // The end's own calls (its background processes listed) were never answered, and were cut at releaseBy: the
    // window's, not a fixed time, so the two leases cut them 3 s apart.
    const ends = docker.hung.filter((call) => call.method.startsWith("process."));
    assert.ok(ends.length > 0, `the end asked the dead daemon for its processes: ${JSON.stringify(docker.hung)}`);
    for (const call of ends) {
      assert.notEqual(call.endedAt, null, `the end's ${call.method} was cut: ${JSON.stringify(docker.hung)}`);
      assert.ok(Math.abs(call.endedAt - releaseBy) < 750, `the end's ${call.method} was cut at releaseBy (${call.endedAt - closedAt} ms into the close; releaseBy ${releaseBy - closedAt} ms)`);
    }
    // And the close ended inside its window, with the claim's release done: its drain cut, the run handed back, the
    // computer's interval ended and the sandbox let go.
    assert.ok(tookMs < stopBy - closedAt, `the close took ${tookMs} ms, under its window of ${stopBy - closedAt} ms`);
    const row = await server.runs.get(RUN);
    assert.deepEqual({ state: row.state, runner: row.runner }, { state: "running", runner: null });
    const { attempts, handBacks, intervals } = rows();
    assert.deepEqual(attempts, [{ epoch: 1, cut: "drain" }]);
    assert.deepEqual(handBacks, [{ runner: "runner-a", epoch: 1 }]);
    assert.ok(intervals.length > 0 && intervals.every((one) => one.ended_at !== null), `the computer's interval ended: ${JSON.stringify(intervals)}`);
    assert.deepEqual(docker.released, ["c1"]);
  });
}

test("a run that ends on its own on a dead daemon cuts its end at the release's bound, then ends and lets the computer go", { timeout: 90_000 }, async (t) => {
  const docker = sandboxes();
  // The daemon dies after the run's last tool call, before its end: from the end's first call (its background processes
  // listed) on, it answers nothing.
  let dead = false;
  docker.hang = (_one, method) => dead || (method.startsWith("process.") && (dead = true));
  const { server, rows } = await oneRun(t, docker, [WRITE, { say: "done" }], 4_000);
  // Let go means the release's whole write: the provider's release answered, then the computer's interval ended (in
  // that order, providerComputer's release), so the wait reads both, never the first alone.
  const lets = () => docker.released.length > 0 && rows().intervals.length > 0 && rows().intervals.every((one) => one.ended_at !== null);
  const ended = await until(async () => (await server.runs.get(RUN)).state !== "running" && lets(), "the run ends and its computer is let go", 75_000).catch(() => false);
  const row = await server.runs.get(RUN);
  assert.ok(ended, `the run ended and its computer was let go: ${JSON.stringify({ state: row.state, runner: row.runner, released: docker.released, intervals: rows().intervals, hung: docker.hung })}`);
  assert.equal(row.state, "ended");
  // Its end's first call on the dead daemon was cut at the release's bound (releaseBoundMs of the runner's cleanup bound
  // and release margin) from when the end began.
  const first = docker.hung[0];
  assert.ok(first?.method.startsWith("process.") && first.endedAt !== null, `the end's calls on the dead daemon were cut: ${JSON.stringify(docker.hung)}`);
  assert.ok(Math.abs(first.endedAt - first.at - releaseBoundMs(CLEANUP_MS, RELEASE_MARGIN_MS)) < 500, `the end's ${first.method} was cut ${first.endedAt - first.at} ms after it was sent, at the release's bound (${releaseBoundMs(CLEANUP_MS, RELEASE_MARGIN_MS)} ms)`);
  assert.ok(rows().intervals.every((one) => one.ended_at !== null));
  assert.deepEqual(docker.released, ["c1"]);
});
