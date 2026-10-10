import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the durable quickstart takes its action once across two runs over one SQLite file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentrun-durable-quickstart-'));
  try {
    const out = execFileSync(process.execPath, ['examples/durable/quickstart.mjs', join(directory, 'run.sqlite')], { encoding: 'utf8' });
    assert.equal(out, 'complete sends so far: 1\ncomplete sends so far: 1\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
