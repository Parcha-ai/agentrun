// A box lost while a paying effect is in flight, through the server's real chokepoints on a run's store at NORMAL: the
// run's tool gate before a pi call, the kernel's drive before an effect. A preloaded shim (pi-durable-disk's
// test/fixtures/fsync-snapshot) keeps each store file as it stood at its last sync; once the run's process is killed,
// those copies replace the files, which is what a lost box leaves. The resumed run reports the effect interrupted, and
// never pays again.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratch } from "./support.mjs";

const FIXTURE = new URL("./fixtures/box-loss-chokepoints.mjs", import.meta.url).pathname;
const SHIM = new URL("../../pi-durable-disk/test/fixtures/fsync-snapshot/shim.c", import.meta.url).pathname;

async function shim(t) {
  const dir = await scratch(t);
  const out = join(dir, "shim.so");
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", out, SHIM, "-ldl"], { encoding: "utf8" });
  if (built.status === 0) return out;
  if (process.env.CI) throw new Error(`the fsync-snapshot shim did not build: ${built.error?.message ?? built.stderr}`);
  return undefined;
}

async function payThenLoseTheBox(lib, root, effects, which) {
  const child = spawn(process.execPath, [FIXTURE, root, effects, which, "first", "1"], { env: { ...process.env, LD_PRELOAD: lib, FSYNC_SNAPSHOT_DIR: join(root, "store") }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  for (const end = Date.now() + 60_000; !out.includes("paid\n"); await new Promise((resolve) => setTimeout(resolve, 20))) {
    if (Date.now() > end || child.exitCode !== null) {
      child.kill("SIGKILL");
      throw new Error(`the first run never paid: ${err.slice(-800)}`);
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
}

for (const [which, expected, what] of [
  ["pi", { conversation: true, interrupted: true }, "a pi tool call behind the run's tool gate"],
  ["kernel", { failed: true, interrupted: true }, "a kernel effect on the run's session writer"],
]) {
  test(`a box lost while ${what} pays: the resumed run reports it interrupted and never pays again`, { skip: process.platform !== "linux" && "the shim preloads on Linux", timeout: 120_000 }, async (t) => {
    const lib = await shim(t);
    if (!lib) return;
    const dir = await scratch(t);
    const root = join(dir, "runs", "r1");
    const effects = join(dir, "effects.log");
    await payThenLoseTheBox(lib, root, effects, which);
    assert.deepEqual(readFileSync(effects, "utf8").trim().split("\n"), ["first"]);
    const resumed = spawnSync(process.execPath, [FIXTURE, root, effects, which, "resume", "2"], { encoding: "utf8", timeout: 90_000 });
    assert.equal(resumed.status, 0, resumed.stderr.slice(-800));
    assert.deepEqual(JSON.parse(resumed.stdout.trim().split("\n").pop()), expected);
    assert.deepEqual(readFileSync(effects, "utf8").trim().split("\n"), ["first"], "paid once");
  });
}
