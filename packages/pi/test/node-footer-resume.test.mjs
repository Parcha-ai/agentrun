// A node's user turn across the change that made its delivery contract a part of its own: a build from before it sent
// the node's input and the contract as one string; this build sends them as two text parts of the one user turn, the
// input first, so a viewer shows the input and folds the contract. A node attempt the older build opened and was killed
// in is resumed by this build as it was sent: pi keeps a resumed attempt's submission by its request id and compares
// nothing else, and the attempt's digest does not cover the text.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { submitFooter } from '@parcha/agentrun-pi/durable';
import { childPath } from './fixtures/cross-version.mjs';

const CHILD = childPath('node-footer-child.mjs');
const SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } };
const FOOTER = submitFooter({ label: 'the Verdict record', schema: SCHEMA });

function child(mode, dir) {
  const ran = spawnSync(process.execPath, [CHILD, mode, join(dir, 'run.sqlite')], { encoding: 'utf8', timeout: 60_000 });
  const rows = ran.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  return { signal: ran.signal, status: ran.status, stderr: ran.stderr, rows, events: rows.map((row) => row.event) };
}

test('a node attempt an older build opened and was killed in is resumed as it was sent; a new attempt sends its input, then its contract, as two parts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'node-footer-resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const before = child('before', dir);
  assert.equal(before.signal, 'SIGKILL', before.stderr);
  assert.deepEqual(before.events, ['open', 'request']);
  const sent = before.rows[1].user;
  assert.equal(sent, `{"claim":"x"}\n${FOOTER}`, 'the older build sent one string');

  const after = child('after', dir);
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(after.events, ['open', 'request', 'record', 'open', 'request', 'record']);
  const [resumedOpen, freshOpen] = after.rows.filter((row) => row.event === 'open');
  assert.deepEqual(resumedOpen, { event: 'open', session: 'run-1:step:/root/steps/0:a0', conversation: before.rows[0].conversation, resumed: true }, 'the same conversation, with no binding refused');
  assert.equal(freshOpen.resumed, false);
  const [resumed, fresh] = after.rows.filter((row) => row.event === 'request');
  assert.deepEqual(resumed.user, sent, 'the resumed attempt goes out again as the older build sent it, byte for byte');
  assert.deepEqual(after.rows.filter((row) => row.event === 'record').map((row) => row.record), [{ verdict: 'buy' }, { verdict: 'buy' }], 'each node delivers once');
  assert.deepEqual(fresh.user, [{ type: 'text', text: '{"claim":"y"}' }, { type: 'text', text: FOOTER }], 'the node\'s input is the first part and its delivery contract the second');
});
