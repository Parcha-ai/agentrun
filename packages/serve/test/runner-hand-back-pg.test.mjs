// The runner split's hand-back on Postgres, with real processes: an API-only server (`--no-runner`) and two runner
// processes (`agentrun-serve runner`) on one Postgres schema, the model a script (fixtures/faux-hand-back.mjs: no key, no
// network). Each run's turn holds on a file the test writes, so a signal always lands mid-turn. In every case each run
// ends once, completed, with one answer: 0 lost, 0 duplicated.
//   - SIGTERM one runner mid-turn, its drain shorter than the turn: it hands its runs back at once, and the other runner
//     claims each and ends it. The cut turn's model request is asked again there, once.
//   - SIGKILL one runner mid-turn: nothing hands the runs back; the other runner claims each once its lease lapses, and a
//     write under the dead runner's epoch is refused (Fenced).
//   - SIGSTOP one runner mid-turn past its lease, then SIGCONT: the other runner has the runs, and the woken runner's late
//     writes never land: it loses its claims, and each run ends once, on the other runner.
//   - Postgres goes away mid-run for longer than a lease (every connection cut, new ones refused: a restart, as its
//     clients see it), then comes back: every run ends.
//   - A drain longer than the turn: SIGTERM mid-turn lets the turn finish on the same runner, with no hand-back, and the
//     runner claims nothing new meanwhile.
// Runs only on Postgres (AGENTRUN_TEST_PG_URL; `npm run test:pg`), as CI's Postgres job runs it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agent, client, follow, printed, scratch } from "./support.mjs";
import { connectionsLeft, dropSchema, freshSchema, PG_URL, postgresOnly, raw } from "./store-target.mjs";

const { openPostgresStore, Fenced } = await import("../dist/store/index.js");
const { runnerArgs, runnerHolds } = await import("../dist/runner/main.js");

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FAUX = new URL("./fixtures/faux-hand-back.mjs", import.meta.url).pathname;
const TOKEN = `ar_test_${"h".repeat(40)}`;
const SEAL = Buffer.alloc(32, 7).toString("base64");
/** Runs per case: more than one, so "every run" is a count. */
const RUNS = 3;
/** The runner's lease (runner.ts RUNNER_LEASE_MS): a run whose runner died is claimable once it lapses. */
const LEASE_MS = 30_000;
const PG = postgresOnly("two runner processes on one Postgres schema");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await sleep(50);
  }
}
const linesOf = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

/** A loopback link to the test Postgres that a test can take down and bring back on the same port: down() ends every
 *  connection through it and refuses new ones, as a Postgres restart looks to its clients; up() listens again. */
