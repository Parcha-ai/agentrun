// A server that replaces another on the same data root (a redeploy, a restart that starts the new server before the old
// one has exited) waits for the old one to let go of its store and its data root's lock, for as long as its own drain
// timeout and a margin, saying so once; and a server that died leaves neither held, so the next start never waits on it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { FAUX, printed, scratch } from "./support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { takeServerLock } = await import("../dist/server-lock.js");

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = `ar_test_${"r".repeat(40)}`;

/** `node dist/cli.js` on data root `data`, its stderr kept line by line, stopped and waited for after the test. */
function start(t, root, data) {
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, XDG_CONFIG_HOME: join(root, "config"), TMPDIR: process.env.TMPDIR ?? root, AGENTRUN_ACCOUNTS: "0", AGENTRUN_TOKEN: TOKEN };
  const child = spawn(process.execPath, [CLI, "--data", data, "--port", "0", "--faux", FAUX, "--drain-timeout", "1s"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const err = [];
  createInterface({ input: child.stderr }).on("line", (line) => err.push(line));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal ?? code)));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  });
  return { child, err, exited };
}

const portOf = (out) => Number(/^agentrun-serve on http:\/\/127\.0\.0\.1:(\d+)\/v2 /m.exec(out)[1]);

/** Resolves once `err` holds a line `pattern` matches, or fails after `ms`. */
async function said(err, pattern, ms = 30_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (err.some((line) => pattern.test(line))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`never said ${pattern}: ${err.join("\n")}`);
}

test("a server killed outright leaves neither its store nor its data root held: the next start serves at once", { timeout: 120_000 }, async (t) => {
  const root = await scratch(t);
  const data = join(root, "data");
  const first = start(t, root, data);
  await printed(first.child, /^Open /m);
  first.child.kill("SIGKILL");
  assert.equal(await first.exited, "SIGKILL");
  const second = start(t, root, data);
  const port = portOf(await printed(second.child, /^Open /m));
  assert.equal((await fetch(`http://127.0.0.1:${port}/v2/health`)).status, 200);
  assert.ok(!second.err.some((line) => /waiting up to/.test(line)), `no wait for a dead server: ${second.err.join("\n")}`);
});

for (const [what, hold] of [
  ["its store", async (data) => { const store = await openSqliteStore({ dataDir: data, role: "server" }); return () => store.close(); }],
  ["its data root's lock", async (data) => { const lock = takeServerLock(data); return async () => lock.release(); }],
]) {
  test(`a server started while the one it replaces still holds ${what} (still stopping) waits for it, saying so once, then serves`, { timeout: 120_000 }, async (t) => {
    const root = await scratch(t);
    const data = join(root, "data");
    // A first start makes the data root, then stops: what it leaves is what a replaced server leaves.
    const made = start(t, root, data);
    await printed(made.child, /^Open /m);
    made.child.kill("SIGTERM");
    await made.exited;
    const release = await hold(data);
    const next = start(t, root, data);
    const up = printed(next.child, /^Open /m);
    up.catch(() => undefined);
    await said(next.err, /another server holds this data root: waiting up to \d+ s for the previous server to stop/);
    assert.equal(next.child.exitCode, null, "it waits, never exits");
    await release();
    const port = portOf(await up);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v2/health`)).status, 200, "it serves once the old one let go");
    assert.equal(next.err.filter((line) => /waiting up to/.test(line)).length, 1, "said once");
  });
}

test("a server started right after another's stop begins serves once the old one is gone, never exits 1", { timeout: 120_000 }, async (t) => {
  const root = await scratch(t);
  const data = join(root, "data");
  const old = start(t, root, data);
  await printed(old.child, /^Open /m);
  old.child.kill("SIGTERM");
  const next = start(t, root, data);
  const port = portOf(await printed(next.child, /^Open /m));
  assert.equal((await fetch(`http://127.0.0.1:${port}/v2/health`)).status, 200);
  await old.exited;
  assert.ok(!next.err.some((line) => /another server holds/.test(line) && !/waiting up to/.test(line)), `never refused: ${next.err.join("\n")}`);
});
