import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, statSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CHROME_STDERR, KEEP_BYTES, openChromeStderr, stopWatchingChromeStderr, trimChromeStderr, watchChromeStderr, watchedChromeStderr } from "../dist/providers/chrome-stderr.js";
import { scratch } from "./fixtures/scratch.mjs";

test("a Chrome's stderr file is emptied over its limit, and Chrome's open-for-append descriptor writes at the new end", async (t) => {
  const dir = await scratch(t, "chrome-stderr-");
  const file = path.join(dir, CHROME_STDERR);
  const fd = openChromeStderr(dir);
  assert.notEqual(fd, null, "the file opens in a private directory");
  assert.equal(openChromeStderr(null), null, "no private directory, no file");
  try {
    writeSync(fd, "x".repeat(1000));
    assert.equal(trimChromeStderr(dir, 2000), false, "under the limit nothing is touched");
    assert.equal(statSync(file).size, 1000);
    writeSync(fd, "y".repeat(2000));
    assert.equal(trimChromeStderr(dir, 2000), true, "over the limit the file is emptied");
    assert.equal(statSync(file).size, 0);
    writeSync(fd, "after");
    assert.equal(statSync(file).size, 5, "what Chrome writes next lands at the new end, not at its old offset");
    assert.equal(trimChromeStderr(dir, 0), true, "a limit of 0 empties any content: the port-open trim");
    assert.equal(trimChromeStderr(dir, 0), false, "an empty file stays as it is");
  } finally { closeSync(fd); }
  assert.ok(KEEP_BYTES >= 64 * 1024, "the periodic limit leaves room for a Chrome's own start-up lines");
  assert.equal(trimChromeStderr(path.join(dir, "nope")), false, "a directory that is gone is not an error");
  await writeFile(file, "kept");
});

const until = async (predicate, ms = 3_000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (predicate()) return true; return predicate(); };

test("a watched Chrome's file is trimmed while its pid lives, once per directory, and the watch ends when the pid is gone", async (t) => {
  const dir = await scratch(t, "chrome-stderr-watch-");
  const gone = await scratch(t, "chrome-stderr-gone-");
  t.after(() => stopWatchingChromeStderr());
  stopWatchingChromeStderr();
  const fd = openChromeStderr(dir), fdGone = openChromeStderr(gone);
  try {
    watchChromeStderr(dir, process.pid, 25);
    watchChromeStderr(dir, process.pid, 25);
    assert.equal(watchedChromeStderr(), 1, "a second watch of the same directory adds no timer");
    writeSync(fd, "x".repeat(KEEP_BYTES + 10));
    assert.ok(await until(() => statSync(path.join(dir, CHROME_STDERR)).size === 0), "over the limit the live Chrome's file is emptied by the timer");
    const child = spawn("true");
    await new Promise((resolve) => child.once("exit", resolve));
    watchChromeStderr(gone, child.pid, 25);
    assert.equal(watchedChromeStderr(), 2);
    assert.ok(await until(() => watchedChromeStderr() === 1), "the watch of a pid that is gone ends itself");
  } finally { closeSync(fd); closeSync(fdGone); }
});