async function pgLink() {
  const target = new URL(PG_URL);
  const sockets = new Set();
  let server;
  let port = 0;
  const listen = () => new Promise((resolve, reject) => {
    server = createServer((socket) => {
      const upstream = connect(Number(target.port || 5432), target.hostname);
      for (const [from, to] of [[socket, upstream], [upstream, socket]]) {
        sockets.add(from);
        from.on("error", () => undefined);
        from.on("close", () => (sockets.delete(from), to.destroy()));
        from.pipe(to);
      }
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => ((port = server.address().port), resolve()));
  });
  await listen();
  const url = new URL(PG_URL);
  url.host = `127.0.0.1:${port}`;
  const down = () => new Promise((resolve) => {
    server.close(() => resolve());
    for (const socket of sockets) socket.destroy();
  });
  return { url: url.toString(), down, up: listen, close: down };
}

/** One deployment on a fresh schema: the API-only server, and `runner(name, args)` to start a runner process on it. The
 *  store URL is `storeUrl(PG_URL)` for every process (a link a test can cut). Stops every process before the schema goes. */
async function deployment(t, { storeUrl = PG_URL } = {}) {
  const schema = await freshSchema();
  const root = await scratch(t);
  const data = join(root, "agents");
  const children = [];
  t.after(async () => {
    for (const child of [...children].reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(60_000).then(() => child.kill("SIGKILL"))]);
    }
    assert.deepEqual(await connectionsLeft([schema]), [], "every process has exited before the schema goes");
    await dropSchema(schema);
  });
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    TMPDIR: process.env.TMPDIR ?? root,
    AGENTRUN_ACCOUNTS: "0",
    AGENTRUN_TOKEN: TOKEN,
    AGENTRUN_SEAL_KEY: SEAL,
    AGENTRUN_STORE_URL: storeUrl,
    AGENTRUN_STORE_SCHEMA: schema,
  };
  const spawned = (args, extra = {}) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const out = [];
    const err = [];
    createInterface({ input: child.stdout }).on("line", (line) => out.push(line));
    createInterface({ input: child.stderr }).on("line", (line) => err.push(line));
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal ?? code)));
    return { child, out, err, exited, said: () => [...out, ...err].join("\n") };
  };
  const server = spawned(["--data", data, "--port", "0", "--faux", FAUX, "--no-runner"]);
  const port = Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(await printed(server.child, /^Open /m))[1]);
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);
  assert.equal((await api("POST", "/agents", agent("held", { place: { mode: "runner" } }))).status, 201);
  /** A runner process named `name`, ready (its ready line said) before this resolves. */
  const runner = async (name, args = []) => {
    const proc = spawned(["runner", "--data", data, "--faux", FAUX, "--loops", String(RUNS + 1), ...args], { AGENTRUN_RUNNER_NAME: name });
    await until(() => proc.out.some((line) => line.startsWith(`Runner ${name} ready: store postgres `)) || proc.child.exitCode !== null, `${name} ready`);
    assert.equal(proc.child.exitCode, null, `${name} is up: ${proc.said()}`);
    return Object.assign(proc, { name, claimed: (runId) => proc.out.some((line) => line.startsWith(`Runner ${name} claimed ${runId} `)) });
  };
  /** `RUNS` runs that each hold their turn until their go file exists, each request noted in their log. */
  const start = async (count = RUNS) => {
    const runs = [];
    for (let i = 0; i < count; i++) {
      const word = `w${runs.length}-${Math.random().toString(36).slice(2, 8)}`;
      const go = join(root, `${word}.go`);
      const log = join(root, `${word}.log`);
      const made = await api("POST", "/agents/held/runs", { input: { content: `Answer ${word} once ${go} exists; log requests in ${log}.` } });
      assert.equal(made.status, 202, JSON.stringify(made.body));
      runs.push({ id: made.body.run_id, word, go, log, requests: () => linesOf(log).length });
    }
    return runs;
  };
  /** The run's row as the store holds it. */
  const row = async (runId) => {
    const db = await raw(`pg:${schema}`, { readOnly: true });
    try {
      return await db.get("SELECT id, state, epoch, runner FROM runs WHERE id = ?", runId);
    } finally {
      await db.close();
    }
  };
  /** Each run followed to its end: its status, and how many final answers it has (one: no duplicate). */
  const ended = async (runs, deadlineMs = 90_000) => {
    const ends = [];
    for (const run of runs) {
      const { last, rows } = await follow(api, run.id, ["completed", "failed", "cancelled"], { deadlineMs });
      const answers = rows.filter((r) => r.kind === "final_answer").map((r) => r.text ?? r.summary);
      ends.push({ id: run.id, status: last.status, answers });
    }
    return ends;
  };
  return { schema, root, data, api, server, runner, start, row, ended };
}

/** Every run completed with exactly its one answer: 0 lost, 0 duplicated. */
function oneAnswerEach(ends, runs, context) {
  assert.deepEqual(ends.map((end) => [end.status, end.answers]), runs.map((run) => ["completed", [`Answer ${run.word}.`]]), `every run ends once, with one answer: ${context()}`);
}

test("SIGTERM one runner mid-turn (drain shorter than the turn): it hands each run back at once and exits 0; the other runner claims each and ends it; 0 lost, 0 duplicated", { ...PG, timeout: 300_000 }, async (t) => {
  const d = await deployment(t);
  const r1 = await d.runner("r1", ["--drain-timeout", "1s"]);
  const runs = await d.start();
  await until(() => runs.every((run) => run.requests() === 1 && r1.claimed(run.id)), "every run mid-turn on r1");
  const r2 = await d.runner("r2", ["--drain-timeout", "1s"]);
  const signalled = Date.now();
  r1.child.kill("SIGTERM");
  assert.equal(await r1.exited, 0, `r1 exits 0 after handing back: ${r1.said()}`);
  for (const run of runs) assert.ok(r1.out.includes(`Runner r1 released ${run.id} (interrupted)`), `r1 handed ${run.id} back: ${r1.said()}`);
  await until(() => runs.every((run) => r2.claimed(run.id) && run.requests() === 2), "r2 claimed every run and asked its turn again", 30_000);
  const movedMs = Date.now() - signalled;
  assert.ok(movedMs < LEASE_MS, `handed back at once, never left to the lease: ${movedMs} ms`);
  for (const run of runs) writeFileSync(run.go, "");
  const ends = await d.ended(runs);
  oneAnswerEach(ends, runs, () => `${r1.said()}\n${r2.said()}`);
  for (const run of runs) {
    assert.deepEqual(await d.row(run.id), { id: run.id, state: "ended", epoch: 4, runner: null }, "claimed by r1 (1), released (2), claimed by r2 (3), ended (4)");
    assert.equal(run.requests(), 2, "the cut turn's request was asked once more, on r2, and no more");
  }
});

