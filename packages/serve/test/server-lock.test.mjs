// One server per data root (the store's owner lock, store.sqlite.owner): a second server on a root another server holds
// is refused by name before it touches anything, a crashed server's lock never blocks the next start, and the refusal
// holds between two servers in one process too. server-lock.ts's own lock file is read only by its own case below.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startServe, takeServerLock } from "../dist/index.js";
import { StoreOwned } from "../dist/store/index.js";
import { client, FAUX, printed, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refusal = (data) => `agentrun-serve: another server holds the store at ${join(data, "store.sqlite")}\n`;

/** The bin on `data`, its output kept; with `started`, resolves once it printed its address, else once it exited. */
async function bin(t, data, { started = true, env = {} } = {}) {
  // A home beside the data, not this machine's: a first start counts the sessions in its home for setup's offer.
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: dirname(data), ...env } });
  t.after(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"));
  const seen = { out: "", err: "" };
  child.stdout.on("data", (chunk) => (seen.out += chunk));
  child.stderr.on("data", (chunk) => (seen.err += chunk));
  // "close", not "exit": a child's stdio can still be open at "exit", and the lines read here are its last ones.
  const exited = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  if (!started) return { child, seen, code: await exited };
  await printed(child, /^AGENTRUN_BASE_URL=\S+$/m);
  return { child, seen, exited, base: /AGENTRUN_BASE_URL=(\S+)/.exec(seen.out)[1] };
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

test("a second server on a root another server holds exits 1 with one line, touches nothing, and the first goes on; once the first closes, a server starts", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  // The first and the last in this process; the refused one is the bin, in a process of its own.
  const first = await startServe({ data, port: 0, faux: FAUX });
  let closed = false;
  t.after(() => !closed && first.close());
  assert.equal(await answers(first), 200);
  assert.equal((await stat(join(data, "store.sqlite.owner"))).mode & 0o777, 0o600, "the store's owner lock is the server's alone");
  const before = await snapshot(data);
  const second = await bin(t, data, { started: false });
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
  // A process that takes the lock as a server's start does (it opens the store as the server), and is killed holding it.
  const store = new URL("../dist/store/index.js", import.meta.url).href;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `const { openSqliteStore } = await import(${JSON.stringify(store)}); globalThis.store = await openSqliteStore({ dataDir: ${JSON.stringify(data)}, role: "server" }); console.log("held"); setInterval(() => {}, 60_000);`], { stdio: ["ignore", "pipe", "pipe"] });
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
  assert.equal((await client(first.baseUrl, first.token)("GET", "/agents")).status, 200, "the first server still answers");
  await first.close();
  closed = true;
  const next = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => next.close());
  assert.equal((await client(next.baseUrl, next.token)("GET", "/agents")).status, 200);
});

test("a start that fails after taking the lock releases it: the next start on the same root, in the same process, serves", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const taken = createServer();
  await new Promise((resolve) => taken.listen(0, "127.0.0.1", resolve));
  t.after(() => taken.close());
  await assert.rejects(startServe({ data, port: taken.address().port, faux: FAUX }), (error) => !(error instanceof StoreOwned));
  const next = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => next.close());
  assert.equal((await client(next.baseUrl, next.token)("GET", "/agents")).status, 200);
});

test("a lock whose mode cannot be set (a filesystem that refuses chmod) is dropped before the error is thrown: the next take on the same root, in the same process, holds it", async (t) => {
  const data = await scratch(t);
  const refused = Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
  assert.throws(
    () =>
      takeServerLock(data, {
        chmod: () => {
          throw refused;
        },
      }),
    (error) => error === refused,
  );
  const lock = takeServerLock(data);
  t.after(() => lock.release());
  assert.equal(lock.file, join(data, "server.lock"));
});

test("the CLI drops node:sqlite's ExperimentalWarning only: another warning still prints, and the library entry filters nothing", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  // A warning raised once the CLI has loaded (its filter is its first import).
  const late = join(dir, "late-warning.mjs");
  // Another kind of warning, and another ExperimentalWarning than SQLite's: the filter drops SQLite's alone.
  await writeFile(late, 'setTimeout(() => { process.emitWarning("a warning of the test", "TestWarning"); process.emitWarning("a feature of the test", "ExperimentalWarning"); }, 300);\n');
  const server = await bin(t, data, { env: { NODE_OPTIONS: `--import=${late}` } });
  for (let i = 0; !(/TestWarning: a warning of the test/.test(server.seen.err) && /ExperimentalWarning: a feature of the test/.test(server.seen.err)); i++) {
    assert.ok(i < 100, `the other warnings were not printed: ${server.seen.err}`);
    await sleep(50);
  }
  assert.doesNotMatch(server.seen.err, /ExperimentalWarning: SQLite/, "node:sqlite's warning printed");
  // The library an embedder imports installs no filter: its process prints node:sqlite's warning exactly when node itself
  // does (Node 22 prints one on import; Node 24 prints none), read against a control that imports node:sqlite alone.
  const stderrOf = async (code) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    await new Promise((resolve) => child.once("close", resolve));
    return err;
  };
  const control = await stderrOf('await import("node:sqlite");');
  const library = await stderrOf(`await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});`);
  const sqlite = /ExperimentalWarning: SQLite/;
  assert.equal(sqlite.test(library), sqlite.test(control), `node:sqlite's warning: node alone ${sqlite.test(control) ? "prints" : "prints none"}, the library entry ${sqlite.test(library) ? "prints" : "prints none"}: ${JSON.stringify(library)}`);
});
