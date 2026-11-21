import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureTranscriptCursor } from '../dist/cli-learning/evidence.js';
import { captureSourcePolicy } from '../dist/cli-learning/policy.js';

async function capture(t, text) {
  const directory = await mkdtemp(join(tmpdir(), 'agentrun-cli-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transcript = join(directory, 'source.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'session', base_instructions: { text } } }) + '\n');
  return captureSourcePolicy({ runtime: 'codex', project: directory, cursor: await captureTranscriptCursor(transcript),
    env: {}, redact: value => value, sessionId: 'session',
    pinnedStanding: { text: 'Pinned standing policy.', files: [], truncated: false } });
}

test('CLI capture preserves bounded layered policy beyond the native execution policy limit', async t => {
  const policy = 'start-policy\n' + 'x'.repeat(240000) + '\nend-policy';
  const result = await capture(t, policy);
  assert.equal(result.truncated, false);
  assert.equal(result.incomplete, undefined);
  assert.ok(result.text.includes(policy));
  assert.match(result.text, /Pinned standing policy/);
});

test('CLI policy capture bounds UTF-8 bytes without treating a clipped snapshot as complete', async t => {
  const result = await capture(t, '🌱'.repeat(65537));
  assert.match(result.incomplete, /policy.*(exceeds|incomplete|unavailable|missing)/i);
  assert.ok(Buffer.byteLength(result.text) < 256 * 1024);
  assert.doesNotMatch(result.text, /🌱/);
});