test("SIGKILL one runner mid-turn: each run moves to the other runner once its lease lapses, a write under the dead runner's epoch is refused (Fenced), and every run ends once", { ...PG, timeout: 300_000 }, async (t) => {
  const d = await deployment(t);
  const r1 = await d.runner("r1");
  const runs = await d.start();
  await until(() => runs.every((run) => run.requests() === 1 && r1.claimed(run.id)), "every run mid-turn on r1");
  const r2 = await d.runner("r2");
  const killed = Date.now();
  r1.child.kill("SIGKILL");
  assert.equal(await r1.exited, "SIGKILL");
  await until(() => runs.every((run) => r2.claimed(run.id)), "r2 claimed every run", LEASE_MS + 30_000);
  const movedMs = Date.now() - killed;
  assert.ok(movedMs >= LEASE_MS - 10_000, `the runs moved only once r1's lease had lapsed (it renews every 10 s, so at least 20 s on): ${movedMs} ms`);
  for (const run of runs) {
    const now = await d.row(run.id);
    assert.deepEqual([now.epoch, now.runner], [2, "r2"], "r2's claim is the next epoch: r1 released nothing");
    assert.ok(r2.out.includes(`Runner r2 claimed ${run.id} (epoch 2)`), r2.said());
  }
  // r1's claim, epoch 1, as a write it had in flight would carry it: the store refuses it, and the run is as r2 holds it.
  const late = await openPostgresStore({ url: PG_URL, schema: d.schema, role: "runner" });
  t.after(() => late.close());
  for (const run of runs) {
    const stale = { runId: run.id, runner: "r1", epoch: 1, until: killed + LEASE_MS, from: "queued" };
    await assert.rejects(late.runs.update(stale, { state: "ended", summary: "a late write" }), Fenced, "a run update under epoch 1");
    await assert.rejects(commitWrites(late.journal(stale), [{ type: "conversation", value: { id: 99 } }], BACKGROUND_CONTEXT), Fenced, "and a journal commit under epoch 1");
  }
  await late.close();
  await until(() => runs.every((run) => run.requests() === 2), "r2 asked each cut turn again", 30_000);
  for (const run of runs) writeFileSync(run.go, "");
  const ends = await d.ended(runs);
  oneAnswerEach(ends, runs, () => `${r1.said()}\n${r2.said()}`);
  for (const run of runs) assert.deepEqual(await d.row(run.id), { id: run.id, state: "ended", epoch: 3, runner: null }, "claimed by r1 (1), by r2 (2), ended (3)");
});

test("a runner frozen mid-turn past its lease (SIGSTOP) and then woken (SIGCONT): the other runner has its runs, the woken runner's late writes never land, and every run ends once", { ...PG, timeout: 300_000 }, async (t) => {
  const d = await deployment(t);
  const r1 = await d.runner("r1");
  const runs = await d.start();
  await until(() => runs.every((run) => run.requests() === 1 && r1.claimed(run.id)), "every run mid-turn on r1");
  const r2 = await d.runner("r2");
  r1.child.kill("SIGSTOP");
  await until(() => runs.every((run) => r2.claimed(run.id) && run.requests() === 2), "r2 claimed every run and asked its turn again", LEASE_MS + 30_000);
  // r1's own turns may answer now (their go files exist), and r1 wakes up with them: whatever it writes is under epoch 1.
  for (const run of runs) writeFileSync(run.go, "");
  r1.child.kill("SIGCONT");
  const ends = await d.ended(runs);
  oneAnswerEach(ends, runs, () => `${r1.said()}\n${r2.said()}`);
  await until(() => runs.every((run) => r1.out.concat(r1.err).some((line) => line.includes(`Runner r1 lost its claim on ${run.id}`))), "r1 says it lost each claim", 30_000);
  for (const run of runs) {
    assert.deepEqual(await d.row(run.id), { id: run.id, state: "ended", epoch: 3, runner: null }, "the run's end is r2's: claimed by r1 (1), by r2 (2), ended (3)");
    assert.ok(!r1.out.includes(`Runner r1 released ${run.id} (ended)`), `r1 never ended ${run.id}: ${r1.said()}`);
  }
  assert.equal(r1.child.exitCode, null, "r1 goes on, claiming again");
});

