import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { childLoops, runTops } from '../dist/runner/run-child-host.js';
import { heldRedactor } from '../dist/runner/redact.js';
import { launchBody } from '../dist/run-launch.js';
import { storeOn } from './store-helpers.mjs';

test('a refused local moved-project UID claim never asks its helper to change seeded permissions, including cleanup', { timeout: 30_000 }, async t => {
  const { store, dir: data } = await storeOn(t), sealKey = Buffer.alloc(32, 7);
  const sourceId = 'a'.repeat(64), digest = 'b'.repeat(64);
  await store.agents.create({ id: 'agent', name: 'Fixture' }, { id: 'base', kind: 'agentic', body: {
    instructions: 'Keep exact permissions.', tools: [], sourceSync: { id: sourceId, snapshot: digest, project: digest, configuration: 'c'.repeat(64) },
  } });
  await store.runs.create({ id: 'run', agentId: 'agent', revisionId: 'base' }, { body: launchBody({
    input: { content: 'Work.' }, title: 'Work', place: { mode: 'runner' }, harness: 'pi',
    sourceProject: { version: 1, sourceId, digest, baselineRevision: 'base', receipt: 'd'.repeat(64) },
  }) });
  const [top] = runTops(data, 'agent', 'run'), folder = join(top, 'work'), file = join(folder, 'authored.txt');
  await mkdir(folder, { recursive: true }); await chmod(folder, 0o755);
  await writeFile(file, 'authored bytes'); await chmod(file, 0o644);
  const helper = join(data, 'fixture-runas'), log = join(data, 'helper.log');
  // The real helper's cleanup normalizes modes too. This adapter records calls and reproduces that effect.
  await writeFile(helper, '#!/bin/sh\necho "$*" >> "$(dirname "$0")/helper.log"\nif [ "$1" = own ] && [ "$2" = runner ]; then shift 2; chmod -R 0770 "$@"; fi\nexit 0\n');
  await chmod(helper, 0o755);
  const deps = { store, data, sealKey, env: {}, computerForClaim: async () => { throw new Error('computer must not start'); } };
  const loop = childLoops({ deps, isolation: { kind: 'uid', helper, first: 0, slots: 1 }, log: () => {} })({
    signal: new AbortController().signal, journal: claim => store.journal(claim), flush: async () => {}, delivered: Promise.resolve(), redact: heldRedactor(text => text),
  });
  const claim = await store.claim('run', 'fixture', { leaseMs: 60_000 });
  await assert.rejects(loop.start(claim), /project_mode_fidelity/);
  assert.equal((await stat(file)).mode & 0o7777, 0o644, 'refusal and its cleanup preserve the authored file mode');
  assert.equal((await stat(folder)).mode & 0o7777, 0o755, 'refusal and its cleanup preserve the authored directory mode');
  assert.equal(await readFile(file, 'utf8'), 'authored bytes');
  await assert.rejects(readFile(log), { code: 'ENOENT' }, 'no slot helper is invoked for this refused claim');
});
