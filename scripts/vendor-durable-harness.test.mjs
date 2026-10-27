// The provenance of copied code, checked offline: this tree passes, and each planted break goes red.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRISTINE_DIR, UPSTREAM_FILE } from './upstream-attribution.mjs';
import { changedLines, gitBlob, provenanceProblems } from './vendor-durable-harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, 'packages', 'run-adapters');
const scratch = await mkdtemp(join(tmpdir(), 'agentrun-provenance-'));
after(() => rm(scratch, { recursive: true, force: true }));

test('every copied file in this tree matches its recorded upstream blob and carries its header', async () => {
  assert.deepEqual(await provenanceProblems(packageDir), []);
  const upstream = JSON.parse(await readFile(join(packageDir, UPSTREAM_FILE), 'utf8'));
  assert.ok(Object.keys(upstream.files).length >= 7);
  const lines = await changedLines(packageDir);
  assert.ok(Object.values(lines).every((n) => n < 40), `each copy changes few lines against upstream: ${JSON.stringify(lines)}`);
});

test('the git blob is git\'s own', async () => {
  const file = join(scratch, 'blob.txt');
  await writeFile(file, 'hello\n');
  assert.equal(gitBlob(Buffer.from('hello\n')), execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim());
});

test('each planted break goes red', async () => {
  let made = 0;
  const copy = async (plant) => {
    const dir = join(scratch, `p${made += 1}`);
    await cp(packageDir, dir, { recursive: true, filter: (path) => !/\/(?:node_modules|dist)(?:\/|$)/.test(path) });
    await plant(dir);
    return dir;
  };
  const tail = 'src/process/tail.ts';
  const pristine = (dir) => join(dir, PRISTINE_DIR, 'packages/harness-process/src/tail.ts');
  const planted = {
    'a pristine copy changed by a byte': async (dir) => appendFile(pristine(dir), ' '),
    'a pristine copy missing': async (dir) => rm(pristine(dir)),
    'a copy without its header': async (dir) => writeFile(join(dir, tail), (await readFile(join(dir, tail), 'utf8')).split('\n').slice(3).join('\n')),
    'a header naming another upstream file': async (dir) => writeFile(join(dir, tail), (await readFile(join(dir, tail), 'utf8')).replace('packages/harness-process/src/tail.ts', 'packages/harness-process/src/inbox.ts')),
    'a copy without its "Changed by Parcha" line': async (dir) => writeFile(join(dir, tail), (await readFile(join(dir, tail), 'utf8')).replace('// Changed by Parcha, ', '// ')),
    'a recorded sha256 that is not the file\'s': async (dir) => {
      const file = join(dir, UPSTREAM_FILE);
      const upstream = JSON.parse(await readFile(file, 'utf8'));
      upstream.files[tail].sha256 = '0'.repeat(64);
      await writeFile(file, JSON.stringify(upstream));
    },
  };
  for (const [name, plant] of Object.entries(planted)) assert.ok((await provenanceProblems(await copy(plant))).length > 0, `${name} was not caught`);
});
