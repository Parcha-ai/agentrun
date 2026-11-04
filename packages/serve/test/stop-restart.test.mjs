// A server's stop and the next start on its data root (server-lock.ts). A stop keeps the data root until its runs'
// processes have drained and exited (up to their drain and a second), and the API answers meanwhile. The stopping server
// says how long it waits and for how many runs; a start in that window waits for it, saying whom it waits for and for how
// long, then starts and opens the cut run again. A start on a root whose server runs, and is not stopping, is refused at
// once, as before.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { ServerLockHeldError, startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch } from "./support.mjs";

const alive = processAlive;
const STATE = "server.state";
const refusal = (data) => `another server holds this data root (${join(data, "server.lock")}): stop it, or start this one with another --data`;

/** Until `check()` holds, for at most `ms`, read every 50 ms: a state the test waits on, named `what`. */
async function until(check, what, ms = 60_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 50))) {
    assert.ok(Date.now() < end, `${what} (not in ${ms} ms)`);
  }
}

/** A server on `data` (with `options` for its start) whose one run is mid-turn: it wrote a file, and its next model
 *  request has started (the faux model makes `signal` as it does) and answers only after a minute, so a stop's 3 s drain
 *  cuts it. The signal is removed once read, so the run's next start of that request makes it again. */
async function midTurn(t, data, options = {}) {
  const said = [];
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "3s", notice: (line) => said.push(line), ...options });
  let closed;
  const close = () => (closed ??= first.close());
  t.after(close);
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("POST", "/agents", agent("slow"))).status, 201);
  const signal = join(await scratch(t), "asked");
  const run = await api("POST", "/agents/slow/runs", { input: { content: `Write a file, then signal ${signal} and wait.` } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await until(() => existsSync(signal), "the run's second request started");
  await rm(signal);
  const pid = JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8")).holder.pid;
  assert.ok(alive(pid), "the run's process works");
  t.after(() => alive(pid) && process.kill(pid, "SIGKILL"));
  return { close, runId, pid, signal, said, first };
}

/** The data root's own entries, by name. */
const entries = (data) => readdirSync(data).sort();

test("a start on a data root whose server is stopping waits for that stop, says so, then starts and opens the cut run again", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const { close, runId, pid, signal, said: stopSaid } = await midTurn(t, data);
  const closing = close();
  // The record says stopping as the close begins, before it waits on anything: read here, checked once the start is through.
  const mark = existsSync(join(data, STATE)) ? JSON.parse(readFileSync(join(data, STATE), "utf8")) : undefined;
  const markedAt = Date.now();
  let stopped = false;
  let goneAtStop;
  void closing.then(() => {
    stopped = true;
    goneAtStop = !alive(pid);
  });
  const said = [];
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "3s", notice: (line) => said.push(line) });
  t.after(() => next.close());
  // The stopping server said, as its close began, how long it waits and for how many runs: its run's 3 s drain and a second.
  assert.deepEqual(stopSaid, ["stopping: waiting up to 4 s for 1 run to finish its turn"]);
  assert.equal(mark?.pid, process.pid, `the stopping server's mark: ${JSON.stringify(mark)}`);
  assert.ok(mark.until > markedAt, JSON.stringify(mark));
  assert.equal(stopped, true, "the start went on only once the stopping server was done");
  assert.equal(goneAtStop, true, "and that server was done only once its run's process was gone");
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0], new RegExp(`^the server on this data root \\(pid ${process.pid}\\) is stopping; waiting for it, up to \\d+ s$`));
  assert.deepEqual(JSON.parse(readFileSync(join(data, STATE), "utf8")), { pid: process.pid, until: null }, "the new server's record: it runs");
  // The new server opens the run its stop cut: the cut request starts again in a process of its own.
  await until(() => existsSync(signal), "the cut request started again under the new server");
  const record = JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8"));
  assert.ok(record.generation >= 2, `opened again on its directory: ${JSON.stringify(record.generation)}`);
  assert.notEqual(record.holder.pid, pid);
  t.after(() => alive(record.holder.pid) && process.kill(record.holder.pid, "SIGKILL"));
  const api = client(next.baseUrl, next.token);
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  await follow(api, runId, ["cancelled"], { deadlineMs: 60_000 });
});

test("a stop is over only once its runs' processes are gone: nothing of theirs runs after the server", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const { close, pid } = await midTurn(t, data);
  await close();
  assert.equal(alive(pid), false, "the run's process went before the server's stop ended");
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
    await assert.rejects(startServe({ data, port: 0, faux: FAUX, notice: (line) => said.push(line) }), (error) => error instanceof ServerLockHeldError && error.message === refusal(data), what);
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
  // Greptile P1: close() waits on its runs' carry backs (retried while the agent store is held) and their boxes' cleanup,
  // which can outlast the runs' drain by more than any fixed margin. A start meanwhile must wait, not be refused.
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "2s", carryBackRetry: { delaysMs: Array(60).fill(1_000) } });
  let closed;
  const close = () => (closed ??= first.close());
  t.after(close);
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const run = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  // Then another writer holds the agent store (the start writes it, so not before), and the run's carry back waits: it
  // reads completed before its end is written.
  const store = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  t.after(() => store.isOpen && store.close());
  store.exec("BEGIN IMMEDIATE");
  await until(async () => (await api("GET", `/runs/${run.body.run_id}`)).body.status === "completed", "the run answers");
  const began = Date.now();
  const closing = close();
  let refused;
  const said = [];
  const starting = startServe({ data, port: 0, faux: FAUX, notice: (line) => said.push(line) }).then(
    (next) => (t.after(() => next.close()), next),
    (error) => void (refused = error),
  );
  // Past the runs' own bound (their 2 s drain and a second, none here: the run's process is gone) and 10 s more: a close
  // this slow is still one stop, and the start keeps waiting.
  await until(() => refused !== undefined || Date.now() - began > 3_000 + 12_000, "the hold", 60_000);
  assert.equal(refused, undefined, `the start was refused while the first server still closed: ${refused?.message}`);
  store.exec("ROLLBACK");
  store.close();
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
  const { close, pid, first, runId } = await midTurn(t, data, { notice });
  t.after(() => first.close().catch(() => undefined));
  // Bounded: a close that stops at the notice fails here by name, never as the file's timeout.
  let timer;
  const bound = new Promise((resolve) => (timer = setTimeout(() => resolve("still closing after 20 s"), 20_000)));
  const outcome = await Promise.race([close().then(() => "closed", (error) => `rejected: ${error.message}`), bound]);
  clearTimeout(timer);
  assert.equal(outcome, "closed", "the close finished though a notice threw");
  assert.equal(alive(pid), false, "the run's process is gone");
  await assert.rejects(fetch(`${first.baseUrl}/health`), "the listener is closed");
  const next = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "3s" });
  let nextClosed;
  const closeNext = () => (nextClosed ??= next.close());
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
