// A server's stop and the next start on its data root (server-lock.ts's record, server.state). A stop keeps the data root
// until the runner beside the server has drained its runs' turns (up to their drain and a second) and let them go, and
// the API answers meanwhile. The stopping server says how long it waits and for how many runs; a start in that window
// waits for it, saying whom it waits for and for how long, then starts and opens the cut run again. A start on a root
// whose server runs, and is not stopping, is refused at once, as before. The stop is the CLI's (server.ts stopBeside):
// the server, and the runner beside it that claims and runs every run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { stopBeside } from "../dist/server.js";
import { openSqliteStore, StoreOwned } from "../dist/store/index.js";
import { agent, client, FAUX, follow, scratch, startRunnerBeside } from "./support.mjs";

const STATE = "server.state";
const refusal = (data) => `another server holds the store at ${join(data, "store.sqlite")}`;

/** Until `check()` holds, for at most `ms`, read every 50 ms: a state the test waits on, named `what`. */
async function until(check, what, ms = 60_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < end, `${what} (not in ${ms} ms)`);
  }
}

/** A server on `data` with the runner beside it, as the CLI starts them: `drainMs` the runner's drain (--drain-timeout). */
async function serverAndRunner(t, data, options = {}, drainMs = 3_000) {
  const server = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "3s", ...options });
  const beside = await startRunnerBeside(data, { faux: FAUX, drainMs });
  t.after(async () => {
    await beside.close();
    await server.close();
  });
  return { server, beside };
}

/** A server and its runner on `data` (with `options` for its start) whose one run is mid-turn: it wrote a file, and its
 *  next model request has started (the faux model makes `signal` as it does) and answers only after a minute, so a stop's
 *  3 s drain cuts it. The signal is removed once read, so the run's next start of that request makes it again. */
async function midTurn(t, data, options = {}) {
  const said = [];
  const notice = options.notice ?? ((line) => said.push(line));
  const { server: first, beside } = await serverAndRunner(t, data, { notice, ...options });
  let closed;
  const close = () => (closed ??= stopBeside(first, { held: () => beside.runner.held(), close: beside.close }, { data, drainMs: 3_000, notice }));
  t.after(close);
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("POST", "/agents", agent("slow"))).status, 201);
  const signal = join(await scratch(t), "asked");
  const run = await api("POST", "/agents/slow/runs", { input: { content: `Write a file, then signal ${signal} and wait.` } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await until(() => existsSync(signal), "the run's second request started");
  await rm(signal);
  const claim = beside.runner.held().find((held) => held.runId === runId);
  assert.ok(claim, "the runner beside the server holds the run");
  return { close, runId, claim, runner: beside.runner, signal, said, first };
}

/** The data root's own entries, by name. */
const entries = (data) => readdirSync(data).sort();

test("a start on a data root whose server is stopping waits for that stop, says so, then starts and opens the cut run again", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const { close, runId, claim, runner, signal, said: stopSaid } = await midTurn(t, data);
  const closing = close();
  // The record says stopping as the close begins, before it waits on anything: read here, checked once the start is through.
  const mark = existsSync(join(data, STATE)) ? JSON.parse(readFileSync(join(data, STATE), "utf8")) : undefined;
  const markedAt = Date.now();
  let stopped = false;
  let goneAtStop;
  void closing.then(() => {
    stopped = true;
    goneAtStop = runner.held().length === 0;
  });
  const said = [];
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "3s", notice: (line) => said.push(line) });
  t.after(() => next.close());
  // The stopping server said, as its close began, how long it waits and for how many runs: its run's 3 s drain and a second.
  assert.deepEqual(stopSaid, ["stopping: waiting up to 4 s for 1 run to finish its turn"]);
  assert.equal(mark?.pid, process.pid, `the stopping server's mark: ${JSON.stringify(mark)}`);
  assert.ok(mark.until > markedAt, JSON.stringify(mark));
  assert.equal(stopped, true, "the start went on only once the stopping server was done");
  assert.equal(goneAtStop, true, "and that server was done only once its runner let the run go");
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0], new RegExp(`^the server on this data root \\(pid ${process.pid}\\) is stopping; waiting for it, up to \\d+ s$`));
  assert.deepEqual(JSON.parse(readFileSync(join(data, STATE), "utf8")), { pid: process.pid, until: null }, "the new server's record: it runs");
  // The new server's runner opens the run its stop cut: the cut request starts again under a claim of its own.
  const nextRunner = await startRunnerBeside(data, { faux: FAUX });
  t.after(() => nextRunner.close());
  await until(() => existsSync(signal), "the cut request started again under the new server");
  const again = nextRunner.runner.held().find((held) => held.runId === runId);
  assert.ok(again && again.epoch > claim.epoch, `claimed again at a later epoch: ${JSON.stringify({ was: claim.epoch, now: again?.epoch })}`);
  const api = client(next.baseUrl, next.token);
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  await follow(api, runId, ["cancelled"], { deadlineMs: 60_000 });
});

