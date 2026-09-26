import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const exporter = await readFile(new URL('./export-source.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-source-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, content = 'fixture\n') => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write('scripts/export-source.mjs', exporter);
  await write('package.json', JSON.stringify({ name: 'fixture', private: true }));
  await write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
    '': {}, 'packages/dsl': {}, 'packages/jev': {}, 'packages/pi': {},
  } }));
  await write('docs/guide.md', '# Public fixture\n');
  await write('packages/dsl/schema/workflow.schema.json', '{}\n');
  const run = (...args) => exec(process.execPath, [join(root, 'scripts/export-source.mjs'), ...args], { cwd: root });
  const listing = async () => (await exec('tar', ['-tzf', join(root, '.release/agentrun-dsl-source.tar.gz')])).stdout;
  return { root, write, run, listing };
}

test('source archives exclude website files, build output, and private review state', async t => {
  const f = await fixture(t);
  const excluded = [
    '.desloppify/results.json', '.impeccable/critique.md', '.cascade/evidence.json',
    'docs/.desloppify/results.json', 'packages/dsl/.impeccable/critique.md',
    'docs/.review/findings.json', 'examples/.reviews/notes.md', 'docs/candidate.review.json',
    'packages/dsl/scorecard.png', 'packages/jev/scorecard.png',
    'site/index.html', 'site/dist/index.html', 'site/dist/assets/wordmark.webm',
    'site/dist/downloads/agentrun-dsl-source.tar.gz',
    'packages/dsl/site/index.html', 'packages/dsl/dist/index.js',
  ];
  for (const path of excluded) await f.write(path, 'PRIVATE_REVIEW_FIXTURE\n');
  await f.write('examples/public.mjs', 'export const value = 42;\n');
  await f.run();
  const firstListing = await f.listing();
  assert.match(firstListing, /agentrun-dsl-source\/examples\/public\.mjs/);
  for (const path of excluded) assert.ok(!firstListing.includes(`agentrun-dsl-source/${path}`), path);
  assert.doesNotMatch(firstListing, /\/(?:site|dist)\//);
  const archive = await readFile(join(f.root, '.release/agentrun-dsl-source.tar.gz'));
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.publicationReady, false);
  assert.equal(receipt.archive.sha256, hash(archive));
  assert.ok(!('siteDownload' in receipt));
  assert.ok(!receipt.files.some(file => /(?:^|\/)(?:site|dist)\//.test(file.path)));
  await f.run();
  assert.deepEqual(await readFile(join(f.root, '.release/agentrun-dsl-source.tar.gz')), archive);
  assert.equal(await f.listing(), firstListing);
});

test('an audit finding blocks the source archive without exposing its content', async t => {
  const f = await fixture(t);
  const fakeSecret = ['ghp_', 'z'.repeat(36)].join('');
  await f.write('examples/unsafe.txt', fakeSecret);
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Source export blocked/);
    assert.ok(!error.stderr.includes(fakeSecret));
    return true;
  });
  await assert.rejects(access(join(f.root, '.release/agentrun-dsl-source.tar.gz')));
  const receipt = await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8');
  assert.equal(JSON.parse(receipt).status, 'failed');
  assert.ok(!receipt.includes(fakeSecret));
});

test('the removed website output flag is rejected before writing artifacts', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('--site-download'), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Usage: node scripts\/export-source\.mjs \[--inventory-only\]/);
    return true;
  });
  await assert.rejects(access(join(f.root, '.release')));
  await assert.rejects(access(join(f.root, 'site')));
  await assert.rejects(access(join(f.root, 'docs/dependencies.md')));
});

test('root and package license notices are scanned and retained byte-for-byte', async t => {
  const f = await fixture(t);
  const notices = ['LICENSE', 'NOTICE'].flatMap(name => [name, ...['dsl', 'jev', 'pi'].map(pkg => `packages/${pkg}/${name}`)]);
  for (const path of notices) await f.write(path, `Notice fixture: ${path}\n`);
  await f.run();
  for (const path of notices) {
    const archived = await exec('tar', ['-xOf', join(f.root, '.release/agentrun-dsl-source.tar.gz'), `agentrun-dsl-source/${path}`]);
    assert.equal(archived.stdout, `Notice fixture: ${path}\n`);
  }
  const secret = ['ghp_', 'z'.repeat(36)].join('');
  await f.write('packages/pi/NOTICE', secret);
  await assert.rejects(f.run(), /Source export blocked/);
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.ok(receipt.findings.some(finding => finding.path === 'packages/pi/NOTICE'));
});

test('contributor guidance at the root is archived and receipted; unlisted root files are skipped', async t => {
  const f = await fixture(t);
  const guidance = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md'];
  for (const path of guidance) await f.write(path, `Guidance fixture: ${path}\n`);
  await f.write('UNLISTED.md', 'Unlisted root fixture\n');
  await f.run();
  const receipt = JSON.parse(await readFile(join(f.root, '.release/source-export-receipt.json'), 'utf8'));
  for (const path of guidance) {
    const archived = await exec('tar', ['-xOf', join(f.root, '.release/agentrun-dsl-source.tar.gz'), `agentrun-dsl-source/${path}`]);
    assert.equal(archived.stdout, `Guidance fixture: ${path}\n`);
    assert.ok(receipt.files.some(file => file.path === path), path);
  }
  assert.doesNotMatch(await f.listing(), /UNLISTED\.md/);
  assert.ok(!receipt.files.some(file => file.path === 'UNLISTED.md'));
});

test('inventory generation works without build output and does not produce an archive', async t => {
  const f = await fixture(t);
  await f.run('--inventory-only');
  const inventory = await readFile(join(f.root, 'docs/dependencies.md'), 'utf8');
  assert.match(inventory, /@parcha\/agentrun/);
  assert.doesNotMatch(inventory, /@agentrun\//);
  await assert.rejects(access(join(f.root, '.release/agentrun-dsl-source.tar.gz')));
  await assert.rejects(access(join(f.root, '.release/source-export-receipt.json')));
});
