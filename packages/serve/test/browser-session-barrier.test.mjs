// A box lost once a browser session is created at its vendor, on a run's store at NORMAL (pi-durable-disk barriers.ts,
// browserSessionOpen): the session's creating record (its tag, pi-browser's) and the run's own record of its open
// (browser-cost.ts BROWSER_SESSION_OPEN) are synced before the vendor is asked. A preloaded shim
// (pi-durable-disk's test/fixtures/fsync-snapshot) keeps each store file as it stood at its last sync; once the run's
// process is killed, those copies replace the files, which is what a lost box leaves. The next process finds the record,
// and its reconcile releases the vendor's session by the tag: no billed session is left that nothing names.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FakeBackend, fixturePage } from "@parcha/pi-browser/testing";
import { scratch } from "./support.mjs";

const FIXTURE = new URL("./fixtures/box-loss-browser.mjs", import.meta.url).pathname;
const SHIM = new URL("../../pi-durable-disk/test/fixtures/fsync-snapshot/shim.c", import.meta.url).pathname;
const START = "https://example.test/start";

async function shim(t) {
  const dir = await scratch(t);
  const out = join(dir, "shim.so");
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", out, SHIM, "-ldl"], { encoding: "utf8" });
  if (built.status === 0) return out;
  if (process.env.CI) throw new Error(`the fsync-snapshot shim did not build: ${built.error?.message ?? built.stderr}`);
  return undefined;
}

/** The environment of a run's process: never a test runner's context, which would make it run nothing. */
const envOf = (extra) => {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
};

/** The first run, killed once its session is created at the vendor; then its store as the box loss leaves it. */
async function createThenLoseTheBox(lib, root, url) {
  const child = spawn(process.execPath, [FIXTURE, root, url, "first", "1"], { env: envOf({ LD_PRELOAD: lib, FSYNC_SNAPSHOT_DIR: join(root, "store") }), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  for (const end = Date.now() + 60_000; !/created \S+\n/.test(out); await new Promise((resolve) => setTimeout(resolve, 20))) {
    if (Date.now() > end || child.exitCode !== null) {
      child.kill("SIGKILL");
      throw new Error(`the first run never created its session: ${(out + err).slice(-800)}`);
    }
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const store = join(root, "store", "run.sqlite");
  for (const each of [store, `${store}-wal`]) {
    if (existsSync(`${each}.synced`)) renameSync(`${each}.synced`, each);
    else rmSync(each, { force: true });
  }
  for (const name of readdirSync(join(root, "store"))) if (/\.(synced|syncing)$/.test(name)) rmSync(join(root, "store", name));
  return /created (\S+)\n/.exec(out)[1];
}

/** `child`'s exit code and its output, once it ends; killed (status null) past `ms`. */
async function finished(child, ms) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  const status = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  clearTimeout(timer);
  return { status, stdout, stderr };
}

test("a box lost after the vendor created a browser session: the run's store still names it by its tag, and the next process releases it", { skip: process.platform !== "linux" && "the shim preloads on Linux", timeout: 120_000 }, async (t) => {
  const lib = await shim(t);
  if (!lib) return;
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const server = await backend.serve();
  t.after(() => server.close());
  const dir = await scratch(t);
  const root = join(dir, "runs", "r1");
  const tag = await createThenLoseTheBox(lib, root, server.url);
  assert.deepEqual(backend.live().map((s) => s.tag), [tag], "the vendor holds the session, billing");
  // Not spawnSync: the fake vendor answers from this process, and the next process's reconcile asks it by the tag.
  const resumed = await finished(spawn(process.execPath, [FIXTURE, root, server.url, "resume", "2"], { env: envOf({}), stdio: ["ignore", "pipe", "pipe"] }), 60_000);
  assert.equal(resumed.status, 0, resumed.stderr.slice(-800));
  const after = JSON.parse(resumed.stdout.trim().split("\n").pop());
  // The store kept, through the loss, what was synced before the create.
  assert.deepEqual(after.opens.map((o) => [o.tag, o.provider]), [[tag, "browserbase"]], JSON.stringify(after));
  assert.ok(after.sessions.some((s) => s.tag === tag), `the session's record is in the store: ${JSON.stringify(after.sessions)}`);
  // And the next process released the vendor's session by its tag.
  assert.deepEqual(backend.live(), [], `nothing left billing: ${JSON.stringify(backend.tally())}`);
  assert.ok(backend.tally().releases >= 1, JSON.stringify(backend.tally()));
});
