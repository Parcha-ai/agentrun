// The provenance of copied code, checked offline: this tree passes, and each planted break goes red. The port froze on
// 2026-11-07, so what is checked is the record and each copy's header, never a pristine upstream file (none is kept).
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRISTINE_DIR, UPSTREAM_FILE } from './upstream-attribution.mjs';
import { provenanceProblems } from './vendor-durable-harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, 'packages', 'run-adapters');
const scratch = await mkdtemp(join(tmpdir(), 'agentrun-provenance-'));
after(() => rm(scratch, { recursive: true, force: true }));

test('every recorded file in this tree is there and carries its header, and no pristine upstream copy is kept', async () => {
  for (const name of ['run-adapters', 'run-adapters-claude-agent', 'run-adapters-codex']) {
    const dir = join(root, 'packages', name);
    assert.deepEqual(await provenanceProblems(dir), [], name);
    const upstream = JSON.parse(await readFile(join(dir, UPSTREAM_FILE), 'utf8'));
    assert.ok(Object.keys(upstream.files).length > 0, name);
    assert.equal(await stat(join(dir, PRISTINE_DIR)).then(() => true, () => false), false, `${name} keeps no pristine copies`);
    assert.equal(await stat(join(dir, 'vendor/durable-harness/port')).then(() => true, () => false), false, `${name} keeps no port patches`);
  }
});

test('an executable copy keeps its #! line first and its header after it', async () => {
  const dir = join(scratch, 'shebang');
  await cp(join(root, 'packages', 'run-adapters-codex'), dir, { recursive: true, filter: (path) => !/\/(?:node_modules|dist)(?:\/|$)/.test(path) });
  const fake = join(dir, 'test/fake-app-server.mjs');
  const text = await readFile(fake, 'utf8');
  assert.ok(text.startsWith('#!/usr/bin/env node\n// Copyright 2026 Vercel Inc.'));
  assert.deepEqual(await provenanceProblems(dir), []);
  // The header must still come right after the #! line, not anywhere below it.
  await writeFile(fake, text.replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\n// a line before the header\n'));
  assert.ok((await provenanceProblems(dir)).some((p) => p.includes('fake-app-server.mjs')));
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
  const record = async (dir, change) => {
    const file = join(dir, UPSTREAM_FILE);
    const upstream = JSON.parse(await readFile(file, 'utf8'));
    change(upstream);
    await writeFile(file, JSON.stringify(upstream));
  };
  const planted = {
    'a recorded copy missing': async (dir) => rm(join(dir, tail)),
    'a copy without its header': async (dir) => writeFile(join(dir, tail), (await readFile(join(dir, tail), 'utf8')).split('\n').slice(3).join('\n')),
    'a header naming another upstream file': async (dir) => writeFile(join(dir, tail), (await readFile(join(dir, tail), 'utf8')).replace('packages/harness-process/src/tail.ts', 'packages/harness-process/src/other.ts')),
    'a copy without its "Changed by Parcha" line': async (dir) => writeFile(join(dir, tail), (await readFile(join(dir, tail), 'utf8')).replace('// Changed by Parcha, ', '// ')),
    'a record with no sha256': async (dir) => record(dir, (upstream) => void delete upstream.files[tail].sha256),
    'a record at another commit': async (dir) => record(dir, (upstream) => void (upstream.commit = '0'.repeat(40))),
  };
  for (const [name, plant] of Object.entries(planted)) assert.ok((await provenanceProblems(await copy(plant))).length > 0, `${name} was not caught`);
});
