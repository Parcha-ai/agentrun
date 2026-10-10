// What the file store adds to the store contract: one whole JSON file per run, an owner that is a process, a takeover
// of a dead owner that one opener only can win, and a generation that fences an owner that lost the journal.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  // The first owner's lock is gone, as if another opener had taken the journal: the next open is the owner.
  rmSync(join(directory, 'owner.lock'), { recursive: true });
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

/** A lock a process left when it died: an entry named for a process id no process has. */
const deadLock = (directory, entry = `dead-owner.${2 ** 22 + 1}`) => { mkdirSync(join(directory, 'owner.lock')); writeFileSync(join(directory, 'owner.lock', entry), ''); };

test('a lock that names no live process is taken over, and so is one its owner left empty', async () => {
  for (const prepare of [(directory) => deadLock(directory), (directory) => deadLock(directory, 'no-process-id'), (directory) => mkdirSync(join(directory, 'owner.lock'))]) {
    const directory = mkdtempSync(join(root, 'run-'));
    prepare(directory);
    const journal = await fileStore(directory).open(BOUND);
    assert.deepEqual([journal.existing, journal.generation], [false, 1]);
    assert.deepEqual([readdirSync(directory).sort(), readdirSync(join(directory, 'owner.lock')).length], [['journal.json', 'owner.lock'], 1]);
    await assert.rejects(fileStore(directory).open(BOUND), liveOwner);
    await journal.close();
    assert.deepEqual(readdirSync(directory), ['journal.json']);
  }
});

test('when several processes open a dead owner\'s journal at once, exactly one becomes the owner', async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (let round = 0; round < 5; round += 1) {
    const directory = mkdtempSync(join(root, 'run-'));
    deadLock(directory);
    const go = join(directory, 'go');
    const racers = Array.from({ length: 8 }, () => spawn(process.execPath, ['--input-type=module', '-e', `
      import { existsSync } from 'node:fs';
      import { fileStore } from '@parcha/agentrun-dsl/recovery';
      console.log('ready');
      while (!existsSync(${JSON.stringify(go)})) await new Promise((resolve) => setImmediate(resolve));
      try {
        const journal = await fileStore(${JSON.stringify(directory)}).open(${JSON.stringify(BOUND)});
        await journal.save({ by: process.pid });
        console.log('owner ' + journal.generation);
        process.stdin.resume();
        process.stdin.on('end', async () => { await journal.close(); process.exit(0); });
      } catch (error) { console.log('refused ' + error.message); }
    `], { cwd: packageRoot, env, stdio: ['pipe', 'pipe', 'inherit'] }));
    const lines = racers.map((racer) => { const seen = []; racer.stdout.on('data', (chunk) => seen.push(...String(chunk).split('\n').filter(Boolean))); return seen; });
    const until = async (done) => { while (!done()) await new Promise((resolve) => setTimeout(resolve, 10)); };
    try {
      await until(() => lines.every((seen) => seen.includes('ready')));
      writeFileSync(go, '');
      await until(() => lines.every((seen) => seen.length >= 2));
      const outcomes = lines.map((seen) => seen[1]).sort();
      assert.deepEqual(outcomes, ['owner 1', ...Array(7).fill('refused Run already has a live owner')], `round ${round}`);
      assert.equal(readdirSync(join(directory, 'owner.lock')).length, 1);
    } finally {
      for (const racer of racers) racer.stdin.end();
      await Promise.all(racers.map((racer) => racer.exitCode === null ? once(racer, 'exit') : undefined));
    }
    assert.equal(existsSync(join(directory, 'owner.lock')), false);
    assert.equal(JSON.parse(readFileSync(join(directory, 'journal.json'), 'utf8')).generation, 1);
  }
});
