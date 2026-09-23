import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPublished, waitForInstallIndex } from './verify-published.mjs';
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

test('npm install index may lag the exact-version endpoint', async () => {
  let calls = 0, waited = 0;
  await waitForInstallIndex(packages[0], {
    wait: async ms => { waited += ms; },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://registry.npmjs.org/@parcha%2fagentrun-dsl');
      assert.equal(options.headers.accept, 'application/vnd.npm.install-v1+json');
      return Response.json({ versions: ++calls <= 8 ? {} : { [version]: metadata } });
    },
  });
  assert.equal(waited, 40_000);
});

test('install index cannot approve an absent version or different archive', async () => {
  let calls = 0;
  await assert.rejects(waitForInstallIndex(packages[0], {
    wait, fetchImpl: async () => { calls++; return Response.json({ versions: {} }); },
  }), /has not exposed/);
  assert.equal(calls, 61);
  await assert.rejects(waitForInstallIndex(packages[0], {
    wait: async () => assert.fail('integrity mismatch must not retry'),
    fetchImpl: async () => Response.json({ versions: { [version]: { dist: { integrity: 'wrong' } } } }),
  }), /integrity differs/);
});

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

test('published metadata and tarball can become visible after the old 25-second window', () => fixture(async (root, receipt) => {
  let metadataCalls = 0, tarballCalls = 0, waited = 0;
  const result = await verifyPublished(root, 'dsl', {
    wait: async ms => { waited += ms; },
    fetchImpl: async url => {
      if (String(url).endsWith('.tgz')) return ++tarballCalls <= 7 ? new Response(null, { status: 404 }) : new Response(bytes);
      return ++metadataCalls <= 40 ? new Response(null, { status: 404 }) : Response.json(metadata);
    },
  });
  assert.equal(result.status, 'passed');
  assert.equal(waited, 235_000);
  assert.equal((await receipt()).packages[0].status, 'matched');
}));

test('a published version that never becomes visible fails after bounded retries', () => fixture(async (root, receipt) => {
  let calls = 0, waited = 0;
  await assert.rejects(verifyPublished(root, 'dsl', {
    wait: async ms => { waited += ms; },
    fetchImpl: async () => { calls++; return new Response(null, { status: 404 }); },
  }), /HTTP 404/);
  assert.equal(calls, 61);
  assert.equal(waited, 300_000);
  assert.equal((await receipt()).status, 'failed');
}));

test('post-publish authentication and integrity failures are not propagation delays', () => fixture(async (root, receipt) => {
  for (const response of [new Response(null, { status: 403 }), Response.json({ ...metadata, dist: { ...metadata.dist, integrity: 'wrong' } })]) {
    let calls = 0;
    await assert.rejects(verifyPublished(root, 'dsl', {
      wait: async () => { assert.fail('permanent failures must not wait'); },
      fetchImpl: async () => { calls++; return response; },
    }), /HTTP 403|integrity differs/);
    assert.equal(calls, 1);
    assert.equal((await receipt()).status, 'failed');
  }
}));
