// A host SIGKILLed alone, not its process group, leaves no Codex child running. The session machine starts each child
// detached, in its own group, so the host's death does not reach it; ./host's parent watch ends it. The child here
// ignores its stdin closing, as a CLI that does not exit on EOF does; the real binary's own exit on EOF is
// orphan.test.mjs. The shim is forced, so this runs on any platform with /proc or without setpriv.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PARENT_WATCH_SHIM, parentWatchHere, processAlive, SETPRIV } from '@parcha/agentrun-adapters/host';

// How the child was watched is read from /proc; the kill itself is checked wherever the tests run.
const NO_PROC = process.platform !== 'linux' && 'the parent chain is read from /proc, which only Linux has';

const HOST = fileURLToPath(new URL('./fixtures/watch-host.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-watch-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

/** Start the host, wait for its child, SIGKILL the host alone; says whether the child is gone within the bound, and what it reported. */
async function killHost(t, args) {
  const dir = join(ROOT, `h${n += 1}`);
  const host = spawn(process.execPath, [HOST, dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  host.stderr.on('data', (d) => (stderr += d));
  let child;
  t.after(() => {
    for (const pid of [host.pid, child]) if (pid && processAlive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  });
  let timer;
  let first;
  try {
    first = await Promise.race([
      createInterface({ input: host.stdout })[Symbol.asyncIterator]().next(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the host reported no child: ${stderr.slice(-400)}`)), 30_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.ok(!first.done, `the host ended first: ${stderr.slice(-400)}`);
  const report = JSON.parse(first.value);
  child = report.child;
  assert.ok(processAlive(child), 'the child runs while the host does');
  host.kill('SIGKILL');
  let gone = false;
  for (const end = Date.now() + 5_000; Date.now() < end && !(gone = !processAlive(child)); ) await new Promise((r) => setTimeout(r, 25));
  return { gone, report };
}

test('a host SIGKILLed alone leaves no child running, with the parent-watch shim, and the shim is the watch that ran', async (t) => {
  const { gone, report } = await killHost(t, ['shim']);
  assert.ok(gone, 'the child outlived its host');
  if (NO_PROC) return;
  assert.notEqual(report.ppid, report.host, 'the child\'s parent is the shim, not the host');
  assert.deepEqual(report.parent.slice(0, 2), [process.execPath, PARENT_WATCH_SHIM], 'the child runs under the parent-watch shim');
});

test('a host SIGKILLed alone leaves no child running, with the machine\'s own parent watch', async (t) => {
  const { gone } = await killHost(t, ['']);
  assert.ok(gone, 'the child outlived its host');
});

test('the machine\'s own watch is the kernel\'s parent-death signal where setpriv has it, and the child stays the host\'s direct child', { skip: NO_PROC || (parentWatchHere() !== 'pdeathsig' && 'setpriv here lacks --pdeathsig') }, async (t) => {
  const record = join(ROOT, 'default-confine.jsonl');
  const { gone, report } = await killHost(t, ['', 'confined', record]);
  assert.ok(gone, 'the child outlived its host');
  assert.equal(report.ppid, report.host, 'setpriv execs the child in place: its parent is still the host');
  const [given] = readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(given.command, SETPRIV, 'the confinement is given the setpriv watch');
  assert.ok(given.args.includes('--pdeathsig'), 'the watch sets the parent-death signal');
});

test('the watch sits inside the confinement: the confinement is given the watch with the child last', async (t) => {
  const record = join(ROOT, 'confine.jsonl');
  assert.ok((await killHost(t, ['shim', 'confined', record])).gone, 'the child outlived its host');
  const [given] = readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const run = [given.command, ...given.args];
  // The child is [node, -e, holder]; the watch is in front of it, so the confinement prefix goes in front of the watch.
  assert.deepEqual(run.slice(-3, -1), [process.execPath, '-e'], 'the child ends what the confinement was given');
  assert.ok(run.length > 3, 'something, the watch, comes before the child');
});
