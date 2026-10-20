// A host whose Chrome rewrites a profile while it is copied: files vanish between the directory listing and the copy of each. copyProfile skips what vanished and
// keeps going, and above all lets no error escape: a stream opened for a file that is already gone must have its failure handled where it was made, or it
// ends the process as an unhandled 'error' event.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const CHILD = path.join(import.meta.dirname, "fixtures", "copy-vanish-child.mjs");
// The result is read when the child's streams have closed (not when it exits, with output still unread), and the child ends by itself.
const run = (...args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [CHILD, ...args.map(String)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
  const timer = setTimeout(() => { child.kill(); reject(new Error(`the copy rig did not finish: ${err.slice(-300)}`)); }, 90_000);
  child.on("close", (code) => { clearTimeout(timer); try { resolve(JSON.parse(out.trim().split("\n").at(-1))); } catch { reject(new Error(`no result (exit ${code}): ${out.slice(-200)} ${err.slice(-300)}`)); } });
});

test("a file removed at the moment the copy asks for its mode raises no uncaught error, the others are copied and the copy succeeds", { timeout: 120_000 }, async () => {
  const result = await run("controlled");
  assert.deepEqual([result.uncaught, result.copyFailed, result.copied], [0, null, ["a", "z"]], `an error escaped the copy, or the copy lost a file that stayed: ${JSON.stringify(result.sample)}`);
});

test("copying a directory whose files are all removed as the copy starts raises no uncaught error, over many rounds", { timeout: 120_000 }, async () => {
  const result = await run("stress", 12, 1500);
  assert.deepEqual([result.uncaught, result.copyFailed], [0, null], `an error escaped the copy: ${JSON.stringify(result.sample)}`);
});
