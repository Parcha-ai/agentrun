// A node an older build opened and never finished, resumed by this runner in a process where only the runner's
// extension is installed: the runner finds the node's conversation by its session, writes its configuration from the
// system text the older build kept on the index entry, and the node delivers once.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./fixtures/node-runner-legacy-child.mjs', import.meta.url));
const OLD_SYSTEM = 'Decide buy or pass.\n\nThe stance the older build wrote.';

function child(mode, dir, env = {}) {
  const ran = spawnSync(process.execPath, [CHILD, mode, join(dir, 'run.sqlite'), join(dir, 'requests')], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 });
  const rows = ran.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  return { signal: ran.signal, status: ran.status, stderr: ran.stderr, rows, events: rows.map((row) => row.event), end: rows.find((row) => row.event === 'end') };
}
const requests = (dir) => readFileSync(join(dir, 'requests'), 'utf8').split('\n').filter(Boolean).length;

for (const [point, before, total] of [['after-conversation', ['legacy-open'], 1], ['mid-model', ['legacy-open', 'request'], 2]]) {
  test(`an older build's node killed ${point} is resumed by the runner with that build's system text`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'node-runner-legacy-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'requests'), '');
    const first = child('legacy', dir, { KILL_AT: point });
    assert.equal(first.signal, 'SIGKILL', first.stderr);
    assert.deepEqual(first.events, before);
    const second = child('resume', dir);
    assert.equal(second.status, 0, second.stderr || `no end: ${JSON.stringify(second.rows)}`);
    assert.deepEqual(second.events, ['reached', 'open', 'request', 'end'], 'nothing of the node ran before the runner reached it');
    assert.deepEqual(second.rows.find((row) => row.event === 'open'), { event: 'open', conversation: first.rows[0].conversation, resumed: true });
    const request = second.rows.find((row) => row.event === 'request');
    assert.equal(request.sections.task, OLD_SYSTEM, 'the system text the older build kept, byte for byte');
    assert.equal(request.submit, 'Deliver the Verdict record. Submit it inline as the tool arguments. It ends the run.');
    assert.deepEqual(second.end, { event: 'end', record: { verdict: 'buy' }, stored: { record: { verdict: 'buy' }, attempts: 1 } });
    assert.equal(requests(dir), total);
  });
}

test('without its extension back, the older build\'s request in flight runs before the runner reaches the node and is lost', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'node-runner-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'requests'), '');
  assert.equal(child('legacy', dir, { KILL_AT: 'mid-model' }).signal, 'SIGKILL');
  const second = child('resume', dir, { LEGACY: 'none' });
  assert.equal(second.events[0], 'request', 'pi resumed the request before the runner reached the node');
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /NODE_NOT_DELIVERED/);
});
