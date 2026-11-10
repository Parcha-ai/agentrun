// A command row that reaches a run's loop after that loop's claim has ended (#2200). The runner's dispatch buffers a row
// handed over before it has chosen the run's harness loop (an approval's answer, a message) and replays it once the loop
// is chosen. That replay ran in a promise nothing caught: when the chosen loop ended before it was ready (a lease that
// lapsed, a session that would not open under load), the adapter loop read its closed Harness, which threw "Session is
// closed", and the unhandled rejection took the runner's process down with every claim it held.
//
// Here: the adapter loop never reads a closed Harness, and answers such a row `later` (left untaken for the run's next
// claim, so nobody's words are lost); the dispatch's replay never throws, whatever its inner loop does; and the runner's
// process logs a rejection nothing handled and keeps serving. No sleeps: each wait is on the event it names.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, stores, until } from "./runner-support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { lastResort } = await import("../dist/runner/main.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { MAX_RESTARTS } = await import("../dist/runner/conformance/harness.js");
const { openSqliteStore } = await import("../dist/store/index.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

const answer = (id, approval) => ({ id, runId: "run-1", kind: "approve", body: { approval }, createdAt: 0, takenAt: null, refused: null, tries: 0 });
const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/** Every unhandled rejection while `body` runs and a turn of the event loop after it: none is the bar. */
async function noUnhandled(body) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const value = await body();
    await new Promise((resolve) => setImmediate(resolve));
    return { value, seen };
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

test("an answer to an adapter loop whose claim ended before it was ready (its session never opened) is left for the run's next claim, never read from the closed Harness", { timeout: 60_000 }, async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const store = opened.runners[0];
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  // The Harness opens; then the session's open fails (a slow open under load, a lapsed lease): the loop ends, closing
  // its Harness, before it was ever ready.
  const base = piAdapterSpec({ script: [{ say: "never asked" }], tools: {}, hooks: quiet });
  const spec = async (c, run) => {
    const given = await base(c, run);
    return { ...given, adapter: { ...given.adapter, open: async () => { throw new Error("the session did not open in time"); } } };
  };
  const loop = createAdapterLoop(spec)({ journal: (c) => store.journal(c), flush: async () => store.flush?.(), signal: new AbortController().signal });
  await loop.start(claim).catch(() => undefined);
  const { value: outcome, seen } = await noUnhandled(() => loop.command(answer(1, "call-1")));
  assert.deepEqual(seen, [], "nothing rejected unhandled");
  assert.ok(outcome && "later" in outcome, `the answer is left untaken for the next claim (the runner writes only a refusal), never refused or thrown: ${JSON.stringify(outcome)}`);
});

test("the dispatch's replay of a row buffered before its loop was chosen never throws: an inner loop whose command() rejects lets the run end, and its delivered resolves", { timeout: 30_000 }, async () => {
  const launched = defer();
  const startCalled = defer();
  const finish = defer();
  let innerDeps;
  const inner = {
    start() {
      startCalled.resolve();
      return finish.promise.then(() => ({ state: "interrupted" }));
    },
    async command() {
      throw new Error("Session is closed");
    },
    async stop() {
      finish.resolve();
    },
  };
  const dispatch = createDispatchLoop({
    launchOf: async () => (await launched.promise, { body: { place: { mode: "runner" }, harness: "pi" } }),
    resolve: () => (deps) => ((innerDeps = deps), inner),
  })({ journal: () => ({}), flush: async () => {}, signal: new AbortController().signal });
  const { value, seen } = await noUnhandled(async () => {
    const run = dispatch.start({ runId: "run-1", runner: "runner-a", epoch: 1, until: 0, from: "running" });
    // Handed over before the launch read chose the loop: buffered, and the dispatch says it holds it.
    assert.deepEqual(await dispatch.command(answer(7, "call-1")), { taken: true });
    launched.resolve();
    await startCalled.promise;
    // The replay settles whatever the inner loop did with the row: the loop's delivered resolves after it.
    await innerDeps.delivered;
    finish.resolve();
    return run;
  });
  assert.deepEqual(seen, [], "the replay's rejection reached no unhandled handler");
  assert.deepEqual(value, { state: "interrupted" });
});

