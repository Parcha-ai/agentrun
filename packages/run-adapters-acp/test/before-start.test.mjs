// The host's check before every start of the agent's process (`beforeStart`), a restart included, and Goose's use of it:
// a binary replaced after its adapter was made is refused by its pin before it runs. No real binary, no model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { ACP_CODES, gooseAdapter } from '@parcha/agentrun-harness-acp';
import { fakeEvents, fakeRecipe, openSession, scratch } from './helpers.mjs';

const turn = async (session, text) => {
  await session.send(text);
  return session.turnEnd();
};

test('beforeStart runs with the command before each start of an agent process; a throw refuses that start, and the agent never runs', async (t) => {
  const dir = scratch();
  const recipe = fakeRecipe(dir, {});
  const seen = [];
  let refuse = false;
  const beforeStart = async (command) => {
    seen.push(command);
    if (refuse) throw new Error('the check refused this binary');
  };
  const { session } = await openSession(t, recipe, { options: { beforeStart } });
  assert.equal((await turn(session, 'SAY hello')).status, 'completed');
  assert.deepEqual(seen, [recipe.command], 'checked once, before the first start');
  const started = fakeEvents(recipe).length;
  assert.ok(started > 0, 'the agent ran');

  // Another session starts another process: the check runs again, and refuses it this time.
  refuse = true;
  const store = memorySessionStore();
  const other = await openSession(t, recipe, { store, options: { beforeStart } });
  const end = await turn(other.session, 'SAY again');
  assert.equal(end.status, 'failed');
  assert.match(end.error ?? '', /the check refused this binary/);
  assert.deepEqual(seen, [recipe.command, recipe.command], 'checked again before the second start');
  assert.equal(fakeEvents(recipe).length, started, 'the refused start never ran the agent');
});

test('Goose: a binary replaced after its adapter was made is refused by its pin (ACP_BINARY_MISMATCH) before it runs', async (t) => {
  const dir = scratch();
  const binary = join(dir, 'goose');
  const ran = join(dir, 'ran');
  writeFileSync(binary, '#!/bin/sh\nexit 1\n');
  chmodSync(binary, 0o755);
  const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  const adapter = gooseAdapter({
    binary,
    sha256,
    model: 'claude-sonnet-5-5',
    provider: { origin: 'http://127.0.0.1:9', credential: () => 'fake-test-key' },
    sessionsDir: join(dir, 'sessions'),
  });
  // Replaced after the adapter's own check: this one would leave a mark if it ever ran.
  writeFileSync(binary, `#!/bin/sh\ntouch '${ran}'\nexit 1\n`);
  const store = memorySessionStore();
  const io = {
    writer: await store.open('s1'),
    models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} },
    signal: new AbortController().signal,
    onEvent: () => {},
  };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [], context: 'fresh' }, io);
  t.after(() => session.close());
  const end = await turn(session, 'SAY hello');
  assert.equal(end.status, 'failed');
  assert.match(end.error ?? '', new RegExp(ACP_CODES.binaryMismatch));
  assert.equal(existsSync(ran), false, 'the replaced binary never ran');
});
