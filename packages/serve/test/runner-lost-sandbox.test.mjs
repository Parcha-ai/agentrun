// A run's sandbox its provider loses mid-run (a vendor's delete, a container gone): the call that finds it lost fails,
// and the next tool call starts a new one in its place under the same claim, the run's folder mounted in it again, said
// on the Timeline; the run goes on and completes. Past the claim's bound (two new ones) the next loss ends the run failed,
// served as computer_unavailable in the provider's words. A provider error that is not a loss (its read of the machine
// failing, a 5xx) starts nothing, and a desktop is never started again so. Through the runner, its store and the spec
// builder pi really uses (adapter-run-spec.ts); the sandbox is a loopback stand-in for Docker's over the run's folder
// (Mode 1's bind: the folder outside the computer survives it, as a Mode 2 folder on Archil does), and the model a script.
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
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30, interruptBackoffMs: 20 };
after(closeOpenSessions);

const HELLO = { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
const GONE = (id) => ({ ok: false, error: { code: "gone", message: `the connection to ${id} ended` } });

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Docker's stand-in: each sandbox made over the run's folder it binds. `docker.lose(one, method)` says whether a call
 * loses the sandbox it goes to: the provider deletes it then (as a vendor's own API can), and that call and every later
 * one on its connection answer gone. `docker.attachAnswer`, when set, is what the provider's read of a machine answers
 * (a failing read, a 5xx); else a held one is found and a deleted one is not_found. Each create's request id is kept.
 */
function sandboxes() {
  const held = new Map();
  const made = [];
  const requests = [];
  const released = [];
  const docker = { held, made, requests, released, lose: () => false, attachAnswer: undefined };
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
    async create(spec, context) {
      requests.push(context.requestId);
      const ref = { id: `c${made.length + 1}`, name: `c${made.length + 1}` };
      made.push(ref.id);
      held.set(ref.id, { ref, labels: spec.labels, computer: fakeComputer(spec.mount.path), alive: true });
      return { ok: true, value: ref };
    },
    async connect(ref) {
      const one = held.get(ref.id);
      const client = {
        async call(method, params, options) {
          if (!one.alive) return GONE(ref.id);
          if (docker.lose(one, method)) {
            one.alive = false;
            held.delete(ref.id);
            return GONE(ref.id);
          }
          return one.computer.client.call(method, params, options);
        },
        close() {},
      };
      return { ok: true, value: { client, hello: HELLO, close: async () => {} } };
    },
    async attach(ref) {
      if (docker.attachAnswer) return docker.attachAnswer;
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

async function opened(t, computer = { kind: "sandbox", provider: "docker" }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-lost-sandbox-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const stores = [server];
  const runners = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores.reverse()) await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Box" }, { id: "rev-1", kind: "agentic", body: { instructions: "Work.", computer, tools: ["read", "write"] } });
  const launch = { input: { content: "Work." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const docker = sandboxes();
  const computerDeps = { kinds: KINDS, providers: { docker: () => docker.provider }, spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }), check: { readBackOf } };
  const ends = [];
  const start = async (fetch) => {
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    stores.push(store);
    const route = { model: "claude-sonnet-5.5", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch };
    const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps };
    const onEvent = (event) => event.type === "released" && ends.push(event.end);
    runners.push(startRunner({ store, name: "runner-a", ...TIMING, onEvent, createLoop: createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(launch, run, deps, claim)) }));
  };
  const settled = (states) => until(async () => {
    const now = await server.runs.get(RUN);
    return states.includes(now.state) && now.runner === null && states.includes(ends.at(-1)) && now;
  }, `the run is released ${states.join(" or ")}`);
  const summaries = async () => (await runTimeline(server, RUN, ctx)).map((row) => row.summary);
  const served = () => viewOverStore(server, RUN, { origin: "https://run.test", serverSecrets: () => [] });
  return { server, docker, start, settled, summaries, served };
}

const WRITE = { call: "write", args: { path: "notes.txt", content: "kept across sandboxes" } };
const READ = { call: "read", args: { path: "notes.txt" } };
/** The tool results the model was sent, in order: each one's text and whether it is an error. */
const toolResults = (requests) => {
  const last = requests.at(-1)?.messages ?? [];
  return last.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result").map((block) => ({
    error: block.is_error === true,
    text: (Array.isArray(block.content) ? block.content.map((part) => part.text ?? "").join("") : String(block.content ?? "")),
  }));
};

