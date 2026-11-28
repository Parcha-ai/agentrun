// The read-back of what a run's computer mounts (attach.ts checkReadBack: the provider's read of the machine, Docker's
// `docker inspect`) is cut by the claim's signal, aborted on a lost claim or the runner's shutdown: a provider that never
// answers it holds no runner's close for its whole window. The attach that runs it in the run's start (run-tools.ts
// runHands, through claimCut), the one a run's own process's runner runs for a Mode 2 run's MCP files
// (run-child-host.ts, attachedIn) and the one a sandbox started in place of a lost one runs (computer-for-claim.ts
// remake) all take it. Through the runner (its close is what a SIGTERM runs: main.ts runUntilSignalled), its store and
// the spec builder pi really uses; the sandbox is a loopback stand-in for Docker's over the run's folder.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { AGENT, mode2Run, RUN as MODE2_RUN } from "./fixtures/mode2-mounted-run.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { STORE_FILE } = await import("../dist/store/sqlite/store.js");
const { startRunner, runnerCloseBoundMs } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const host = await import("../dist/runner/run-child-host.js");
const { heldRedactor } = await import("../dist/runner/redact.js");
const { FakeArchilDisk } = await import("./fixtures/archil-fake.mjs");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30, interruptBackoffMs: 20 };
after(closeOpenSessions);

const HELLO = { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** "pending" when `promise` has not settled within `ms`, else what it settled with (its timer holds no process open). */
const within = (promise, ms) => Promise.race([promise.then((value) => ({ value }), (error) => ({ error })), new Promise((resolve) => setTimeout(() => resolve("pending"), ms).unref())]);

/** A provider read that never answers: it ends only when its signal aborts, answered aborted as a provider answers a cut
 *  call. Each is kept in `hung` ({ id, signalled, ended }). */
function hangingRead(hung, id) {
  return (context) => {
    const call = { id, signalled: context?.signal instanceof AbortSignal, ended: false };
    hung.push(call);
    const signal = context?.signal;
    return new Promise((resolve) => {
      const cut = () => {
        call.ended = true;
        resolve({ ok: false, error: { code: "aborted", message: "the read was aborted" } });
      };
      if (signal?.aborted) cut();
      else signal?.addEventListener("abort", cut, { once: true });
    });
  };
}

/** Docker's stand-in: each sandbox made over the run's folder it binds; `docker.hangRead(ref)` says whether the
 *  provider's read of that machine never answers. */
function sandboxes() {
  const held = new Map();
  const made = [];
  const released = [];
  const hung = [];
  const docker = { held, made, released, hung, hangRead: () => false };
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
      return { ok: true, value: { client: one.computer.client, hello: HELLO, close: async () => {} } };
    },
    async attach(ref, context) {
      if (docker.hangRead(ref)) return hangingRead(hung, ref.id)(context);
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

test("a runner closed while its run's start reads back what the run's computer mounts, and the provider never answers: the close ends at once, the run handed back and its computer let go", { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-readback-"));
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
  const docker = sandboxes();
  docker.hangRead = (ref) => ref.id === "c1";
  const computerDeps = { kinds: KINDS, providers: { docker: () => docker.provider }, spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }), check: { readBackOf } };
  const route = { model: "claude-sonnet-5.5", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin([{ say: "done" }]) };
  const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps };
  runner = startRunner({ store, name: "runner-a", ...TIMING, createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) });
  await until(() => docker.hung.length > 0, "the run's start reads back its computer's mount");
  const closedAt = Date.now();
  await runner.close();
  const tookMs = Date.now() - closedAt;
  // The close's window is 40 s at least (the computer providers' cleanup bound and its margins); a close that waits on
  // the hung read sits all of it out. A quarter of the shipped bound is far above what the close takes once it ends.
  assert.ok(tookMs < runnerCloseBoundMs(0) / 4, `closed in ${tookMs} ms, not after its whole window`);
  assert.deepEqual(docker.hung.map(({ id, signalled, ended }) => ({ id, signalled, ended })), [{ id: "c1", signalled: true, ended: true }], "the read was given the claim's signal, and cut by it");
  const row = await server.runs.get(RUN);
  assert.deepEqual({ state: row.state, runner: row.runner }, { state: "running", runner: null }, "handed back, resumable");
  const db = new DatabaseSync(join(dir, STORE_FILE), { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT runner, epoch FROM hand_backs WHERE run_id = ?").all(RUN).map((one) => ({ ...one })), [{ runner: "runner-a", epoch: 1 }]);
  } finally {
    db.close();
  }
  assert.deepEqual(docker.released, ["c1"], "its computer let go");
});

test("Mode 2, a run's own process's runner attaching the run's folder for its MCP files (attachedIn): a read-back that never answers ends with the claim's signal, and the computer is still handed to the run", { timeout: 60_000 }, async (t) => {
  const hung = [];
  let hang = false;
  const disk = new FakeArchilDisk();
  const run = await mode2Run(t, { disk, providerAttach: (ref, context, found) => (hang ? hangingRead(hung, ref.id)(context) : found) });
  const revision = { kind: "agentic", body: { instructions: "Answer.", tools: ["read", "write"], computer: { kind: "sandbox", provider: "e2b" } } };
  const reads = { claim: { runId: MODE2_RUN, epoch: 1 }, run: { agentId: AGENT, revisionId: "rev-1", signInHanded: null }, launch: { input: { content: "Do the thing." } }, revision, claimed: {} };
  const said = [];
  const side = host.heldFor(run.deps, reads, heldRedactor((text) => text), (line) => said.push(line));
  t.after(() => side.release());
  const claim = new AbortController();
  // From the claim's computer on, every read of the machine hangs: the claim's own made the computer before it.
  hang = true;
  const going = side.held.computer({ hadComputer: async () => false, signal: claim.signal });
  await until(() => hung.length > 0, "the runner's attach reads back the computer's mount", 30_000);
  assert.equal(await within(going, 200), "pending", "the computer's handing waits on the read");
  claim.abort(new Error("the runner is closing"));
  const got = await within(going, 2_000);
  assert.notEqual(got, "pending", "the claim's abort ends the read, and the attach with it");
  assert.equal(got.value?.computer?.kind, "sandbox", `the computer is handed on: ${JSON.stringify(got)}`);
  assert.ok(hung.every((call) => call.signalled && call.ended), JSON.stringify(hung));
  assert.ok(said.some((line) => line.includes("could not be attached for the MCP's files")), said.join(" | "));
});