test("a stop is over only once its runner let its runs go: nothing of the run runs after the stop", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const { close, runId, runner } = await midTurn(t, data);
  await close();
  assert.deepEqual(runner.held(), [], "nothing of the run runs after the stop: the runner holds none of it");
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  try {
    const row = await store.runs.get(runId);
    assert.deepEqual([row.state, row.runner], ["running", null], "let go to resume, its claim with no runner");
  } finally {
    await store.close();
  }
});

test("a start on a data root whose server runs is refused at once, as before, whatever record is left there", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => first.close());
  // A process that is gone, for a record left by a server that died as it stopped.
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => gone.once("exit", resolve));
  const marks = [
    ["no record", undefined],
    ["the running server's own record", { pid: process.pid, until: null }],
    ["a record whose time has passed", { pid: process.pid, until: Date.now() - 1 }],
    ["a record whose process is gone", { pid: gone.pid, until: Date.now() + 60_000 }],
    ["a record that is not JSON", "{"],
  ];
  for (const [what, mark] of marks) {
    if (mark === undefined) await rm(join(data, STATE), { force: true });
    else writeFileSync(join(data, STATE), typeof mark === "string" ? mark : JSON.stringify(mark));
    const said = [];
    await assert.rejects(startServe({ data, port: 0, faux: FAUX, notice: (line) => said.push(line) }), (error) => error instanceof StoreOwned && error.message === refusal(data), what);
    assert.deepEqual(said, [], `${what}: refused, not waited on`);
  }
  // The server that runs is untouched.
  assert.equal((await client(first.baseUrl, first.token)("GET", "/agents")).status, 200);
});

test("a stop adds no entry to the data root: a caller that removes it as soon as it signals the stop meets nothing new there", { timeout: 120_000 }, async (t) => {
  // The CLI's tests and the published-server check send SIGTERM, then remove the data directory at once: an entry made
  // while the server stops lands between that removal's read of the directory and its rmdir (ENOTEMPTY).
  const data = join(await scratch(t), "agents");
  const { close } = await midTurn(t, data);
  const before = entries(data);
  const closing = close();
  const stopping = entries(data);
  await closing;
  const after = entries(data);
  assert.deepEqual(stopping.filter((name) => !before.includes(name)), [], "an entry made as the stop began");
  assert.deepEqual(after.filter((name) => !before.includes(name)), [], "an entry made while the server stopped");
});