test("a sandbox its provider deletes mid-call: that call fails, the next starts a new one under the same claim, the folder's file still there, said on the Timeline, and the run completes", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  // The first sandbox is deleted at its first read: the read in flight answers gone, and the provider no longer has it.
  run.docker.lose = (one, method) => one.ref.id === "c1" && method === "files.read";
  const requests = [];
  await run.start(scriptedOrigin([WRITE, READ, READ, { say: "done" }], requests));
  const row = await run.settled(["ended"]);
  assert.equal(row.state, "ended", "the run completes");
  assert.deepEqual(run.docker.made, ["c1", "c2"], "one new sandbox, made once");
  assert.deepEqual(run.docker.requests, [`${RUN}#1`, `${RUN}#1#lost-1`], "the new one's create is the claim's own request: a retry of it under this epoch finds it");
  const results = toolResults(requests);
  assert.deepEqual(results.map((one) => one.error), [false, true, false], "the write, the read the loss cut, the read on the new sandbox");
  assert.match(results[1].text, /the connection to c1 ended/, "the cut read says why");
  assert.match(results[2].text, /kept across sandboxes/, "the run's folder survived its sandbox: the new one mounts it");
  const said = await run.summaries();
  assert.deepEqual(said.filter((summary) => summary?.startsWith("Its computer was lost")), ["Its computer was lost; started a new one (c2)."], `the Timeline says it once: ${JSON.stringify(said)}`);
  assert.equal(said.filter((summary) => summary?.startsWith("Starting a sandbox")).length, 2, "each sandbox's start is said");
  assert.deepEqual(run.docker.released, ["c1", "c2"], "the lost one let go at once, the new one at the run's end");
  assert.equal(run.docker.held.size, 0);
  assert.equal((await run.served()).error, null);
});

test("past two new sandboxes the next loss ends the run failed, served as computer_unavailable in the provider's words; no fourth is made", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  // Every sandbox is deleted at its first read.
  run.docker.lose = (_one, method) => method === "files.read";
  const requests = [];
  await run.start(scriptedOrigin([WRITE, READ, READ, READ, READ, READ, { say: "done" }], requests));
  const row = await run.settled(["failed"]);
  assert.equal(row.state, "failed");
  assert.deepEqual(run.docker.made, ["c1", "c2", "c3"], "two new ones, then none");
  assert.match(row.summary, /^computer_unavailable: the run's sandbox was lost 3 times, and a run starts at most 2 new ones in place of a lost one: the connection to c3 ended\.$/);
  const served = await run.served();
  assert.equal(served.status, "failed");
  assert.equal(served.error.code, "computer_unavailable", JSON.stringify(served.error));
  assert.match(served.error.message, /^the run's sandbox was lost 3 times/);
  const said = await run.summaries();
  assert.deepEqual(said.filter((summary) => summary?.startsWith("Its computer was lost")), ["Its computer was lost; started a new one (c2).", "Its computer was lost; started a new one (c3)."]);
  assert.equal(run.docker.held.size, 0, "nothing left running");
});

test("a call answered gone while the provider's read of the machine fails (a 5xx): not lost, nothing new made, the next call goes to the same sandbox", { timeout: 120_000 }, async (t) => {
  const run = await opened(t);
  let cut = false;
  // The first read's connection drops once; the sandbox itself is still there.
  run.docker.lose = (one, method) => {
    if (cut || method !== "files.read") return false;
    cut = true;
    run.docker.attachAnswer = { ok: false, error: { code: "vendor", message: "Docker answered 503" } };
    // Lost to this call alone: the next one finds it alive and held again.
    queueMicrotask(() => {
      one.alive = true;
      run.docker.held.set(one.ref.id, one);
    });
    return true;
  };
  const requests = [];
  await run.start(scriptedOrigin([WRITE, READ, READ, { say: "done" }], requests));
  const row = await run.settled(["ended"]);
  assert.equal(row.state, "ended");
  assert.deepEqual(run.docker.made, ["c1"], "no new sandbox");
  assert.deepEqual(toolResults(requests).map((one) => one.error), [false, true, false], "the dropped read failed; the next read ran on c1");
  assert.ok(!(await run.summaries()).some((summary) => summary?.startsWith("Its computer was lost")), "nothing said lost");
});

test("a desktop its provider deletes is not started again: the run's later calls fail in the provider's words and no new one is made", { timeout: 120_000 }, async (t) => {
  const run = await opened(t, { kind: "desktop", provider: "docker" });
  run.docker.lose = (one, method) => one.ref.id === "c1" && method === "files.read";
  const requests = [];
  await run.start(scriptedOrigin([WRITE, READ, READ, { say: "done" }], requests));
  await run.settled(["ended", "failed"]);
  assert.deepEqual(toolResults(requests).map((one) => one.error), [false, true, true], "the loss cut the first read, and the read after it fails too");
  assert.deepEqual(run.docker.made, ["c1"], "no new desktop");
  assert.ok(!(await run.summaries()).some((summary) => summary?.startsWith("Its computer was lost")), "nothing said lost");
});
