import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { serve } from './support.mjs';

test('public handoffs receive only the skill from this build, with GET/HEAD and no credential', async t => {
  const server = await serve(t);
  const path = '/skills/agentrun-serve/SKILL.md';
  const response = await fetch(server.url + path);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), await readFile(new URL('../skills/agentrun-serve/SKILL.md', import.meta.url), 'utf8'));
  const head = await fetch(server.url + path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(server.url + path, { method: 'POST' })).status, 405);
  assert.equal((await fetch(server.url + '/skills/private/SKILL.md')).status, 404);
});