test("a start waits as long as the stopping server's close runs, past its runs' drain: a carry back the store holds, then it starts", { timeout: 120_000 }, async (t) => {
  // Greptile P1: close() waits on what its runner lets go (its store handle's close here, held by the test as the agent
  // store was), which can outlast the runs' drain by more than any fixed margin. A start meanwhile must wait, not be refused.
  const data = join(await scratch(t), "agents");
  const { server: first, beside } = await serverAndRunner(t, data, { drainTimeout: "2s" }, 2_000);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let closed;
  const close = () => (closed ??= stopBeside(first, { held: () => beside.runner.held(), close: async () => (await held, await beside.close()) }, { data, drainMs: 2_000 }));
  t.after(() => (release(), close()));
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const run = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await until(async () => (await api("GET", `/runs/${run.body.run_id}`)).body.status === "completed", "the run answers");
  const began = Date.now();
  const closing = close();
  let refused;
  const said = [];
  const starting = startServe({ data, port: 0, faux: FAUX, notice: (line) => said.push(line) }).then(
    (next) => (t.after(() => next.close()), next),
    (error) => void (refused = error),
  );
  // Past the runs' own bound (their 2 s drain and a second, none here: the run is done) and 10 s more: a close
  // this slow is still one stop, and the start keeps waiting.
  await until(() => refused !== undefined || Date.now() - began > 3_000 + 12_000, "the hold", 60_000);
  assert.equal(refused, undefined, `the start was refused while the first server still closed: ${refused?.message}`);
  release();
  await closing;
  const next = await starting;
  assert.ok(next, `the start: ${refused?.message}`);
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.equal((await client(next.baseUrl, next.token)("GET", `/runs/${run.body.run_id}`)).body.status, "completed");
});

test("a notice that throws never stops a close: the listener, the runs' processes and the data root are all let go", { timeout: 120_000 }, async (t) => {
  // Greptile P2: the stopping line is best-effort; a close that rejected on it would keep the lock and the port.
  const data = join(await scratch(t), "agents");
  // The notice throws once: the test's own last close (below) still lets go of a server whose first close stopped there.
  let thrown = false;
  const notice = () => {
    if (thrown) return;
    thrown = true;
    throw new Error("the notice failed");
  };
  const { close, runner, first, runId } = await midTurn(t, data, { notice });
  t.after(() => first.close().catch(() => undefined));
  // Bounded: a close that stops at the notice fails here by name, never as the file's timeout.
  let timer;
  const bound = new Promise((resolve) => (timer = setTimeout(() => resolve("still closing after 20 s"), 20_000)));
  const outcome = await Promise.race([close().then(() => "closed", (error) => `rejected: ${error.message}`), bound]);
  clearTimeout(timer);
  assert.equal(outcome, "closed", "the close finished though a notice threw");
  assert.deepEqual(runner.held(), [], "the runner let the run go");
  await assert.rejects(fetch(`${first.baseUrl}/health`), "the listener is closed");
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "3s" });
  const nextRunner = await startRunnerBeside(data, { faux: FAUX });
  let nextClosed;
  const closeNext = () => (nextClosed ??= nextRunner.close().then(() => next.close()));
  t.after(closeNext);
  const api = client(next.baseUrl, next.token);
  assert.equal((await api("GET", "/agents")).status, 200, "the data root is free");
  // The next server opens the run the stop cut again. It is ended, and that server closed, here in the test: node:test
  // runs a test's after hooks in the order they were added, the data root's removal first, so a server still serving a
  // run there would write under it (ENOTEMPTY). The hook stays as a backstop.
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  await follow(api, runId, ["cancelled"], { deadlineMs: 60_000 });
  await closeNext();
});

test("a second close of a stopped server changes nothing: the next server's record stays, and a start beside it is refused at once", { timeout: 120_000 }, async (t) => {
  // Greptile P2: a close called again after the replacement started rewrote the replacement's record as stopping, so a
  // later start waited out that record (its pid, this process, alive) before it was refused.
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX });
  await first.close();
  const next = await startServe({ data, port: 0, faux: FAUX });
  let nextClosed;
  const closeNext = () => (nextClosed ??= next.close());
  t.after(closeNext);
  const record = readFileSync(join(data, STATE), "utf8");
  await first.close();
  assert.equal(readFileSync(join(data, STATE), "utf8"), record, "the next server's record is left as it was");
  const said = [];
  await assert.rejects(startServe({ data, port: 0, faux: FAUX, notice: (line) => said.push(line) }), (error) => error instanceof StoreOwned && error.message === refusal(data));
  assert.deepEqual(said, [], "refused at once, not waited on");
  await closeNext();
});
