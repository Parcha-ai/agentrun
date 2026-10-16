// The bounds of test/chrome.ts, shown on a stand-in for Chrome that never starts listening and does not die on SIGTERM,
// with a helper of its own still running: each wait fails within its bound and names what it waited for, and nothing it started
// is left running. (spawnSync, with a timeout, sends SIGTERM and then waits for such a process to exit: the event loop
// blocked, no test timeout can fire.)
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drivenPage, within } from './chrome.ts';

/** A Chrome that hangs: it ignores SIGTERM, starts a helper that holds its stdout, writes both their pids, and never ends. */
function hungChrome(dir: string) {
  const path = join(dir, 'hung-chrome');
  writeFileSync(path, `#!/bin/sh\ntrap '' TERM\nsleep 600 &\necho $$ $! > '${join(dir, 'pids')}'\nwhile :; do sleep 1; done\n`);
  chmodSync(path, 0o755);
  return path;
}
/** Whether a process still runs: a killed one may wait a moment to be reaped, and its entry then says `Z` (Linux). */
const running = (pid: number) => {
  try { return !/^\d+ \(.*\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { /* no entry, or no /proc */ }
  try { process.kill(pid, 0); return existsSync('/proc') ? false : true; } catch { return false; }
};
/** Each of `pids` ends within 5 s, polled. */
const ended = async (pids: number[]) => {
  for (const until = Date.now() + 5000; Date.now() < until && pids.some(running);) await new Promise((resolve) => setTimeout(resolve, 50));
  for (const pid of pids) assert.equal(running(pid), false, `process ${pid} is gone`);
};
const pidsIn = (dir: string) => readFileSync(join(dir, 'pids'), 'utf8').trim().split(' ').map(Number);

test('a wait past its bound fails and names what it waited for', { timeout: 5_000 }, async () => {
  await assert.rejects(within(100, 'the thing', new Promise(() => {})), /the thing: nothing after 0.1 s/);
  assert.equal(await within(1000, 'the thing', Promise.resolve(7)), 7);
});

test('a Chrome that never starts listening fails within the launch bound, and it and its helper are killed', { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-bounds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }), { timeout: 5_000 });
  const started = Date.now();
  await assert.rejects(drivenPage('http://127.0.0.1:9/', join(dir, 'profile'), { launchMs: 1000, path: hungChrome(dir) }), /Chrome starting \(its DevToolsActivePort\): nothing after 1 s/);
  assert.ok(Date.now() - started < 8000, `failed fast (${Date.now() - started} ms)`);
  await ended(pidsIn(dir));
});

test('a test that ends aborts its signal, and Chrome and its helper go at once, its bound not yet passed', { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-bounds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }), { timeout: 5_000 });
  const ending = new AbortController();
  setTimeout(() => ending.abort(), 500);
  const started = Date.now();
  await assert.rejects(drivenPage('http://127.0.0.1:9/', join(dir, 'profile'), { launchMs: 10_000, path: hungChrome(dir), signal: ending.signal }), /Chrome starting/);
  assert.ok(Date.now() - started < 5000, `ended with the signal (${Date.now() - started} ms), not the 10 s bound`);
  await ended(pidsIn(dir));
});