test("Postgres goes away mid-run for longer than a lease (every connection cut, new ones refused), then comes back: every run ends once", { ...PG, timeout: 400_000 }, async (t) => {
  const link = await pgLink();
  const d = await deployment(t, { storeUrl: link.url });
  // After the deployment's own after-hook (node:test runs them in the order they were added): its processes stop first.
  t.after(() => link.close());
  const r1 = await d.runner("r1");
  const r2 = await d.runner("r2");
  const runs = await d.start();
  await until(() => runs.every((run) => run.requests() === 1 && (r1.claimed(run.id) || r2.claimed(run.id))), "every run mid-turn");
  await link.down();
  await sleep(LEASE_MS + 5_000);
  await link.up();
  // Every lease lapsed meanwhile: each run is claimed again, by either runner, and its turn asked again.
  await until(() => runs.every((run) => run.requests() >= 2), "every run's turn asked again after Postgres came back", 120_000);
  for (const run of runs) writeFileSync(run.go, "");
  const ends = await until(() => d.ended(runs, 120_000).catch(() => undefined), "every run read to its end through the server", 240_000);
  oneAnswerEach(ends, runs, () => `${d.server.said()}\n${r1.said()}\n${r2.said()}`);
  for (const run of runs) {
    const now = await d.row(run.id);
    assert.deepEqual([now.state, now.runner], ["ended", null], JSON.stringify(now));
    assert.ok(now.epoch >= 3, `claimed again after the outage: epoch ${now.epoch}`);
  }
  assert.equal(r1.child.exitCode, null, `r1 is still up: ${r1.said()}`);
  assert.equal(r2.child.exitCode, null, `r2 is still up: ${r2.said()}`);
});

test("a drain longer than the turn: SIGTERM mid-turn lets the turn finish on the same runner with no hand-back, the runner claims nothing new meanwhile, and it exits 0", { ...PG, timeout: 300_000 }, async (t) => {
  const d = await deployment(t);
  const r1 = await d.runner("r1", ["--drain-timeout", "2m"]);
  const runs = await d.start();
  await until(() => runs.every((run) => run.requests() === 1 && r1.claimed(run.id)), "every run mid-turn on r1");
  const r2 = await d.runner("r2");
  r1.child.kill("SIGTERM");
  // The drain is under way: a run started now goes to r2, never to the draining r1.
  await sleep(2_000);
  const [later] = await d.start(1);
  await until(() => r2.claimed(later.id) && later.requests() === 1, "r2 took the run started during the drain");
  assert.equal(r1.child.exitCode, null, "r1 is still draining");
  for (const run of [...runs, later]) writeFileSync(run.go, "");
  assert.equal(await r1.exited, 0, `r1 exits 0 once its turns finished: ${r1.said()}`);
  const ends = await d.ended([...runs, later]);
  oneAnswerEach(ends, [...runs, later], () => `${r1.said()}\n${r2.said()}`);
  for (const run of runs) {
    assert.deepEqual(await d.row(run.id), { id: run.id, state: "ended", epoch: 2, runner: null }, "claimed by r1 (1), ended there (2): never handed back");
    assert.equal(run.requests(), 1, "its turn's request was asked once: never cut and asked again");
    assert.ok(!r2.claimed(run.id), "r2 never claimed it");
  }
  assert.ok(!r1.claimed(later.id), "the draining r1 claimed nothing new");
});

test("a runner's drain is set in minutes: --drain-timeout 15m, or AGENTRUN_DRAIN_TIMEOUT=15m when the flag gives none", () => {
  assert.equal(runnerArgs(["--data", "/d", "--drain-timeout", "15m"]).drainMs, 900_000);
  assert.equal(runnerHolds({ loops: 1 }, { AGENTRUN_DRAIN_TIMEOUT: "15m" }).drainMs, 900_000);
  assert.equal(runnerHolds({ loops: 1, drainMs: 600_000 }, { AGENTRUN_DRAIN_TIMEOUT: "15m" }).drainMs, 600_000, "the flag wins");
});