test("an approve for a parked call, buffered on a resume claim whose loop closes before it is ready, stays untaken in the store: the next claim takes it, and the call runs once as approved", { timeout: 90_000 }, async (t) => {
  const opened = await stores({ runners: 1 });
  await opened.server.settings.put("tool-settings", { web_fetch: { permission: "ask" } });
  await queue(opened.server, "run-1");
  const ran = { count: 0 };
  const tools = { web_fetch: { name: "web_fetch", replaySafe: false, ask: false, run: async () => { ran.count += 1; return "fetched it"; } } };
  const script = [{ call: "web_fetch", args: { url: "https://example.com/" } }, { say: "finished" }];
  const base = piAdapterSpec({ script, tools, hooks: quiet }, { fetch: scriptedOrigin(script, []) });
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-buffered-approve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = opened.runners[0];
  // The first resume's session does not open (a slow open under load): its loop ends before it is ready. Every other
  // session opens.
  let resumes = 0;
  const adapter = createAdapterLoop(async (claim, run) => {
    const gate = await adapterRunGate(store, claim, { kind: "agentic", body: { approvals: "ask" } }, root);
    const given = await base(claim, run);
    if (claim.from !== "parked" || (resumes += 1) > 1) return { ...given, gate };
    return { ...given, gate, adapter: { ...given.adapter, open: async () => { throw new Error("the session did not open in time"); } } };
  }, { restartLimit: MAX_RESTARTS });
  // The dispatch, as the runner holds it. On a resume claim its launch read waits until the runner has handed it the
  // approve, so the row is buffered before the loop is chosen, as #2200's was.
  const createLoop = (deps) => {
    let handed;
    const commandHanded = new Promise((resolve) => (handed = resolve));
    let claimed;
    const dispatch = createDispatchLoop({
      launchOf: async () => {
        if (claimed?.from === "parked") await commandHanded;
        return { body: { place: { mode: "runner" }, harness: "pi" } };
      },
      resolve: () => adapter,
    })(deps);
    return {
      start: (claim) => ((claimed = claim), dispatch.start(claim)),
      command: async (command) => {
        const outcome = await dispatch.command(command);
        handed();
        return outcome;
      },
      stop: (reason) => dispatch.stop(reason),
    };
  };
  const unhandled = [];
  const onRejection = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));
  const runner = startRunner({ store, createLoop, name: "runner-a", leaseMs: 30_000, renewEveryMs: 150, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30, resumeBackoffMs: 30_000 });
  t.after(() => runner.close());
  const rowOf = () => opened.server.runs.get("run-1");
  await until(async () => { const row = await rowOf(); return row.state === "parked" && row.runner === null; }, "the run parked on its call", 20_000);
  const entriesOf = async () => {
    const row = await rowOf();
    return (await journalRecords(opened.server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT)).entries;
  };
  const callId = await until(async () => (await entriesOf()).find((entry) => entry.kind === "agentrun.ask")?.data?.callId, "the call's ask", 10_000);
  const { id: approveId } = await sendCommand(opened.server, "run-1", { kind: "approve", body: { approval: callId } });
  // The resume claim's loop closes before it is ready: the run stays parked (a resume that throws is tried again after a
  // backoff), and the approve row is untaken, neither taken by a loop nor refused.
  await until(async () => resumes === 1 && (await rowOf()).runner === null, "the first resume let go of the run", 20_000);
  const held = (await opened.server.commands("run-1", 0)).find((c) => c.id === approveId);
  assert.deepEqual([held.takenAt, held.refused], [null, null], `the approve is left for the next claim: ${JSON.stringify(held)}`);
  assert.equal(ran.count, 0, "nothing ran on the claim that never opened");
  assert.deepEqual(unhandled, [], "nothing rejected unhandled: the runner went on");
  // Past the backoff: the next claim takes the approve and the call goes on as approved, once.
  opened.clock.skewMs += 31_000;
  await until(async () => { const row = await rowOf(); return row.state === "ended" && row.runner === null && row; }, "the run ended on the next claim", 30_000);
  const taken = (await opened.server.commands("run-1", 0)).find((c) => c.id === approveId);
  assert.ok(taken.takenAt !== null && taken.refused === null, `the next claim took the approve: ${JSON.stringify(taken)}`);
  assert.equal(ran.count, 1, "the approved call ran once");
  const answers = (await entriesOf()).filter((entry) => entry.kind === "agentrun.answer" && entry.data?.callId === callId);
  assert.equal(answers.length, 1, `one answer for the call, never two: ${JSON.stringify(answers.map((a) => a.data))}`);
  assert.equal(answers[0].data.approved, true, "answered as approved");
  assert.deepEqual(unhandled, []);
});

