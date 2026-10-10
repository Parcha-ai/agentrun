// What the file store adds to the store contract: one whole JSON file per run, an owner that is a process, and a
// generation that fences an owner that lost the journal.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fileStore, RecoveryError } from '@parcha/agentrun-dsl/recovery';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'agentrun-file-store-'));
after(() => rmSync(root, { recursive: true, force: true }));
const BOUND = { binding: 'binding-1', inputs: { workflow: 'digest-a' } };
const liveOwner = (error) => error instanceof RecoveryError && /^Run already has a live owner$/.test(error.message);

test('the journal is one whole JSON file after every commit, and an open leaves nothing but its lock beside it', async () => {
  const directory = mkdtempSync(join(root, 'run-'));
  const journal = await fileStore(directory).open(BOUND);
  for (const write of [() => journal.save({ step: 1 }), () => journal.admit('e1', 'lookup', 'args', { step: 2 }), () => journal.complete('e1', { value: 1 }, { step: 3 })]) {
    await write();
    assert.deepEqual(readdirSync(directory).sort(), ['journal.json', 'owner.lock']);
    assert.equal(JSON.parse(readFileSync(join(directory, 'journal.json'), 'utf8')).revision, journal.revision);
  }
  await journal.close();
  assert.deepEqual(readdirSync(directory), ['journal.json']);
  const record = JSON.parse(readFileSync(join(directory, 'journal.json'), 'utf8'));
  assert.deepEqual([record.binding, record.generation, record.revision, record.state, record.effects.map((effect) => [effect.id, effect.status])], ['binding-1', 1, 3, { step: 3 }, [['e1', 'completed']]]);
});

test('an owner in another live process is refused, and a dead owner is taken over with what it committed', async () => {
  const directory = mkdtempSync(join(root, 'run-'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { fileStore } from '@parcha/agentrun-dsl/recovery';
    const journal = await fileStore(${JSON.stringify(directory)}).open(${JSON.stringify(BOUND)});
    await journal.save({ by: 'child' });
    await journal.admit('e1', 'lookup', 'args', { by: 'child', admitted: true });
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { cwd: packageRoot, env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const [line] = await once(child.stdout, 'data');
    assert.match(String(line), /ready/);
    await assert.rejects(fileStore(directory).open(BOUND), liveOwner);
  } finally {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
  const journal = await fileStore(directory).open(BOUND);
  assert.deepEqual([journal.existing, journal.generation, journal.state, journal.effect('e1')?.status], [true, 2, { by: 'child', admitted: true }, 'unknown']);
  await journal.close();
});

test('a commit from an owner that lost the journal is refused by its generation', async () => {
  const directory = mkdtempSync(join(root, 'run-'));
  const displaced = await fileStore(directory).open(BOUND);
  await displaced.save({ by: 'first' });
  // The first owner's lock is gone, as after a takeover: the next open is the owner.
  rmSync(join(directory, 'owner.lock'));
  const owner = await fileStore(directory).open(BOUND);
  await assert.rejects(displaced.save({ by: 'first', late: true }), (error) => error instanceof RecoveryError && /^Run owner generation is not acquired$/.test(error.message));
  await assert.rejects(displaced.admit('e1', 'lookup', 'args', {}), RecoveryError);
  assert.equal(await owner.save({ by: 'second' }), 2);
  await displaced.close();
  await assert.rejects(fileStore(directory).open(BOUND), liveOwner);
  await owner.close();
  const next = await fileStore(directory).open(BOUND);
  assert.deepEqual([next.generation, next.state, next.effects()], [3, { by: 'second' }, []]);
  await next.close();
});

test('a lock that names no live process is taken over', async () => {
  for (const lock of [JSON.stringify({ pid: 2 ** 22 + 1, token: 'dead' }), JSON.stringify({ token: 'no-pid' })]) {
    const directory = mkdtempSync(join(root, 'run-'));
    writeFileSync(join(directory, 'owner.lock'), lock);
    const journal = await fileStore(directory).open(BOUND);
    assert.deepEqual([journal.existing, journal.generation], [false, 1]);
    assert.deepEqual(readdirSync(directory).sort(), ['journal.json', 'owner.lock']);
    await journal.close();
  }
});
