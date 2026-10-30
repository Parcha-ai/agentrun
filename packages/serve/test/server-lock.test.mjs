// One server per data root (server-lock.ts): a second server on a root another server holds is refused by name before
// it touches anything, a crashed server's lock never blocks the next start, and the refusal holds between two servers in
// one process too.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { ServerLockHeldError, startServe } from "../dist/index.js";
import { client, FAUX, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refusal = (data) => `agentrun-serve: another server holds this data root (${join(data, "server.lock")}): stop it, or start this one with another --data\n`;

/** The bin on `data`, its output kept; with `started`, resolves once it printed its address, else once it exited. */
async function bin(t, data, { started = true, env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  t.after(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"));
  const seen = { out: "", err: "" };
  child.stdout.on("data", (chunk) => (seen.out += chunk));
  child.stderr.on("data", (chunk) => (seen.err += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  if (!started) return { child, seen, code: await exited };
  for (let i = 0; !/AGENTRUN_BASE_URL=\S+/.test(seen.out); i++) {
    assert.ok(i < 200 && child.exitCode === null, `the server did not start: ${seen.out}${seen.err}`);
    await sleep(50);
  }
  return { child, seen, exited, base: /AGENTRUN_BASE_URL=(\S+)/.exec(seen.out)[1] };
}

const answers = async (data, base) => (await client(base, (await readFile(join(data, ".token"), "utf8")).trim())("GET", "/agents")).status;

/** The data root's entries with their size and modification time: what a refused start must leave as it was. */
async function snapshot(data) {
  const out = {};
  for (const name of (await readdir(data)).sort()) {
    const s = await stat(join(data, name));
    out[name] = s.isDirectory() ? "dir" : `${s.size}@${s.mtimeMs}`;
  }
  return out;
}

test("a second server on a root another server holds exits 1 with one line, touches nothing, and the first goes on; once the first exits, a server starts", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await bin(t, data);
  assert.equal(await answers(data, first.base), 200);
  assert.equal((await stat(join(data, "server.lock"))).mode & 0o777, 0o600, "server.lock is the server's alone");
  const before = await snapshot(data);
  const second = await bin(t, data, { started: false });
  assert.equal(second.code, 1);
  assert.equal(second.seen.err, refusal(data), "exactly one line, and no stack");
  assert.doesNotMatch(second.seen.out, /AGENTRUN_BASE_URL/);
  assert.deepEqual(await snapshot(data), before, "the refused server wrote into the data root");
  assert.equal(await answers(data, first.base), 200, "the first server still answers");
  first.child.kill("SIGTERM");
  assert.equal(await first.exited, 0);
  const third = await bin(t, data);
  assert.equal(await answers(data, third.base), 200);
});

test("a server killed by SIGKILL leaves its server.lock behind, and the next server on the root reuses it and serves", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await bin(t, data);
  first.child.kill("SIGKILL");
  await first.exited;
  await stat(join(data, "server.lock")); // still there: the kernel dropped the lock, not the file
  const next = await bin(t, data);
  assert.equal(await answers(data, next.base), 200);
});

test("two servers in one process on one root: the second start is refused (SQLite's lock, per file, holds between connections of one process); after the first closes, a start succeeds", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FAUX });
  let closed = false;
  t.after(() => !closed && first.close());
  await assert.rejects(startServe({ data, port: 0, faux: FAUX }), (error) => error instanceof ServerLockHeldError && error.code === "SERVER_LOCK_HELD" && `agentrun-serve: ${error.message}\n` === refusal(data));
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
  await assert.rejects(startServe({ data, port: taken.address().port, faux: FAUX }), (error) => !(error instanceof ServerLockHeldError));
  const next = await startServe({ data, port: 0, faux: FAUX });
  t.after(() => next.close());
  assert.equal((await client(next.baseUrl, next.token)("GET", "/agents")).status, 200);
});

test("the CLI drops node:sqlite's ExperimentalWarning only: another warning still prints, and the library entry filters nothing", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  // A warning raised once the CLI has loaded (its filter is its first import).
  const late = join(dir, "late-warning.mjs");
  await writeFile(late, 'setTimeout(() => process.emitWarning("a warning of the test", "TestWarning"), 300);\n');
  const server = await bin(t, data, { env: { NODE_OPTIONS: `--import=${late}` } });
  for (let i = 0; !/TestWarning: a warning of the test/.test(server.seen.err); i++) {
    assert.ok(i < 100, `the other warning was not printed: ${server.seen.err}`);
    await sleep(50);
  }
  assert.doesNotMatch(server.seen.err, /ExperimentalWarning/);
  // The library an embedder imports installs no filter: its process prints node:sqlite's warning as node does.
  const library = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});`], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  library.stderr.on("data", (chunk) => (err += chunk));
  await new Promise((resolve) => library.once("exit", resolve));
  assert.match(err, /ExperimentalWarning: SQLite/);
});
