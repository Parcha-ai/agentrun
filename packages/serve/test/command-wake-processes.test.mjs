// The command wake across processes (store/command-wake.ts): a write in one process wakes the readers in another, on
// SQLite through the wake file beside the store's file, on Postgres through NOTIFY and LISTEN.
//   - a computer call's round trip, the server in this process and the runner in a child process on the same data, both
//     at their default polls (the runner's 500 ms, the server's 250 ms): its median is under 50 ms, which only the wakes
//     make it;
//   - on Postgres, a listening session the database ended connects again, and the round trips are as fast after it;
//   - two handles in one process hear each write once: the wire's echo of a write this process made is dropped;
//   - the wake file is emptied past WAKE_FILE_MAX, and a listener still hears what comes after.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPostgresStore, openSqliteStore } from "../dist/store/index.js";
import { heldRoute } from "../dist/computer-held-routes.js";
import { WAKE_FILE_MAX, WakeFile } from "../dist/store/sqlite/wake-file.js";
import { client, dropSchema, freshSchema, onPostgres, PG_URL, postgresOnly, sqliteOnly } from "./store-target.mjs";
import { until } from "./runner-support.mjs";

const CALLS = 40;
const MEDIAN_MS = 50;

/** A server's store on a place of its own (a data directory, or a schema), and that place as the child runner opens it. */
async function serverStore(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-command-wake-"));
  const schema = onPostgres ? await freshSchema() : undefined;
  const store = schema === undefined ? await openSqliteStore({ dataDir: dir, role: "server" }) : await openPostgresStore({ url: PG_URL, schema, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    if (schema !== undefined) await dropSchema(schema);
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir, place: schema === undefined ? { dataDir: dir } : { schema } };
}

/** The child runner on `place`, started; answers its stop, which a hook calls too when the test did not get to it
 *  (node:test runs a test's after-hooks in the order they were added: the server's store closes first then). */
async function childRunner(t, place) {
  const child = fork(new URL("./command-wake-runner-support.mjs", import.meta.url), [JSON.stringify(place)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null && child.connected) child.send("stop");
    const late = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(late);
  };
  t.after(stop);
  await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", (code) => reject(new Error(`the child runner exited (${code}) before it was ready`)));
  });
  return stop;
}

/** A server store with run-1 running on a child runner, and its computer call at the server's default poll
 *  (CHANNEL_POLL_MS: only takeMs is the test's), its first call made. */
async function heldByChild(t) {
  const { store, place } = await serverStore(t);
  await store.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { computer: { kind: "desktop", provider: "e2b" } } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Work." }, title: "Work.", place: { mode: "runner" } } });
  const stopChild = await childRunner(t, place);
  await until(async () => (await store.runs.get("run-1")).state === "running", "the child runner holds the run", 15_000);
  const call = (method) => heldRoute("callRunComputer", "run-1", { method }, store, { takeMs: 10_000, context: BACKGROUND_CONTEXT });
  assert.deepEqual(await call("hello"), { ok: true, value: { method: "hello", params: {} } }, "the first call, answered by the child's computer");
  return { store, place, call, stopChild };
}

/** CALLS round trips of `call`, said and asserted: median under MEDIAN_MS. */
async function roundTrips(t, call, label) {
  const times = [];
  for (let i = 0; i < CALLS; i++) {
    const started = performance.now();
    assert.deepEqual(await call("ping"), { ok: true, value: { method: "ping", params: {} } });
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(CALLS / 2)];
  const p90 = times[Math.floor(CALLS * 0.9)];
  t.diagnostic(`${onPostgres ? "postgres" : "sqlite"} ${label}: n=${CALLS} min ${times[0].toFixed(1)} ms, median ${median.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms, max ${times.at(-1).toFixed(1)} ms`);
  assert.ok(median < MEDIAN_MS, `median ${median.toFixed(1)} ms, not under ${MEDIAN_MS} ms: ${times.map((ms) => ms.toFixed(0)).join(", ")}`);
}

test("a computer call's round trip to a runner in another process is under 50 ms median, at the default polls", async (t) => {
  const { call, stopChild } = await heldByChild(t);
  await roundTrips(t, call, "across processes");
  await stopChild();
});

test("a wake listener whose connection the database ended connects again, and the round trips are fast again", postgresOnly("NOTIFY and LISTEN"), async (t) => {
  const { place, call, stopChild } = await heldByChild(t);
  const admin = await client();
  t.after(() => admin.end());
  const ended = await admin.query("SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1) AS gone", [`agentrun-store-wake:${place.schema}`]);
  assert.equal(ended.rows[0].n, 2, "the server's and the child runner's listening sessions, ended");
  const listening = async () => (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1", [`agentrun-store-wake:${place.schema}`])).rows[0].n;
  await until(async () => (await listening()) === 0, "both gone", 10_000);
  // The child runner watches all along: it connects again on its own. The server watches per call: its next call does.
  await until(async () => (await listening()) === 1, "the runner listens again", 10_000);
  await roundTrips(t, call, "across processes, after the listeners connected again");
  assert.equal(await listening(), 2, "both listen again");
  await stopChild();
});

test("two handles in one process hear each write once: the wire's echo of this process's write is dropped", async (t) => {
  const { store, place } = await serverStore(t);
  const other = place.schema === undefined ? await openSqliteStore({ dataDir: place.dataDir, role: "runner" }) : await openPostgresStore({ url: PG_URL, schema: place.schema, role: "runner" });
  t.after(() => other.close());
  await store.agents.create({ id: "agent-1", name: "a" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const heard = [];
  const stop = other.watchCommands((event) => heard.push(event));
  await store.command("run-1", { kind: "steer", body: { content: "one" } });
  await store.command("run-1", { kind: "steer", body: { content: "two" } });
  await until(() => heard.length >= 2, "both writes heard");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(heard, [{ runId: "run-1", what: "written" }, { runId: "run-1", what: "written" }], "each once: the bus brought them, the wire's echo is dropped");
  stop();
  await other.close();
});

test("the wake file is emptied past its bound, and a listener still hears what comes after", sqliteOnly("the wake file"), async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wake-file-"));
  const path = join(dir, "store.sqlite.wake");
  const writer = new WakeFile(path);
  const reader = new WakeFile(path);
  t.after(async () => {
    await writer.close();
    await reader.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const heard = [];
  const stop = reader.listen((text) => heard.push(text));
  t.after(stop);
  const line = JSON.stringify({ from: "elsewhere", runId: "run-1", what: "written", pad: "x".repeat(200) });
  const count = Math.ceil(WAKE_FILE_MAX / line.length) + 20;
  for (let i = 0; i < count; i++) writer.send(line);
  writer.send("last");
  await until(() => heard.includes("last"), "the line after the emptying is heard", 5_000);
  assert.ok(statSync(path).size <= WAKE_FILE_MAX + line.length + 1, `the file stays bounded: ${statSync(path).size} bytes`);
});
