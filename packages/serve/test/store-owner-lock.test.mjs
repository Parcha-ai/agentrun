// One server per data root, held by the store's owner lock (store.sqlite.owner: worker.ts takeOwnerLock takes it, and
// store.ts reads it before any read of the store): a second server on a root another server holds is refused by name
// before it touches anything, a crashed server's lock never blocks the next start, the refusal holds between two servers
// in one process too, and a refused start in one process never drops the lock the first holds. The lock file is the
// server's alone (0600).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { StoreOwned } from "../dist/store/index.js";
import { client, FAUX, printed, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const STORE = new URL("../dist/store/index.js", import.meta.url).href;
const refusal = (data) => `agentrun-serve: another server holds the store at ${join(data, "store.sqlite")}\n`;

/** The bin on `data`, run to its exit, its output kept. */
async function refusedBin(t, data) {
  // A home beside the data, not this machine's: a first start counts the sessions in its home for setup's offer.
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: dirname(data) } });
  t.after(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"));
  const seen = { out: "", err: "" };
  child.stdout.on("data", (chunk) => (seen.out += chunk));
  child.stderr.on("data", (chunk) => (seen.err += chunk));
  // "close", not "exit": a child's stdio can still be open at "exit", and the lines read here are its last ones.
  const code = await new Promise((resolve) => child.once("close", (exit) => resolve(exit)));
  return { seen, code };
}

const answers = async (server) => (await client(server.baseUrl, server.token)("GET", "/agents")).status;

/** The data root's entries with their size and modification time: what a refused start must leave as it was. */
async function snapshot(data) {
  const out = {};
  for (const name of (await readdir(data)).sort()) {
    const s = await stat(join(data, name));
    out[name] = s.isDirectory() ? "dir" : `${s.size}@${s.mtimeMs}`;
  }
  return out;
}

/** A process of its own that opens the store as a server does; it prints "held" once it holds the owner lock. */
const holderCode = (data) => `const { openSqliteStore } = await import(${JSON.stringify(STORE)}); globalThis.store = await openSqliteStore({ dataDir: ${JSON.stringify(data)}, role: "server" }); console.log("held"); setInterval(() => {}, 60_000);`;

test("a second server on a root another server holds exits 1 with one line, touches nothing, and the first goes on; once the first closes, a server starts", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  // The first and the last in this process; the refused one is the bin, in a process of its own.
  const first = await startServe({ data, port: 0, faux: FAUX });
  let closed = false;
  t.after(() => !closed && first.close());
  assert.equal(await answers(first), 200);
  assert.equal((await stat(join(data, "store.sqlite.owner"))).mode & 0o777, 0o600, "the store's owner lock is the server's alone");
  const before = await snapshot(data);
  const second = await refusedBin(t, data);
  assert.equal(second.code, 1);
  assert.equal(second.seen.err, refusal(data), "exactly one line, and no stack");
  assert.doesNotMatch(second.seen.out, /AGENTRUN_BASE_URL/);
  assert.deepEqual(await snapshot(data), before, "the refused server wrote into the data root");
  assert.equal(await answers(first), 200, "the first server still answers");
  await first.close();
  closed = true;
  const third = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => third.close());
  assert.equal(await answers(third), 200);
});

test("a server killed by SIGKILL leaves its store's owner lock behind, and the next server on the root takes it and serves", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  await mkdir(data);
  const holder = spawn(process.execPath, ["--input-type=module", "-e", holderCode(data)], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => holder.exitCode === null && holder.signalCode === null && holder.kill("SIGKILL"));
  const exited = new Promise((resolve) => holder.once("exit", resolve));
  await printed(holder, /^held$/m);
  await assert.rejects(startServe({ data, port: 0, faux: FAUX }), StoreOwned, "held while it lives");
  holder.kill("SIGKILL");
  await exited;
  await stat(join(data, "store.sqlite.owner")); // still there: the kernel dropped the lock, not the file
  const next = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => next.close());
  assert.equal(await answers(next), 200);
});

test("two servers in one process on one root: the second start is refused (SQLite's lock, per file, holds between connections of one process); after the first closes, a start succeeds", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX });
  let closed = false;
  t.after(() => !closed && first.close());
  await assert.rejects(startServe({ data, port: 0, faux: FAUX }), (error) => error instanceof StoreOwned && `agentrun-serve: ${error.message}\n` === refusal(data));
  assert.equal(await answers(first), 200, "the first server still answers");
  await first.close();
  closed = true;
  const next = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => next.close());
  assert.equal(await answers(next), 200);
});

test("a second start in one process, refused, leaves the first's lock whole: a server in another process is refused too", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => first.close());
  await assert.rejects(startServe({ data, port: 0, faux: FAUX }), StoreOwned, "the second start in this process is refused");
  // POSIX locks are the process's: a refused start that opened and closed the lock's file would drop the first's lock.
  const other = spawn(process.execPath, ["--input-type=module", "-e", `const { openSqliteStore } = await import(${JSON.stringify(STORE)}); try { const s = await openSqliteStore({ dataDir: ${JSON.stringify(data)}, role: "server" }); console.log("took the store"); await s.close(); } catch (error) { console.log(error.name); }`], { stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  other.stdout.on("data", (chunk) => (said += chunk));
  await new Promise((resolve) => other.once("close", resolve));
  assert.equal(said.trim(), "StoreOwned", "a server in another process is refused while the first runs");
  assert.equal(await answers(first), 200, "the first server still answers");
});

test("a start that fails after taking the lock releases it: the next start on the same root, in the same process, serves", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const taken = createServer();
  await new Promise((resolve) => taken.listen(0, "127.0.0.1", resolve));
  t.after(() => taken.close());
  await assert.rejects(startServe({ data, port: taken.address().port, faux: FAUX }), (error) => !(error instanceof StoreOwned));
  const next = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => next.close());
  assert.equal(await answers(next), 200);
});