test("the runner process's last resort says what went wrong in the runner's name with its stack, then exits 1", () => {
  const lines = [];
  const exits = [];
  const handle = lastResort("runner-a", (line) => lines.push(line), (code) => exits.push(code));
  handle(new Error("Session is closed"));
  handle("a plain reason");
  assert.deepEqual(exits, [1, 1]);
  assert.match(lines[0], /^agentrun-serve runner: Runner runner-a: an error nothing handled, so the runner exits \(its claims lapse, and are taken back\): Error: Session is closed\n {4}at /);
  assert.match(lines[1], /: a plain reason\n$/);
});

/** A runner process (runnerMain, as `agentrun-serve runner` runs it) on a set-up store that, once it says it is ready,
 *  meets `fault` in its own process: what it printed and how it exited. */
async function runnerMeeting(t, fault) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-last-resort-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await (await openSqliteStore({ dataDir: dir, role: "server" })).close();
  const main = new URL("../dist/runner/main.js", import.meta.url).href;
  // The fault is raised from the runner's own console.log of its ready line: the moment the runner serves.
  const code = `const { runnerMain } = await import(${JSON.stringify(main)});
const log = console.log.bind(console);
console.log = (...said) => { log(...said); if (/ ready: /.test(String(said[0]))) setImmediate(() => { ${fault} }); };
process.exitCode = await runnerMain(["--data", ${JSON.stringify(dir)}, "--name", "runner-x", "--loops", "1"]);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, AGENTRUN_SEAL_KEY: Buffer.alloc(32, 5).toString("base64"), HOME: dir, XDG_CONFIG_HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"));
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const exited = await new Promise((resolve) => child.once("close", (exitCode, signal) => resolve({ exitCode, signal })));
  return { ...exited, out, err };
}

test("a runner process given a promise rejection nothing handles exits 1 at once, saying so with its stack", { timeout: 60_000 }, async (t) => {
  const { exitCode, signal, out, err } = await runnerMeeting(t, `Promise.reject(new Error("a rejection from the test"));`);
  assert.match(out, /Runner runner-x ready: /, "it served first");
  assert.deepEqual([exitCode, signal], [1, null], `it exits 1: ${err}`);
  assert.match(err, /agentrun-serve runner: Runner runner-x: an error nothing handled, so the runner exits \(its claims lapse, and are taken back\): Error: a rejection from the test\n {4}at /);
});

test("a runner process given an exception nothing catches exits 1 at once, saying so with its stack", { timeout: 60_000 }, async (t) => {
  const { exitCode, signal, err } = await runnerMeeting(t, `throw new Error("an exception from the test");`);
  assert.deepEqual([exitCode, signal], [1, null], `it exits 1: ${err}`);
  assert.match(err, /Runner runner-x: an error nothing handled, so the runner exits .*: Error: an exception from the test\n {4}at /);
});
