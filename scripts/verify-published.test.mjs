import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPublished } from './verify-published.mjs';
import { releasePackageNames } from './release-preflight.mjs';

const bytes = Buffer.from('verified package fixture bytes');
const version = '0.1.0-beta.1';
const packages = ['dsl', 'jev', 'pi'].map(directory => ({ directory, name: releasePackageNames[directory], version,
  sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }));
const metadata = { name: packages[0].name, version, dist: { integrity: packages[0].integrity, tarball: 'https://registry.npmjs.org/example.tgz' } };
const wait = async () => {};
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'agentrun-published-test-'));
  try {
    await mkdir(join(root, '.release'));
    await writeFile(join(root, '.release/release-plan.json'), JSON.stringify({ status: 'passed', tag: `v${version}`, registry: 'https://registry.npmjs.org/', packages }));
    await writeFile(join(root, '.release/published-dsl.json'), JSON.stringify({ status: 'passed', stale: true }));
    await fn(root, async () => JSON.parse(await readFile(join(root, '.release/published-dsl.json'), 'utf8')));
  } finally { await rm(root, { recursive: true, force: true }); }
}
const found = async url => String(url).endsWith('.tgz') ? new Response(bytes) : Response.json(metadata);

test('partial release can resume only when the existing version matches exact verified bytes', () => fixture(async (root, receipt) => {
  const result = await verifyPublished(root, 'dsl', { allowAbsent: true, fetchImpl: found, wait });
  assert.equal(result.status, 'passed');
  assert.equal(result.packages[0].sha256, packages[0].sha256);
  assert.equal((await receipt()).stale, undefined);
}));
test('only an authoritative 404 marks a version absent', () => fixture(async (root, receipt) => {
  let calls = 0;
  const result = await verifyPublished(root, 'dsl', { allowAbsent: true, fetchImpl: async () => { calls++; return new Response(null, { status: 404 }); }, wait });
  assert.equal(result.status, 'absent');
  assert.equal(calls, 1);
  assert.equal((await receipt()).status, 'absent');
}));
test('mismatched published bytes cannot skip or permit a publish', () => fixture(async (root, receipt) => {
  await assert.rejects(verifyPublished(root, 'dsl', { allowAbsent: true, wait,
    fetchImpl: async url => String(url).endsWith('.tgz') ? new Response('changed bytes') : Response.json(metadata),
  }), /differs from verified archive/);
  assert.equal((await receipt()).status, 'failed');
}));
test('transient metadata failure retries boundedly and cannot become absence', () => fixture(async (root, receipt) => {
  let calls = 0;
  await assert.rejects(verifyPublished(root, 'dsl', { allowAbsent: true, wait,
    fetchImpl: async () => { calls++; return new Response(null, { status: 503 }); },
  }), /HTTP 503/);
  assert.equal(calls, 6);
  assert.equal((await receipt()).status, 'failed');
  calls = 0;
  const recovered = await verifyPublished(root, 'dsl', { allowAbsent: true, wait,
    fetchImpl: async url => ++calls === 1 ? new Response(null, { status: 429 }) : found(url),
  });
  assert.equal(recovered.status, 'passed');
  assert.equal(calls, 3);
}));
test('permanent registry errors fail once and clear an old success receipt', () => fixture(async (root, receipt) => {
  let calls = 0;
  await assert.rejects(verifyPublished(root, 'dsl', { allowAbsent: true, wait,
    fetchImpl: async () => { calls++; return new Response(null, { status: 403 }); },
  }), /HTTP 403/);
  assert.equal(calls, 1);
  assert.equal((await receipt()).status, 'failed');
}));
test('invalid release plans also replace prior successful verification evidence', () => fixture(async (root, receipt) => {
  await writeFile(join(root, '.release/release-plan.json'), '{}');
  await assert.rejects(verifyPublished(root, 'dsl', { fetchImpl: async () => { throw new Error('must not fetch'); }, wait }));
  assert.equal((await receipt()).status, 'failed');
}));
