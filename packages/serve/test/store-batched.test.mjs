// A runner holds many runs, and its periodic store traffic is per runner, never per run: one read of every held run's new
// command rows a tick (commandsOf), and one transaction renewing every held claim (renewMany), as run_live's write is one
// for all of them. A claim another runner took is answered Fenced on its own; the others renew in the same transaction.
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { test } from "node:test";
import { Fenced, openPostgresStore } from "../dist/store/index.js";
import { queued, storeOn } from "./store-helpers.mjs";
import { PG_URL, postgresOnly, schemaOf } from "./store-target.mjs";

/** Each way of the link to the test Postgres in the far tests: a database a few ms away, as a loaded host's is. */
const LINK_MS = 5;
/** Runs a runner holds by default (runner.ts RUNNER_LOOPS). */
const HELD = 300;

/** A loopback link to the test Postgres that holds every chunk `ms` each way before it passes it on: each round trip
 *  costs at least 2 × `ms`, whatever the database's own speed. Its URL; it and its connections close after the test. */
async function farLink(t, ms) {
  const target = new URL(PG_URL);
  const sockets = new Set();
  const server = createServer((socket) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    for (const [from, to] of [[socket, upstream], [upstream, socket]]) {
      sockets.add(from);
      from.setNoDelay(true);
      from.on("error", () => undefined);
      // Timers of one length fire in the order they were set: the chunks keep their order.
      from.on("data", (chunk) => setTimeout(() => to.writable && to.write(chunk), ms));
      from.on("close", () => setTimeout(() => to.destroy(), ms));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(PG_URL);
  url.host = `127.0.0.1:${server.address().port}`;
  return {
    url: url.toString(),
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

/** The server's store with `HELD` queued runs, and a runner's store on the same schema reached through a link `LINK_MS`
 *  each way, its pool's first connection already made (so what is timed is the store's statements, not a connect). */
async function farRunner(t) {
  const { store, file, clock } = await storeOn(t);
  for (let i = 0; i < HELD; i++) await queued(store, `run-${String(i).padStart(3, "0")}`);
  const link = await farLink(t, LINK_MS);
  const runner = await openPostgresStore({ url: link.url, schema: schemaOf(file), role: "runner", testClock: () => clock.now });
  t.after(async () => {
    await runner.close();
    await link.close();
  });
  await runner.runs.get("run-000");
  return { store, runner, clock };
}

test("commandsOf reads each run's command rows after its own cursor, every run in one read", async (t) => {
  const { store } = await storeOn(t);
  for (const id of ["run-1", "run-2", "run-3"]) await queued(store, id);
  const a1 = await store.command("run-1", { kind: "steer", body: { content: "a1" } });
  const b1 = await store.command("run-2", { kind: "steer", body: { content: "b1" } });
  const a2 = await store.command("run-1", { kind: "steer", body: { content: "a2" } });
  const reads = [];
  const all = store.commands.bind(store);
  store.commands = (...args) => (reads.push(args), all(...args));
  const rows = await store.commandsOf([{ runId: "run-1", after: a1.id }, { runId: "run-2", after: 0 }, { runId: "run-3", after: 0 }]);
  assert.deepEqual(rows.get("run-1")?.map((row) => row.id), [a2.id], "run-1 after its cursor");
  assert.deepEqual(rows.get("run-2")?.map((row) => row.id), [b1.id]);
  assert.deepEqual(rows.get("run-3") ?? [], []);
  assert.equal(reads.length, 0, "never a read per run");
});

test("renewMany renews every held claim in one transaction, and answers a fenced one Fenced while the others renew", async (t) => {
  const { store, clock } = await storeOn(t);
  for (const id of ["run-1", "run-2", "run-3"]) await queued(store, id);
  const claims = [];
  // run-2's lease is the short one: run-1's and run-3's still hold when the renew comes (one that ran out is refused).
  for (const id of ["run-1", "run-2", "run-3"]) claims.push(await store.claim(id, "runner-a", { leaseMs: id === "run-2" ? 1_000 : 60_000 }));
  // run-2's claim runs out and another runner takes it.
  clock.now += 1_001;
  await store.claim("run-2", "runner-b", { leaseMs: 60_000 });
  const results = await store.renewMany(claims, { leaseMs: 30_000 });
  assert.equal(results.length, 3);
  assert.equal(results[0].until, clock.now + 30_000, "run-1 renewed");
  assert.ok(results[1] instanceof Fenced && results[1].runId === "run-2", `run-2 answered Fenced: ${results[1]}`);
  assert.equal(results[2].until, clock.now + 30_000, "run-3 renewed beside it");
  assert.equal((await store.runs.get("run-2")).runner, "runner-b", "nothing written to the fenced run");
});

// A runner's claim of a full batch and its renew of everything it holds are each a few round trips to the database, never
// one or two a run: with the database 5 ms away each way (a round trip of 10 ms or more), one a run is at least 3 s for
// 300, and a renew's round trips add up to the runner's claim deadline (its lease less its margin) as the database slows.
// A renew that outlasts that deadline loses every claim at once, and the runs it held are claimed again and started over.
// Bound: the time of 150 round trips, half of one a run.
const FAR_BOUND_MS = 150 * 2 * LINK_MS;

test(`on a database ${LINK_MS} ms away each way, a claim of ${HELD} runs is a few round trips, never one a run`, postgresOnly("a database a link away"), async (t) => {
  const { store, runner } = await farRunner(t);
  const started = Date.now();
  const claims = await runner.runs.claimMany("runner-a", HELD, { leaseMs: 10_000 });
  const claimMs = Date.now() - started;
  assert.equal(claims.length, HELD, "every queued run claimed");
  assert.ok(claimMs < FAR_BOUND_MS, `the claim of ${HELD} took ${claimMs} ms (bound ${FAR_BOUND_MS} ms)`);
  assert.ok((await store.runs.list({ state: "running" })).every((run) => run.runner === "runner-a"), "each held by the runner");
});

test(`on a database ${LINK_MS} ms away each way, a renew of ${HELD} claims is a few round trips, never one a claim, and a fenced one is answered Fenced beside the others`, postgresOnly("a database a link away"), async (t) => {
  const { store, runner, clock } = await farRunner(t);
  const claims = await store.runs.claimMany("runner-a", HELD, { leaseMs: 10_000 });
  assert.equal(claims.length, HELD, "every queued run claimed");
  // One of them let go and taken by another runner: the renew answers its old claim Fenced, the others renewed beside it.
  await store.release(claims.find((claim) => claim.runId === "run-007"));
  assert.ok(await store.claim("run-007", "runner-b", { leaseMs: 60_000 }), "runner-b took run-007");
  const started = Date.now();
  const renewed = await runner.renewMany(claims, { leaseMs: 30_000 });
  const renewMs = Date.now() - started;
  assert.ok(renewMs < FAR_BOUND_MS, `the renew of ${HELD} claims took ${renewMs} ms (bound ${FAR_BOUND_MS} ms)`);
  assert.equal(renewed.length, HELD);
  for (const [i, result] of renewed.entries()) {
    if (claims[i].runId === "run-007") assert.ok(result instanceof Fenced, `run-007, taken by another runner, answered Fenced: ${result}`);
    else assert.equal(result.until, clock.now + 30_000, `${claims[i].runId} renewed`);
  }
  assert.equal((await store.runs.get("run-007")).runner, "runner-b", "nothing written to the fenced run");
});
