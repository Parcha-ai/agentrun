// serve's effect paths through a box loss, on a run store at synchronous NORMAL (pi-durable-disk barriers.ts): a paid
// tool call's hold (paidToolHold), a model request's start mark (modelRequestStarted) and a workflow effect's admission
// (workflowAdmit). Each run (fixtures/box-loss-run.mjs) sends its effect, which never answers; the run's process is then
// killed (SIGKILL) and its store goes back to what its last fsync left (pi-durable-disk's fsync-snapshot shim, preloaded
// into it), which is what a lost box leaves on its disk. The next process opens the run again: the effect is held, counted
// and never sent again.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { before, test } from "node:test";
import { REQUEST_STARTED, TOOL_STARTED } from "@parcha/pi-durable-agent/timeline";
import { spentIn } from "../dist/cap.js";
import { MONID_RUN_ALLOWANCE_USD } from "../dist/monid.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/box-loss-run.mjs", import.meta.url));
const SHIM_SRC = fileURLToPath(new URL("../../pi-durable-disk/test/fixtures/fsync-snapshot/shim.c", import.meta.url));
/** faux-signal's worst case: 16,384 output tokens at $100 per million. */
const FAUX_WORST = (16_384 * 100) / 1e6;
const LINUX = process.platform === "linux";

let shim;
before(() => {
  if (!LINUX) return;
  const dir = mkdtempSync(join(tmpdir(), "box-loss-shim-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "shim.so");
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", out, SHIM_SRC, "-ldl"], { encoding: "utf8" });
  if (built.status === 0) shim = out;
  // CI has a C compiler: there, a shim that does not build fails the suite rather than skipping the box-loss tests.
  else if (process.env.CI) throw new Error(`the fsync-snapshot shim did not build: ${built.error?.message ?? built.stderr}`);
});

const untilTrue = async (what, check, child, ms = 60_000) => {
  for (const end = Date.now() + ms; !check();) {
    assert.equal(child.exitCode, null, `${what}: the run's process ended first: ${child.output()}`);
    assert.ok(Date.now() < end, `${what}: not within ${ms} ms: ${child.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The environment of a run's process: never a test runner's context, which would make it run nothing. */
const envOf = (extra) => {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
};

/** A run of `site` started in a new directory with the shim preloaded, killed once `sent` says its effect is out; then
 *  its store as the box loss leaves it. */
async function lostMidEffect(t, site, sent) {
  const dir = mkdtempSync(join(tmpdir(), `box-loss-${site}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = { dir, store: join(dir, "store", "run.sqlite"), effects: join(dir, "effects"), monid: join(dir, "monid-calls.jsonl") };
  const child = spawn(process.execPath, [FIXTURE, dir, site, "first", paths.effects], {
    env: envOf({ LD_PRELOAD: shim, FSYNC_SNAPSHOT_DIR: join(dir, "store"), AGENTRUN_TEST_FAUX_MONID_CALLS: paths.monid }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  child.output = () => out.slice(-2000);
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(() => child.kill("SIGKILL"));
  await untilTrue("the effect is sent", () => sent(paths), child);
  child.kill("SIGKILL");
  await exited;
  loseTheBox(paths.store);
  return paths;
}

/** The box is lost: each store file goes back to its state at its last sync; a file never synced is gone. */
function loseTheBox(file) {
  for (const each of [file, `${file}-wal`]) {
    if (existsSync(`${each}.synced`)) renameSync(`${each}.synced`, each);
    else rmSync(each, { force: true });
  }
  const dir = join(file, "..");
  for (const name of readdirSync(dir)) if (name.endsWith(".synced") || name.endsWith(".syncing")) rmSync(join(dir, name));
}

/** The run's root entries of `kind` in its store, as the next process opens it. */
function entriesOf(file, kind) {
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'entries'").get()) return [];
    return db.prepare("SELECT record FROM entries ORDER BY rowid").all().map((row) => JSON.parse(row.record)).filter((entry) => entry.kind === kind);
  } finally {
    db.close();
  }
}

/** The next process: the run opened again, without the shim, to its end; what it printed. */
function reopened({ dir, effects, monid }, site) {
  const child = spawnSync(process.execPath, [FIXTURE, dir, site, "resume", effects], { encoding: "utf8", env: envOf({ AGENTRUN_TEST_FAUX_MONID_CALLS: monid }), timeout: 90_000 });
  assert.equal(child.status, 0, `the run opened again and ended: ${child.error?.message ?? ""} ${child.stdout} ${child.stderr}`.slice(-3000));
  return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

const monidRuns = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.path === "/v1/run") : []);
const skip = !LINUX && "the shim preloads on Linux";

test("paidToolHold through a box loss: monid.run sent, then the box lost; on reopen its hold is in the store, the cap counts it at its held figure, and the call is never sent again", { skip, timeout: 180_000 }, async (t) => {
  if (!shim) return void assert.ok(!process.env.CI, "the shim is required in CI");
  const paths = await lostMidEffect(t, "paid", ({ monid }) => monidRuns(monid).length > 0);
  const holds = entriesOf(paths.store, TOOL_STARTED).filter((entry) => entry.data?.tool === "monid.run");
  assert.deepEqual(holds.map((entry) => entry.data.heldUsd), [MONID_RUN_ALLOWANCE_USD], "the hold written before the call was sent survives the box");
  assert.equal(spentIn(paths.store), MONID_RUN_ALLOWANCE_USD, "the cap counts the cut call at its held figure");
  const first = monidRuns(paths.monid);
  assert.equal(first.length, 1);
  assert.deepEqual(reopened(paths, "paid"), { conversation: true });
  assert.deepEqual(monidRuns(paths.monid), first, "the next process never sends the call again");
});

test("modelRequestStarted through a box loss: a capped request sent, then the box lost; on reopen its start mark is in the store with its hold, the cap counts it, and the turn's next request finds no room and is not sent", { skip, timeout: 180_000 }, async (t) => {
  if (!shim) return void assert.ok(!process.env.CI, "the shim is required in CI");
  const paths = await lostMidEffect(t, "request", ({ effects }) => existsSync(effects));
  const marks = entriesOf(paths.store, REQUEST_STARTED);
  assert.equal(marks.length, 1, `the start mark written before the request was sent survives the box: ${JSON.stringify(marks)}`);
  assert.ok(Math.abs(marks[0].data.heldUsd - FAUX_WORST) < 1e-9, `with the worst case the cap held for it: ${JSON.stringify(marks[0].data)}`);
  assert.ok(Math.abs(spentIn(paths.store) - FAUX_WORST) < 1e-9, `the cap counts the cut request at its hold: ${spentIn(paths.store)}`);
  rmSync(paths.effects);
  assert.deepEqual(reopened(paths, "request"), { conversation: true });
  assert.equal(existsSync(paths.effects), false, "the next request was refused under the cap, never sent");
});

test("workflowAdmit through a box loss: a call node's effect admitted and sent, then the box lost; on reopen it is admitted and unknown, refused, and never dispatched again", { skip, timeout: 180_000 }, async (t) => {
  if (!shim) return void assert.ok(!process.env.CI, "the shim is required in CI");
  const paths = await lostMidEffect(t, "workflow", ({ effects }) => existsSync(effects));
  const { outcome } = reopened(paths, "workflow");
  assert.equal(outcome.code, "FROZEN_EFFECT_UNKNOWN", `the admitted effect is unknown on reopen: ${JSON.stringify(outcome)}`);
  assert.equal(readFileSync(paths.effects, "utf8"), "first\n", "dispatched once, by the process the box took");
});
