// A command written for a held run reaches its loop at once, not at the runner's next command poll: with commandPollMs at
// ten seconds, the row is in the loop's command() well inside 100 ms, and a row written while a delivery is in flight is
// handed on by the one more delivery that follows it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxLoops, queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";
import { client, postgresOnly, schemaOf } from "./store-target.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 10_000 };

test("a row written for a held run reaches its loop's command() in under 100 ms with the command poll at ten seconds", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  const runner = startRunner({ store: opened.runners[0], createLoop: faux.createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(() => faux.loops[0]?.claim !== null && faux.loops[0] !== undefined, "the run is held and its loop started");
  const loop = faux.loops[0];
  const wrote = Date.now();
  const row = await opened.server.command("run-1", { kind: "steer", body: { content: "now" } });
  await until(() => loop.received.some((one) => one.id === row.id), "the row reaches the loop", 2_000);
  const ms = loop.received.find((one) => one.id === row.id).at - wrote;
  console.log(`runner wake: a row written for a held run reached its loop's command() in ${ms} ms (commandPollMs 10000)`);
  assert.ok(ms < 100, `${ms} ms`);
});

test("rows written one after another while deliveries are in flight all reach the loop before the next poll", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  const runner = startRunner({ store: opened.runners[0], createLoop: faux.createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(() => faux.loops[0]?.claim !== null && faux.loops[0] !== undefined, "the run is held and its loop started");
  const loop = faux.loops[0];
  const rows = await Promise.all([1, 2, 3, 4, 5].map((n) => opened.server.command("run-1", { kind: "steer", body: { content: `m${n}` } })));
  await until(() => rows.every((row) => loop.received.some((one) => one.id === row.id)), "every row reaches the loop", 2_000);
  assert.deepEqual(loop.received.map((one) => one.id), [...loop.received.map((one) => one.id)].sort((a, b) => a - b), "in id order, each once");
  assert.equal(new Set(loop.received.map((one) => one.id)).size, loop.received.length);
});

// On Postgres a row's id is taken at its insert and the row is seen at its commit. Two commands of one run written at once
// could commit out of id order, and the runner, which reads the rows past the last id it handed on, would then never see
// the lower one. Here the first command is held after its insert (another session holds the run's launch row, which a
// command with launch secrets updates in the same transaction), and the second is written meanwhile.
test("a command written while an earlier one of its run is in flight waits for its commit: both reach the loop, in id order, before the next poll", postgresOnly("SQLite's one writer commits in id order"), async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const faux = fauxLoops({ turns: 1_000, turnMs: 20 });
  const runner = startRunner({ store: opened.runners[0], createLoop: faux.createLoop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(() => faux.loops[0]?.claim !== null && faux.loops[0] !== undefined, "the run is held and its loop started");
  const loop = faux.loops[0];
  const holder = await client(schemaOf(opened.file));
  t.after(() => holder.end().catch(() => undefined));
  const watcher = await client();
  t.after(() => watcher.end().catch(() => undefined));
  const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  // queue() writes no launch row: one to hold, written now that the run is claimed.
  await holder.query("INSERT INTO run_launch (run_id, body, sealed, created_at) VALUES ('run-1', 'null', NULL, 0)");
  await holder.query("BEGIN");
  await holder.query("SELECT 1 FROM run_launch WHERE run_id = 'run-1' FOR UPDATE");
  // Sessions held up by the holder, or by a session it holds up.
  const blocked = async () =>
    (await watcher.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity w WHERE $1 = ANY(pg_blocking_pids(w.pid))
         OR EXISTS (SELECT 1 FROM pg_stat_activity f WHERE $1 = ANY(pg_blocking_pids(f.pid)) AND f.pid = ANY(pg_blocking_pids(w.pid)))`,
      [pid],
    )).rows[0].n;
  const first = opened.server.command("run-1", { kind: "steer", body: { content: "first" } }, { launchSealed: new Uint8Array([1]) });
  await until(async () => (await blocked()) === 1, "the first command is held after its insert");
  let second;
  const secondDone = opened.server.command("run-1", { kind: "steer", body: { content: "second" } }).then((row) => (second = row));
  // The second either waits behind the first or commits past it, and is then handed on to the loop.
  await until(async () => (second !== undefined && loop.received.some((one) => one.id === second.id)) || (await blocked()) === 2, "the second command waits or is handed on");
  await holder.query("COMMIT");
  const [row1, row2] = [await first, await secondDone];
  assert.ok(row1.id < row2.id, `the first insert took the lower id: ${row1.id}, ${row2.id}`);
  await until(() => [row1, row2].every((row) => loop.received.some((one) => one.id === row.id)), "both rows reach the loop", 2_000);
  assert.deepEqual(loop.received.map((one) => one.id), [row1.id, row2.id], "in id order, each once");
});
