// A runner whose `exited` rejects (a child that cannot start, a host that stops answering): the attempt's timer and signals reader are closed and the place is released, and the error is the runner's.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { demo, localPlace } from '@parcha/agentrun-harness';

test('a runner whose exited rejects ends the attempt cleanly: no timer is left, the signals reader is closed, the place is released, and the error is the runner\'s', { timeout: 60_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-exited-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const spec = join(tmp, 'demo.json');
  writeFileSync(spec, JSON.stringify({ name: 'reference' }));
  const before = { ...process.env };
  process.env.DEMO_SPEC = spec;
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]; Object.assign(process.env, before); });
  const { options } = await import(`./reference/demo-fixture.ts?exited=${Date.now()}`);
  const calls = [];
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const baseline = timers();
  await assert.rejects(() => demo({ ...options, argv: ['--json'], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return {
      ...inner,
      signals: (attempt) => { const it = inner.signals(attempt); return { [Symbol.asyncIterator]() { const reader = it[Symbol.asyncIterator](); return { next: () => reader.next(), return: async () => { calls.push('signals closed'); return reader.return?.() ?? { done: true, value: undefined }; } }; } }; },
      start: async () => ({ epoch: 1, pid: undefined, exited: Promise.reject(new Error('the host stopped answering')) }),
      release: async () => { calls.push('release'); },
    };
  } }), /the host stopped answering/);
  assert.deepEqual(calls, ['signals closed', 'release']);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(timers() <= baseline, 'no timer of the attempt is left running');
});
