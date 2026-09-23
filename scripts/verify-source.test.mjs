import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-source-verifier-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, '.release/agentrun-dsl-source'), { recursive: true });
  await copyFile(new URL('./verify-source.mjs', import.meta.url), join(root, 'scripts/verify-source.mjs'));
  const source = join(root, '.release/agentrun-dsl-source');
  await writeFile(join(source, 'README.md'), 'fixture\n');
  const files = [{ path: 'README.md', sha256: hash('fixture\n'), size: 8 }];
  const receipt = { status: 'passed', files };
  async function pack() {
    await exec('tar', ['-czf', join(root, '.release/agentrun-dsl-source.tar.gz'), '-C', join(root, '.release'), 'agentrun-dsl-source']);
    const bytes = await readFile(join(root, '.release/agentrun-dsl-source.tar.gz'));
    receipt.archive = { path: '.release/agentrun-dsl-source.tar.gz', sha256: hash(bytes), size: bytes.length };
    receipt.sourceTreeSha256 = hash(files.map(file => `${file.path}\0${file.sha256}\n`).join(''));
    await writeFile(join(root, '.release/source-export-receipt.json'), JSON.stringify(receipt));
    await writeFile(join(root, '.release/source-consumer.json'), JSON.stringify({ status: 'passed', stale: true }));
  }
  async function fails(pattern) {
    await assert.rejects(exec(process.execPath, [join(root, 'scripts/verify-source.mjs')], { cwd: root }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, pattern);
      return true;
    });
    const result = JSON.parse(await readFile(join(root, '.release/source-consumer.json'), 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.stale, undefined);
    assert.match(result.error, pattern);
    assert.ok(result.finishedAt);
    assert.ok(result.commands.every(command => command.command[0] !== 'npm'));
  }
  return { root, source, files, receipt, pack, fails };
}

test('a changed archive fails before installation and replaces stale success evidence', async t => {
  const f = await fixture(t);
  await f.pack();
  await writeFile(join(f.root, '.release/agentrun-dsl-source.tar.gz'), 'changed');
  await f.fails(/Archive hash differs/);
});

test('source verification rejects symbolic links before extraction', async t => {
  const f = await fixture(t);
  await symlink('../outside', join(f.source, 'escape'));
  await f.pack();
  await f.fails(/Archive links and special files are prohibited/);
});

test('source verification rejects archive files absent from the export inventory', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'unreviewed.txt'), 'extra');
  await f.pack();
  await f.fails(/Archive inventory differs/);
});

test('source verification checks each extracted file against the export receipt', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'README.md'), 'modified');
  await f.pack();
  await f.fails(/Extracted file differs/);
});

for (const path of ['site/dist/index.html', 'packages/dsl/dist/index.js']) {
  test(`source verification rejects ${path} even when included in the export receipt`, async t => {
    const f = await fixture(t);
    const content = 'stale output\n';
    await mkdir(join(f.source, path, '..'), { recursive: true });
    await writeFile(join(f.source, path), content);
    f.files.push({ path, sha256: hash(content), size: Buffer.byteLength(content) });
    f.files.sort((a, b) => a.path.localeCompare(b.path));
    await f.pack();
    await f.fails(/Source archive contains website or build output/);
  });
}
